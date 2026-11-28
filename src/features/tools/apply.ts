// Bringing the office's shared tools on this machine to what is desired, without ever switching
// a tool that isn't ready. Desired is office.lock's release for a mise-managed tool and the
// provider's version setting for a provided one; applied is the machine's record
// (src/features/tools/applied.ts).
//
// - A tool with nothing applied, or applied without an executable a consumer now names, is
//   installed. A tool applied at another version is left as it is unless the run upgrades: it is
//   then pending, and the run says so. A tool no package requires any more leaves PATH; the highest
//   version ever applied of every tool stays recorded, so it is never installed below that again.
// - Before anything is staged, the run refuses when a desired release is missing from office.lock,
//   below a consumer's minimum, not the owner's hold, or older than
//   the highest version applied; when a provided release isn't on its provider's list, has no
//   publication time that parses and isn't in the future, or is younger than the strictest age of
//   its provider and consumers; and when its destination holds something office didn't stage there.
//   That age applies to a provider's explicit version too: unlike mise's exact requests, a
//   provider's list is the only publication metadata there is. `checkTools` makes the same checks
//   before up starts any service, leaving to up's selection what it will record first.
// - An applied tool that stays active must still be what activation measured
//   (`@office/tools/applied`): a missing or changed executable is refused by name, with the
//   identity activation recorded; office neither replaces it nor lets another copy stand in.
// - Every change is staged and checked first; when any staging fails, nothing is activated. Then
//   every change is activated at once, in one switch of the applied generation.
import * as v from "valibot";

import { type Provision, tools } from "../../../packages/tools/handles.ts";
import type { Gathered, GatheredPackage } from "../../gather.ts";
import type { Office } from "../../office.ts";
import { check } from "../../schema.ts";
import { ageHours } from "./sfw.ts";
import { lockFile, lockSections, readLockText } from "../../versions.ts";
import { machineFile } from "../mise-integration/delivery.ts";
import { compareToolVersions } from "../tooling/requirements.ts";
import { admitTools, consumersThat, type Demand } from "./admission.ts";
import { driftMessage, driftOf } from "../../../packages/tools/applied.ts";
import { activate, type Applied, type AppliedTool, readApplied, toolsState } from "./applied.ts";
import { officeRegistry, type ToolRegistry } from "./registry.ts";
import { effectiveAge, packageAges } from "./selection.ts";
import { providedDestination, type Staged, stageManaged, stageProvided, type StagingInputs } from "./staging.ts";

/** What checking the shared tools needs: whether the run upgrades, the providers' release lists, mise's registry and the time now. */
export type CheckInputs = { upgrade: boolean; releases: ReleaseReader; registry?: () => ToolRegistry; now?: number };

/** A provider's release list, read through its live handle, as office checks it: a release's publication time is checked for the version installed. */
export type ReleaseReader = (provision: Provision) => Promise<readonly ListedRelease[]>;

/** What applying needs: staging's inputs and checking's. */
export type ApplyInputs = StagingInputs & CheckInputs;

/** What applying said, one line each; with `ok` false, nothing was activated. */
export type Application = { ok: boolean; lines: string[] };

const releaseList = v.array(v.object({ version: v.string(), published: v.optional(v.string()), digests: v.record(v.string(), v.pipe(v.string(), v.regex(/^sha256:[0-9a-f]{64}$/, "must be sha256:<hex>"))) }));

/** A release as a provider's list gives it, before its publication time is checked. */
type ListedRelease = v.InferOutput<typeof releaseList>[number];

/**
 * Reads providers' release lists through the providers registry the tools package registered in
 * this gathering: `tools.provide` kept each list there, since a registry entry holds only its token.
 */
export function liveReleases(gathered: Pick<Gathered, "registries">): ReleaseReader {
  return async provision => {
    const handle = v.safeParse(v.object({ releases: v.function() }), gathered.registries.get(tools.providers.id));
    const list = v.safeParse(v.function(), handle.success ? handle.output.releases(provision.releases) : undefined);

    if (!list.success) throw new Error(`tool ${provision.name}: its provider's release list isn't in this process; declare it with tools.provide`);
    const read = check(v.safeParse(releaseList, await list.output()));

    if (!read.ok) throw new Error(`tool ${provision.name}: its provider's release list isn't valid: ${read.errors.join("; ")}`);

    return read.value;
  };
}

/** A tool this run brings to its desired release: the names its consumers require it by, its executables, what refuses it before anything stages, and how it stages. */
type Target = { tool: string; version: string; names: string[]; bin: readonly string[]; check: () => Promise<string | undefined>; stage: (staging: StagingInputs) => Promise<Staged> };

/** What a run would do before staging: lines to say, refusals, what it stages, and the applied tools it keeps, as consumers now name them. */
type Plan = { lines: string[]; refused: string[]; targets: Target[]; kept: Map<string, AppliedTool>; applied: Applied };

// A publication time with a date, a time and a zone, as ISO 8601 writes one.
const isoTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

// How far ahead of this machine's clock a publication time may be before it isn't believed.
const clockSkew = 5 * 60_000;

/** Why the provider's `version` of `tool` can't be installed at `age` at `now`, or undefined when it can. */
function releaseRefusal(tool: string, version: string, releases: readonly { version: string; published?: string }[], age: string, now: number): string | undefined {
  const release = releases.find(item => item.version === version);

  if (release === undefined) return `tool ${tool} ${version} isn't among the releases its provider lists`;

  if (release.published === undefined) return `tool ${tool} ${version}: its provider's release list states no publication time, so its age can't be checked`;
  const published = isoTime.test(release.published) ? Date.parse(release.published) : Number.NaN;

  if (!Number.isFinite(published)) return `tool ${tool} ${version}: its provider's publication time ${JSON.stringify(release.published)} isn't an ISO 8601 time with a zone`;

  if (published > now + clockSkew) return `tool ${tool} ${version}: its provider's publication time ${release.published} is in the future, so it isn't trusted`;
  const eligible = published + ageHours(age) * 3_600_000;

  if (eligible > now) return `tool ${tool} ${version} was published ${release.published}, younger than the ${age} its packages wait; it is eligible from ${new Date(eligible).toISOString()}`;

  return undefined;
}

/** The applied executables of `tool` that `bin` names, and only those. */
function exposing(tool: AppliedTool, names: readonly string[], bin: readonly string[]): AppliedTool {
  return { ...tool, names: [...names], bin: Object.fromEntries(Object.entries(tool.bin).filter(([name]) => bin.includes(name))) };
}

/** The names a demand's consumers require it by, sorted and once each. */
function namesOf(demand: Demand | undefined, own: readonly string[] = []): string[] {
  return [...new Set([...own, ...(demand?.consumers.map(consumer => consumer.name) ?? [])])].toSorted();
}

/**
 * What applying would do, checked without staging anything. With `selecting`, a mise-managed tool
 * whose office.lock release no longer serves it is left to the selection up runs first.
 */
async function planTools(office: Office, packages: readonly GatheredPackage[], inputs: CheckInputs, selecting: boolean): Promise<Plan | Application> {
  const admission = admitTools(office, packages, inputs.registry ?? (() => officeRegistry(office)));

  if (admission.problems.length) return { ok: false, lines: [...admission.problems.map(problem => `FAILED ${problem.message}`), "FAILED the packages' tools don't pass admission; no tool was installed or switched"] };

  const locked = lockSections(readLockText(office.dir)).tools;

  if (!locked.ok) return { ok: false, lines: [`FAILED ${locked.error.message}`] };
  const applied = readApplied(office);
  const ages = packageAges(office);
  const plan: Plan = { lines: [], refused: [], targets: [], kept: new Map(), applied };

  const consider = (target: Target) => {
    const { tool, version, names, bin } = target;
    const active = applied.tools.get(tool);
    const highest = applied.highest.get(tool);

    const keep = (kept: AppliedTool) => {
      for (const [name, executable] of Object.entries(kept.bin)) {
        const drift = driftOf(toolsState(office), name, executable);

        if (drift !== undefined) plan.refused.push(driftMessage(tool, kept.version, drift, toolsState(office)));
      }

      plan.kept.set(tool, kept);
    };

    if (active?.version === version && bin.every(name => name in active.bin)) {
      keep(exposing(active, names, bin));

      return;
    }

    if (active !== undefined && active.version !== version && !inputs.upgrade) {
      plan.lines.push(`tool ${tool} ${active.version} stays active; ${version} is desired: office up --upgrade switches to it`);
      keep(exposing(active, names, bin));

      return;
    }

    if (highest !== undefined && (compareToolVersions(version, highest) ?? -1) < 0) {
      plan.refused.push(`refused tool ${tool} ${version}: it is older than ${highest}, the highest version applied here, and a tool is never downgraded`);

      return;
    }

    plan.targets.push(target);
  };

  for (const item of packages) {
    for (const provision of item.claims.provided) {
      const version = item.settings[provision.versionSetting];

      // Admission accepted only an exact version here.
      if (typeof version !== "string") continue;
      const demand = admission.demands.get(provision.name);
      // The provider's own entry and every consumer's: the strictest age applies.
      const owners = [{ package: item.entry.name, name: provision.name, minimum: version }, ...(demand?.consumers ?? [])];
      const age = effectiveAge(office.tools.minimumReleaseAge, owners, ages);
      let releases: readonly ListedRelease[] = [];
      const release = () => ({ tool: provision.name, version, bin: provision.bin, folder: item.dir, task: provision.install.task, releases });

      consider({
        tool: provision.name, version, names: namesOf(demand, [provision.name]), bin: provision.bin,
        stage: async staging => stageProvided(office, release(), staging),
        check: async () => {
          try {
            releases = await inputs.releases(provision);
          } catch (error) {
            return error instanceof Error ? error.message : String(error);
          }

          return releaseRefusal(provision.name, version, releases, age, inputs.now ?? Date.now()) ?? providedDestination(office, release());
        },
      });
    }
  }

  for (const demand of admission.managed.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const entry = locked.value.get(demand.name);
    const hold = admission.holds.get(demand.name);

    const unmet = entry === undefined ? `${lockFile} has no release of tool ${demand.name}, which ${consumersThat(demand, "requires", "require")}; run office bump`
      : (compareToolVersions(entry.version, demand.floor) ?? -1) < 0 ? `${lockFile} records tool ${demand.name} ${entry.version}, below the ${demand.floor} ${consumersThat(demand, "needs", "need")}; run office bump`
        : hold !== undefined && hold.version !== entry.version ? `${machineFile} holds tool ${hold.key} at ${hold.version}, but ${lockFile} records ${entry.version}; run office bump` : undefined;

    if (unmet !== undefined || entry === undefined) {
      if (!selecting && unmet !== undefined) plan.refused.push(unmet);

      continue;
    }

    consider({
      tool: demand.name, version: entry.version, names: namesOf(demand), bin: demand.bin,
      check: async () => undefined,
      stage: async staging => stageManaged(office, { tool: demand.name, version: entry.version, bin: demand.bin, age: effectiveAge(office.tools.minimumReleaseAge, demand.consumers, ages) }, staging),
    });
  }

  for (const target of plan.targets) {
    const refusal = await target.check();

    if (refusal !== undefined) plan.refused.push(refusal);
  }

  return plan;
}

/**
 * Up's checks of the shared tools before it starts any service: everything applying refuses that
 * this machine's files and the providers' lists already show. Installs, switches and asks mise nothing.
 */
export async function checkTools(office: Office, packages: readonly GatheredPackage[], inputs: CheckInputs): Promise<Application> {
  const plan = await planTools(office, packages, inputs, true);

  if ("ok" in plan) return plan;

  return plan.refused.length ? { ok: false, lines: [...plan.refused.map(line => `FAILED ${line}`), "FAILED no tool was installed or switched"] } : { ok: true, lines: [] };
}

/** Whether up would stage anything for `packages`, by the same checks; a refusal counts, since up would report it. Asks mise nothing. */
export async function stagingNeeded(office: Office, packages: readonly GatheredPackage[], inputs: CheckInputs): Promise<boolean> {
  const plan = await planTools(office, packages, inputs, true);

  return "ok" in plan || plan.refused.length > 0 || plan.targets.length > 0;
}

function recordText(applied: Applied): string {
  const sorted = <T>(map: ReadonlyMap<string, T>) => Object.fromEntries([...map].toSorted(([a], [b]) => a.localeCompare(b)));

  return JSON.stringify({ tools: sorted(applied.tools), highest: sorted(applied.highest) });
}

/** Applies the desired shared tools of `packages`; see the module comment. */
export async function applyTools(office: Office, packages: readonly GatheredPackage[], inputs: ApplyInputs): Promise<Application> {
  const plan = await planTools(office, packages, inputs, false);

  if ("ok" in plan) return plan;
  const { lines, refused, targets, kept, applied } = plan;

  if (refused.length) return { ok: false, lines: [...lines, ...refused.map(line => `FAILED ${line}`), "FAILED no tool was installed or switched"] };

  const staged = new Map<string, Staged & { names: string[] }>();

  for (const target of targets) {
    try {
      staged.set(target.tool, { ...await target.stage(inputs), names: target.names });
    } catch (error) {
      if (!(error instanceof Error)) throw error;

      return { ok: false, lines: [...lines, `FAILED ${error.message}`, staged.size === 0 ? "FAILED nothing was staged or switched" : `FAILED staged ${[...staged.keys()].join(", ")}, but no tool was switched`] };
    }
  }

  const next: Applied = { tools: new Map(kept), highest: new Map(applied.highest) };

  for (const [tool, { version, identity, bin, names }] of staged) {
    const before = applied.tools.get(tool);
    const highest = applied.highest.get(tool);

    next.tools.set(tool, { version, identity, names, bin });

    if (highest === undefined || (compareToolVersions(version, highest) ?? 0) > 0) next.highest.set(tool, version);
    lines.push(`${before === undefined ? "installed" : before.version === version ? "added executables of" : "switched"} tool ${tool} ${version}${before === undefined || before.version === version ? "" : ` (was ${before.version})`}: ${identity}`);
  }

  for (const tool of applied.tools.keys()) {
    if (!next.tools.has(tool)) lines.push(`tool ${tool} left PATH: no package requires it here any more`);
  }

  if (recordText(next) !== recordText(applied)) activate(office, next);

  return { ok: true, lines };
}
