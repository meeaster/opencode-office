// Selecting the desired release of each mise-managed tool the packages require, without installing.
//
// The office's `minimum_release_age` goes under [settings], and each tool whose consumers' strictest
// age differs gets its own `minimum_release_age` on its [tools] line, keyed by the backend-qualified
// name admission grouped it under. A consumer's age is its package entry's `minimum_release_age`
// in office.yaml, else the office's. The planning mise.toml is in a throwaway folder with mise's
// config, data, state and cache folders beside it and no MISE_ variable of the caller's, so no
// global or project setting, tool or install of the machine reaches the plan. One
// `mise upgrade --bump --dry-run` there, with no tool arguments and no age flag (a flag would
// replace the per-tool ages), prints `Would install <tool>@<exact>` for every planned tool, since
// nothing is installed in that data folder. mise decides each release's age, including when its
// backend has no date; its warnings are passed on.
//
// The owner's exact pin in machine.toml (admission accepts only one exact version) is that tool's
// hold: it stays out of the batch, since --bump rewrites exact pins too, and is recorded once mise
// lists that version among the tool's releases, at no age limit, as exact requests aren't
// age-filtered. Each selection must meet every applicable minimum; a selection never lowers what
// office.lock already records. office.lock records the exact version alone: mise verifies the
// artifact natively when up installs it (standard/tools/staging.ts). All tools are recorded in one
// edit of office.lock, or none. Nothing here installs a tool or changes the
// active mise config; installed paths are machine state (standard/tools/applied.ts).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { GatheredPackage } from "../../src/gather.ts";
import { miseShims } from "../../src/host-env.ts";
import type { Office } from "../../src/office.ts";
import type { LockedTool, ToolLock } from "../../src/schema.ts";
import { ageHours } from "../../src/sfw.ts";
import { editLock, lockFile, lockSections, readLockText } from "../../src/versions.ts";
import { machineFile } from "../mise-integration/delivery.ts";
import { compareToolVersions } from "../tooling/requirements.ts";
import { type Admission, admitTools, type Consumer, consumersOf, consumersThat, type Demand } from "./admission.ts";
import { officeRegistry, type ToolRegistry } from "./registry.ts";

/** The variables a planning run of mise gets. */
export type PlanningEnvironment = Readonly<Record<string, string>>;

/** How mise runs: its whole argument list, folder and environment; returns its exit status and output. */
export type Run = (argv: readonly string[], options: { cwd: string; env: PlanningEnvironment }) => { status: number; stdout: string; stderr: string };

/**
 * What selecting needs: the mise command (the office's Socket Firewall, then the operation's one
 * mise, at the office's pin, by absolute path), how to run it, the environment to start from, mise's
 * registry, and the folders of the runtimes an isolated run of mise needs, such as node and pnpm
 * for npm tools, as the host's own toolchain resolves them (standard/tools/host.ts).
 */
export type SelectionInputs = { mise: readonly string[]; run: Run; env: Readonly<Record<string, string | undefined>>; registry?: () => ToolRegistry; runtimes?: readonly string[] };

/** What a selection said, one line each; with `ok` false, office.lock is left as it was. */
export type Selection = { ok: boolean; lines: string[] };

/** A tool the batch asks mise for, with its effective age. */
type Planned = { demand: Demand; age: string };

/** The consumers' strictest effective age: a package's own age in office.yaml replaces the office's for that package only. */
export function effectiveAge(blanket: string, consumers: readonly Consumer[], overrides: ReadonlyMap<string, string>): string {
  const ages = consumers.map(consumer => overrides.get(consumer.package) ?? blanket);

  return ages.reduce((strictest, age) => (ageHours(age) > ageHours(strictest) ? age : strictest));
}

/** Each package entry's own release age in office.yaml. */
export function packageAges(office: Pick<Office, "packages">): Map<string, string> {
  return new Map(office.packages.flatMap(entry => entry.minimumReleaseAge === undefined ? [] : [[entry.name, entry.minimumReleaseAge]]));
}

/** The planning mise.toml: the blanket age, then every planned tool at `latest`, with its own age where that differs. */
export function planningToml(blanket: string, planned: readonly Planned[]): string {
  const tools = planned.map(({ demand, age }) => ageHours(age) === ageHours(blanket)
    ? `${JSON.stringify(demand.name)} = "latest"`
    : `${JSON.stringify(demand.name)} = { version = "latest", minimum_release_age = ${JSON.stringify(age)} }`);

  return ["[settings]", `minimum_release_age = ${JSON.stringify(blanket)}`, "", "[tools]", ...tools, ""].join("\n");
}

/** The exact release of each tool a dry run would install, by the name the planning file gives it; a tool named twice is an error. */
export function plannedInstalls(stdout: string): Map<string, string> {
  const selected = new Map<string, string>();

  for (const line of stdout.split("\n")) {
    const match = /^Would install (\S+)@([^@\s]+)$/.exec(line.trim());

    if (match === null) continue;

    if (selected.has(match[1])) throw new Error(`mise planned ${match[1]} twice`);
    selected.set(match[1], match[2]);
  }

  return selected;
}

/**
 * The environment of an isolated mise run: the caller's without any MISE_ variable, every mise
 * folder inside `root`, and only `trusted` trusted. A run that installs passes its own data folder
 * after this. The caller's mise shims leave PATH too: a shim resolves its tool through the config
 * this run hides. The `runtimes` folders come first instead, so a program the run needs, such as
 * npm tools' node and pnpm, is the one the host's toolchain resolved before isolating.
 */
export function isolatedEnvironment(base: SelectionInputs["env"], root: string, trusted: string, runtimes: readonly string[] = []) {
  const env: Record<string, string> = {};
  const shims = miseShims();

  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !key.startsWith("MISE_")) env[key] = value;
  }

  const path = [...runtimes, ...(env.PATH ?? "").split(":").filter(dir => dir !== "" && dir !== shims && !runtimes.includes(dir))].join(":");

  return {
    ...env,
    PATH: path,
    MISE_CONFIG_DIR: join(root, "config"),
    MISE_GLOBAL_CONFIG_FILE: join(root, "config/config.toml"),
    MISE_SYSTEM_CONFIG_DIR: join(root, "system"),
    MISE_DATA_DIR: join(root, "data"),
    MISE_STATE_DIR: join(root, "state"),
    MISE_CACHE_DIR: join(root, "cache"),
    MISE_CEILING_PATHS: root,
    MISE_TRUSTED_CONFIG_PATHS: trusted,
    MISE_AUTO_INSTALL: "0",
  };
}

/** The mise output lines worth passing on: its warnings, such as a release its age left out or a missing date. */
function diagnostics(stderr: string): string[] {
  return stderr.split("\n").map(line => line.trim()).filter(line => /^mise\s+WARN\b/.test(line));
}

/** Whether office.lock's `locked` version no longer serves `demand`: missing, below its floor, or not the owner's `held` version. */
function unmetBy(locked: string | undefined, demand: Demand, held: string | undefined): boolean {
  if (locked === undefined) return true;

  return held === undefined ? (compareToolVersions(locked, demand.floor) ?? -1) < 0 : held !== locked;
}

/** The mise-managed demands whose release in `locked` (if any) no longer serves them. */
function unmetDemands(admission: Admission, locked: ToolLock): Demand[] {
  return admission.managed.filter(demand => unmetBy(locked.get(demand.name)?.version, demand, admission.holds.get(demand.name)?.version));
}

/** The mise-managed tools whose release office.lock records (if any) no longer serves them, each with that release; empty while admission finds a problem. */
export function unmetTools(office: Office, packages: readonly GatheredPackage[], registry: () => ToolRegistry = () => officeRegistry(office)): { name: string; recorded?: string }[] {
  const admission = admitTools(office, packages, registry);
  const read = lockSections(readLockText(office.dir)).tools;

  if (admission.problems.length || !read.ok) return [];

  return unmetDemands(admission, read.value).map(demand => {
    const recorded = read.value.get(demand.name)?.version;

    return recorded === undefined ? { name: demand.name } : { name: demand.name, recorded };
  });
}

/** What a step of a selection found, or the failure that stops it. */
type Step<T> = { ok: true; value: T } | { ok: false; failure: string };

/** How a selection runs mise: the command, how to run it, and the lines mise's warnings go to. */
type MiseRuns = Pick<SelectionInputs, "mise" | "run"> & { lines: string[] };

function runMise({ mise, run, lines }: MiseRuns, argv: readonly string[], cwd: string, env: PlanningEnvironment) {
  const result = run([...mise, ...argv], { cwd, env });

  lines.push(...diagnostics(result.stderr));

  return result;
}

/** Each held tool's version, once mise lists it among the tool's releases at no age limit, as exact requests aren't age-filtered. */
function heldReleases(demands: readonly Demand[], holds: Admission["holds"], runs: MiseRuns, cwd: string, env: PlanningEnvironment): Step<Map<string, string>> {
  const selected = new Map<string, string>();

  for (const demand of demands) {
    const hold = holds.get(demand.name);

    if (hold === undefined) continue;
    const listed = runMise(runs, ["ls-remote", demand.name, hold.version], cwd, { ...env, MISE_MINIMUM_RELEASE_AGE: "0d" });

    if (listed.status !== 0) return { ok: false, failure: `mise couldn't list the releases of tool ${demand.name} to check ${machineFile}'s ${hold.key} = ${hold.version} (exit ${listed.status}): ${listed.stderr.trim()}` };

    if (!listed.stdout.split("\n").some(line => line.trim() === hold.version)) return { ok: false, failure: `${machineFile} holds tool ${hold.key} at ${hold.version}, which isn't one of the releases mise lists for ${demand.name}; ${consumersThat(demand, "requires", "require")} it: pin one exact release there, or remove the entry` };
    selected.set(demand.name, hold.version);
  }

  return { ok: true, value: selected };
}

/** Each planned tool's release from one `mise upgrade --bump --dry-run` of the planning mise.toml in `dir`, each at or above its floor. */
function plannedReleases(planned: readonly Planned[], blanket: string, runs: MiseRuns, dir: string, env: PlanningEnvironment): Step<Map<string, string>> {
  const selected = new Map<string, string>();

  if (planned.length === 0) return { ok: true, value: selected };
  writeFileSync(join(dir, "mise.toml"), planningToml(blanket, planned));
  const result = runMise(runs, ["upgrade", "--bump", "--dry-run"], dir, env);

  if (result.status !== 0) return { ok: false, failure: `mise couldn't plan the tools' releases (exit ${result.status}): ${result.stderr.trim()}` };

  let installs: Map<string, string>;

  try {
    installs = plannedInstalls(result.stdout);
  } catch (error) {
    return { ok: false, failure: error instanceof Error ? error.message : String(error) };
  }

  for (const { demand } of planned) {
    // mise prints a tool of its core backend by its short name: core:bun as bun.
    const version = installs.get(demand.name) ?? (demand.name.startsWith("core:") ? installs.get(demand.name.slice("core:".length)) : undefined);

    if (version === undefined) return { ok: false, failure: `mise selected no release of tool ${demand.name}, which ${consumersThat(demand, "requires", "require")}` };

    const order = compareToolVersions(version, demand.floor);

    if (order === undefined || order < 0) return { ok: false, failure: `mise selected tool ${demand.name} ${version}, ${order === undefined ? "which office can't order against" : "below"} the ${demand.floor} ${consumersThat(demand, "needs", "need")}` };
    selected.set(demand.name, version);
  }

  return { ok: true, value: selected };
}

/** One tool's selection: the version to record, and the older one mise selected when office.lock's is kept instead. */
type Chosen = { demand: Demand; version: string; kept?: string };

/**
 * Selects one exact desired release for each mise-managed tool the packages require and records them
 * in office.lock's `tools:` section, keyed by backend. Refuses, recording nothing, while admission
 * finds a problem. With `unmet`, it selects only the tools whose recorded release no longer serves
 * them (none, one below a raised minimum, or not the owner's hold), asks mise nothing when there
 * are none, and leaves every other entry as it is.
 */
export function selectTools(office: Office, packages: readonly GatheredPackage[], { mise, run, env, registry = () => officeRegistry(office), runtimes = [], unmet = false }: SelectionInputs & { unmet?: boolean }): Selection {
  const lines: string[] = [];
  const failed = (line: string): Selection => ({ ok: false, lines: [...lines, `FAILED ${line}; ${lockFile} is left as it was`] });
  const admission = admitTools(office, packages, registry);

  if (admission.problems.length) return { ok: false, lines: [...admission.problems.map(problem => `FAILED ${problem.message}`), `FAILED the packages' tools don't pass admission; ${lockFile} is left as it was`] };

  const read = lockSections(readLockText(office.dir)).tools;

  if (!read.ok) return failed(read.error.message);
  const demands = (unmet ? unmetDemands(admission, read.value) : admission.managed).toSorted((a, b) => a.name.localeCompare(b.name));

  if (demands.length === 0 && unmet) return { ok: true, lines };
  const blanket = office.tools.minimumReleaseAge;
  const overrides = packageAges(office);
  const planned: Planned[] = demands.flatMap(demand => admission.holds.has(demand.name) ? [] : [{ demand, age: effectiveAge(blanket, demand.consumers, overrides) }]);
  const runs: MiseRuns = { mise, run, lines };
  const root = mkdtempSync(join(tmpdir(), "office-tool-plan-"));
  const plan = join(root, "plan");
  const releases = join(root, "releases");

  try {
    mkdirSync(plan);
    mkdirSync(releases);
    const environment = isolatedEnvironment(env, root, plan, runtimes);
    const held = heldReleases(demands, admission.holds, runs, releases, environment);

    if (!held.ok) return failed(held.failure);
    const batch = plannedReleases(planned, blanket, runs, plan, environment);

    if (!batch.ok) return failed(batch.failure);

    // A selection never lowers what office.lock records, unless the owner holds the tool.
    const chosen = demands.map((demand): Chosen => {
      const before = read.value.get(demand.name);
      const version = held.value.get(demand.name) ?? batch.value.get(demand.name) ?? demand.floor;

      if (!admission.holds.has(demand.name) && before !== undefined && (compareToolVersions(before.version, version) ?? 0) > 0) return { demand, version: before.version, kept: version };

      return { demand, version };
    });

    return editLock(office.dir, sections => {
      const tools = new Map<string, LockedTool>(unmet ? sections.tools : []);

      for (const { demand, version, kept } of chosen) {
        const before = sections.tools.get(demand.name);
        const hold = admission.holds.get(demand.name);

        if (hold !== undefined) lines.push(`${machineFile} holds tool ${hold.key} at ${hold.version}`);
        else if (kept !== undefined) lines.push(`kept tool ${demand.name} at ${version} in ${lockFile}: mise selected the older ${kept}`);

        if (before?.version !== version) lines.push(`${lockFile}: selected tool ${demand.name} ${version}${before === undefined ? "" : ` (was ${before.version})`} for ${consumersOf(demand)}`);
        tools.set(demand.name, { version });
      }

      for (const backend of sections.tools.keys()) {
        if (!unmet && !tools.has(backend)) lines.push(`${lockFile}: removed tool ${backend}, which no package requires here any more`);
      }

      sections.tools = tools;

      return { ok: true, lines };
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
