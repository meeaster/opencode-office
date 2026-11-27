// `office upgrade-tools`: bumps each exact pin in the office's own mise.toml, its machine-wide
// mise files (machine.toml, and machine.packages.toml, whose package comments stay as they are),
// and the runtimes' versions in office.yaml, to the newest release at
// least the office's minimum release age old (`minimum_release_age`, or a runtime's own), and
// with --commit commits the changed files alone under the office's git identity (office.yaml's `git`), else
// "office cron". mise.toml pins are looked up and installed through mise, at the age the office's
// environment gives package managers too, so an install never asks for a release they refuse; the
// runtimes' versions on GitHub (and Executor's image on its registry), and only
// recorded: `office up --upgrade` applies them. With --commit, dirty files are left for the
// user. A failed install or lookup keeps the old pin. Never pushes.
//
// In a host-mode office the packages' shared tools (`@office/tools`) are the office's own: their
// entries in machine.toml are the owner's holds, which this job leaves as they are, and their
// desired releases in office.lock are bumped as `office bump` bumps them, installing nothing.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import * as v from "valibot";

import { git } from "../git.ts";
import { entryPattern, toolPins } from "../mise-toml.ts";
import { installedTool } from "../host-tools.ts";
import { machineFile, pinnedMachineFiles } from "../../standard/mise-integration/delivery.ts";
import { type Document, isMap, isNode, isScalar, parseDocument } from "yaml";

import { type Office, OfficeError } from "../office.ts";
import { newestRelease, pinFor } from "../releases.ts";
import { atomicWrite } from "../secrets.ts";
import { type Stage, stream } from "../report/index.ts";
import { check, type LockedTool, type PinnedTool, pinnedTools } from "../schema.ts";
import { compareVersions as compareSemver, editLock, lockFile, lockSections, readLockText, wantedPins } from "../versions.ts";
import { type GatheredPackage, gatherPackages, problemLines } from "../gather.ts";
import { admitTools, heldKeys } from "../../standard/tools/admission.ts";
import { attestation, firewalledMise, spawnRun } from "../../standard/tools/host.ts";
import { selectTools } from "../../standard/tools/selection.ts";

/**
 * How old a release must be before the job takes it: a runtime's own age under `tools`, else the
 * office's `minimum_release_age`; a mise tool (`runtime` undefined) always takes the office's,
 * which is also what its package manager waits in the office's environment.
 */
export function ageFor(office: Office, runtime?: PinnedTool): string {
  return runtime === undefined ? office.tools.minimumReleaseAge : office.tools.runtimes[runtime].minimumReleaseAge;
}

/**
 * Who the job's commit is by, set for that commit only: the office's identity from office.yaml,
 * else "office cron", so a job never fails for a missing identity.
 */
function committer(office: Office) {
  return { name: office.git?.name ?? "office cron", email: office.git?.email ?? "office-cron@localhost" };
}

/** A pin the job moved. */
type Move = { tool: string; from: string; to: string };

async function mise(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const result = await stream(executable, args, { cwd, env: { ...process.env, ...env, MISE_YES: "1" }, line: () => {} });

  const errors = (result.stderr ?? "").split("\n").filter((line) => line.includes("ERROR") && !line.includes("MISE_VERBOSE"));

  // mise ends every failure with a hint to rerun verbosely; the first error line says what failed.
  return { ok: result.status === 0, out: result.stdout.trim(), stderr: result.stderr, error: errors[0]?.replace(/^.*?ERROR\s*/, "") ?? (result.stderr.trim() || `exit ${result.status}`) };
}

/** Compares dotted versions part by part, numerically where both parts are numbers. */
function compareVersions(left: string, right: string): number {
  const a = left.replace(/^v/, "").split(/[.+-]/);
  const b = right.replace(/^v/, "").split(/[.+-]/);

  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const [x = "0", y = "0"] = [a[index], b[index]];
    const order = /^\d+$/.test(x) && /^\d+$/.test(y) ? Number(x) - Number(y) : x.localeCompare(y);

    if (order !== 0) return Math.sign(order);
  }

  return 0;
}

/** A [tools] line with its version replaced, and everything else on it, a trailing comment too, as it was. */
export function withVersion(line: string, version: string): string {
  return line.replace(entryPattern, (_, indent: string, name: string, middle: string, _version: string, rest: string) => `${indent}${name}${middle}${version}${rest}`);
}

const outdatedSchema = v.record(v.string(), v.object({ requested: v.string(), current: v.nullable(v.string()), latest: v.string() }));

/** Ask about the requests in this file, including machine pins shadowed in the active config. */
async function upgradeFile(office: Office, path: string, stage: Stage, executable: string, held: ReadonlySet<string> = new Set()) {
  const dir = dirname(path);
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  const pins = toolPins(text).filter(pin => !held.has(pin.tool));
  const moves: Move[] = [];
  const failures: string[] = [];

  if (!pins.length) return { moves, failures };

  stage.detail(`${relative(office.dir, path)}: checking ${pins.length} tool pins`);
  const age = ageFor(office);
  const batch = await mise(executable, ["outdated", "--bump", "--json", "--", ...pins.map(pin => `${pin.tool}@${pin.version}`)], dir, { MISE_MINIMUM_RELEASE_AGE: age });

  if (!batch.ok) return { moves, failures: [`mise outdated: ${batch.error}`] };

  let parsed;

  try {
    parsed = check(v.safeParse(outdatedSchema, JSON.parse(batch.out)));
  } catch {
    return { moves, failures: ["mise outdated returned invalid JSON"] };
  }

  if (!parsed.ok) return { moves, failures: [`mise outdated: ${parsed.errors[0]}`] };

  // mise can return successful JSON for the other tools when one backend failed.
  for (const line of batch.stderr.split("\n")) {
    if (/could not check .* for updates/i.test(line)) failures.push(line.trim());
  }

  const outdated = parsed.value;
  const renamed = new Set(Object.entries(outdated).flatMap(([key, row]) => pins.some(pin => pin.tool === key) ? [] : [row.requested]));

  for (const pin of pins) {
    const row = outdated[pin.tool];
    let latest = row?.latest;

    // mise keys aliases like "nodejs" by canonical name ("node"). Resolve ambiguous rows
    // through the original name rather than applying another tool's version.
    if (!row && renamed.has(pin.version)) {
      const resolved = await mise(executable, ["latest", pin.tool, "--minimum-release-age", age], dir);

      if (!resolved.ok) {
        failures.push(`${pin.tool}: ${resolved.error}`);
        continue;
      }

      latest = resolved.out;
    }

    if (!latest || (row && row.requested !== pin.version) || compareVersions(latest, pin.version) <= 0) continue;

    // An installed exact request resolves to itself. For an uninstalled candidate, ask
    // mise to distinguish an exact pin from a range rather than guessing its syntax.
    if (row?.current !== pin.version) {
      if (row?.current != null) continue;

      const exact = await mise(executable, ["latest", `${pin.tool}@${pin.version}`], dir);

      if (!exact.ok || exact.out !== pin.version) continue;
    }

    stage.detail(`Installing ${pin.tool} ${latest}`);
    const installed = await mise(executable, ["install", `${pin.tool}@${latest}`], dir);

    if (!installed.ok) {
      failures.push(`${pin.tool} ${pin.version} → ${latest}: install failed: ${installed.error}`);
      continue;
    }

    lines[pin.index] = withVersion(lines[pin.index], latest);
    moves.push({ tool: pin.tool, from: pin.version, to: latest });
  }

  if (moves.length > 0) writeFileSync(path, lines.join("\n"));

  return { moves, failures };
}

/** A text edit: `value` in place of `start`–`end`. */
type Edit = { start: number; end: number; value: string };

/** The indentation of the line `at` is on, up to `at`. */
function columnOf(text: string, at: number): number {
  return at - text.lastIndexOf("\n", at - 1) - 1;
}

/** Where the line after the one `at` is on starts. */
function nextLine(text: string, at: number): number {
  const newline = text.indexOf("\n", at);

  return newline === -1 ? text.length : newline + 1;
}

/**
 * The edit that sets one runtime's version under `tools`: the
 * version's text replaced in the short form (`opencode: 2.3.2`) or in a mapping, flow or block
 * (`{ version: 2.3.2, minimum_release_age: 0d }`), in the quotes it had; a mapping without one gets
 * `version` first; a runtime the block doesn't list is added after its last entry, in the short form.
 */
function versionEdit(document: Document, text: string, tool: PinnedTool, version: string): Edit {
  const entry = document.getIn(["tools", tool], true);
  const scalar = isMap(entry) ? entry.get("version", true) : entry;

  if (isScalar(scalar) && scalar.range !== undefined && scalar.range !== null) {
    const quote = text[scalar.range[0]];

    return { start: scalar.range[0], end: scalar.range[1], value: quote === "'" || quote === '"' ? `${quote}${version}${quote}` : version };
  }

  if (isMap(entry) && entry.range !== undefined && entry.range !== null) {
    if (entry.flow === true) {
      const open = text.indexOf("{", entry.range[0]) + 1;

      return { start: open, end: open, value: ` version: ${version},` };
    }

    const first = entry.items[0]?.key;
    const start = isNode(first) ? first.range?.[0] : undefined;

    if (start !== undefined) return { start, end: start, value: `version: ${version}\n${" ".repeat(columnOf(text, start))}` };
  }

  const map = document.get("tools", true);

  if (entry === undefined && isMap(map) && map.flow !== true && map.items.length > 0) {
    const first = map.items[0].key;
    const last = map.items[map.items.length - 1];
    const indent = isNode(first) && first.range !== undefined && first.range !== null ? columnOf(text, first.range[0]) : 2;
    const end = isNode(last.value) ? last.value.range?.[1] : isNode(last.key) ? last.key.range?.[1] : undefined;

    if (end !== undefined) {
      const at = nextLine(text, Math.max(end - 1, 0));
      const newline = at > 0 && text[at - 1] !== "\n" ? "\n" : "";

      return { start: at, end: at, value: `${newline}${" ".repeat(indent)}${tool}: ${version}\n` };
    }
  }

  throw new OfficeError(`set tools.${tool} to ${version} in office.yaml by hand`);
}

/**
 * Rewrites only the text of each moved version under office.yaml's `tools`, so every comment,
 * quote and the layout stay as the user wrote them.
 */
export function setVersions(text: string, moves: { tool: PinnedTool; to: string }[]): string {
  const document = parseDocument(text, { keepSourceTokens: true });
  const edits = moves.map((move) => versionEdit(document, text, move.tool, move.to));

  return edits.sort((left, right) => right.start - left.start).reduce((result, edit) => `${result.slice(0, edit.start)}${edit.value}${result.slice(edit.end)}`, text);
}

/**
 * Bumps the runtimes' versions office.yaml pins to the highest release of each line at least its age
 * old, rewriting office.yaml (keeping its comments and layout) and office.lock. A lookup that
 * fails (GitHub's rate limit, no network) skips that tool and is reported.
 */
async function upgradeVersions(office: Office, stage: Stage): Promise<{ moves: Move[]; failures: string[]; changed: string[] }> {
  const none = { moves: [], failures: [], changed: [] };

  if (!office.tools.pinsVersions) {
    stage.note("office.yaml pins no runtime versions; using the defaults");

    return none;
  }

  let lock;

  try {
    lock = wantedPins(office);
  } catch (error) {
    return { ...none, failures: [`office.yaml's versions: ${error instanceof Error ? error.message : String(error)}`] };
  }

  const moves: (Move & { tool: PinnedTool })[] = [];
  const failures: string[] = [];
  const next = { ...lock };

  const cache = join(office.state, "release-pages");
  const now = new Date();

  const queue = pinnedTools.values();
  const errors = new Map<PinnedTool, string>();

  stage.detail("Checking runtime releases in office.yaml");
  await Promise.all(Array.from({ length: 3 }, async () => {
    for (const tool of queue) {
      try {
        const { chosen } = await newestRelease(tool, ageFor(office, tool), now, cache);

        if (chosen && compareSemver(chosen.version, next[tool].version) > 0) {
          next[tool] = await pinFor(tool, chosen.version, chosen.release);
        }
      } catch (error) {
        errors.set(tool, `${tool}: skipped, its release lookup failed (${error instanceof Error ? error.message : String(error)})`);
      }
    }
  }));

  for (const tool of pinnedTools) {
    const error = errors.get(tool);

    if (error !== undefined) failures.push(error);
    else if (next[tool].version !== lock[tool].version) moves.push({ tool, from: lock[tool].version, to: next[tool].version });
  }

  if (moves.length === 0) return { ...none, failures };

  const path = join(office.dir, "office.yaml");

  try {
    // office.yaml is read and written under the lease office.lock's writers hold, so a package
    // publication meanwhile isn't put back.
    editLock(office.dir, (sections) => {
      atomicWrite(path, setVersions(readFileSync(path, "utf8"), moves), statSync(path).mode & 0o777);
      sections.runtime = next;
    }, { replacing: "runtime" });
  } catch (error) {
    return { ...none, failures: [`office.yaml's versions: ${error instanceof Error ? error.message : String(error)}`] };
  }

  return { moves, failures, changed: ["office.yaml", lockFile] };
}

/**
 * Bumps the desired releases of the packages' shared tools in office.lock, as office bump does;
 * installs nothing. `notes` are what the selection said besides its failures, mise's warnings
 * included, whether or not it succeeded.
 */
function bumpShared(office: Office, packages: readonly GatheredPackage[]) {
  const read = () => {
    const tools = lockSections(readLockText(office.dir)).tools;

    return tools.ok ? tools.value : new Map<string, LockedTool>();
  };

  if (admitTools(office, packages).managed.length === 0) return { moves: [], failures: [], notes: [] };
  const before = read();
  const firewalled = firewalledMise(office);

  if (!firewalled.ok) return { moves: [], failures: [`the packages' shared tools aren't bumped: ${firewalled.reason}`], notes: [] };
  const { tools } = firewalled;
  const selection = selectTools(office, packages, { ...tools.inputs, run: spawnRun(), env: process.env });
  const notes = [attestation(tools), ...selection.lines.filter(line => !line.startsWith("FAILED"))];

  if (!selection.ok) return { moves: [], failures: selection.lines.filter(line => line.startsWith("FAILED")).map(line => line.slice("FAILED ".length)), notes };

  const moves = [...read()].flatMap(([tool, { version }]) => {
    const from = before.get(tool)?.version;

    return from !== version ? [{ tool, from: from ?? "none", to: version }] : [];
  });

  return { moves, failures: [], notes };
}

export async function upgradeTools(office: Office, stage: Stage, { commit }: { commit: boolean }): Promise<void> {
  // The office's own files only: never one inside a working repository or under references/. The
  // versions of the packages' tools are the office's too, with the same ages.
  const officeToml = join(office.dir, "mise.toml");
  const files = [...(existsSync(officeToml) ? [officeToml] : []), ...pinnedMachineFiles(office)];
  const executable = installedTool("mise")?.path ?? "mise";

  const changed: string[] = [];
  const report: (Move & { file: string })[] = [];
  const failures: string[] = [];
  let skipped = false;
  const shared = office.opencode.mode === "host" ? await gatherPackages(office, { machine: true }) : undefined;
  // The owner's holds of shared tools in machine.toml, which only the owner moves.
  const held = shared?.complete ? heldKeys(office, shared.packages) : new Set<string>();

  if (shared !== undefined && !shared.complete) failures.push(`the packages didn't load (${problemLines(shared.problems).join("; ") || [...shared.unread].join(", ")}), so their shared tools aren't bumped and ${machineFile} is left as it is`);

  function skipDirty(paths: string[]): boolean {
    if (!commit || git(["status", "--porcelain", "--", ...paths], office.dir) === "") return false;

    stage.warn(`Skipped ${paths.join(" and ")}: uncommitted changes`);
    skipped = true;

    return true;
  }

  for (const path of files) {
    const name = relative(office.dir, path);

    const project = dirname(path);
    const lock = join(project, "mise.lock");
    const paths = path === officeToml ? [name, relative(office.dir, lock)] : [name];

    if (skipDirty(paths)) continue;

    if (shared !== undefined && !shared.complete && name === machineFile) continue;

    const before = path === officeToml && existsSync(lock) ? { pins: readFileSync(path), lock: readFileSync(lock) } : undefined;
    const result = await upgradeFile(office, path, stage, executable, name === machineFile ? held : undefined);

    for (const failure of result.failures) failures.push(`${name}: ${failure}`);

    if (result.moves.length === 0) continue;

    // The lock file, when the office uses one, follows the pins of the mise.toml beside it. The
    // machine-wide files apply through the global conf.d, which no lock in the office covers.
    if (before) {
      const locked = await mise(executable, ["lock"], project);

      if (!locked.ok) {
        writeFileSync(path, before.pins);
        writeFileSync(lock, before.lock);
        failures.push(`${name}: mise lock failed: ${locked.error}`);
        continue;
      }

      changed.push(relative(office.dir, lock));
    }

    changed.push(name);
    report.push(...result.moves.map((move) => ({ ...move, file: name })));
  }

  const versions = office.tools.pinsVersions && skipDirty(["office.yaml", lockFile])
    ? { changed: [], moves: [], failures: [] }
    : await upgradeVersions(office, stage);

  for (const failure of versions.failures) failures.push(failure);

  changed.push(...versions.changed);
  report.push(...versions.moves.map((move) => ({ ...move, file: "office.yaml" })));

  // office.lock the runtime pins just changed was clean before them: this job's own change, not the user's.
  if (shared?.complete && (changed.includes(lockFile) || !skipDirty([lockFile]))) {
    const desired = bumpShared(office, shared.packages);

    // mise's warnings, such as a release its age left out or a backend without dates, reach the job's output.
    for (const note of desired.notes) {
      if (/^mise\s+WARN\b/.test(note)) stage.warn(note);
      else stage.note(note);
    }

    failures.push(...desired.failures);
    report.push(...desired.moves.map((move) => ({ ...move, file: lockFile })));

    if (desired.moves.length > 0 && !changed.includes(lockFile)) changed.push(lockFile);
  }

  if (commit && report.length > 0) {
    const where = (move: { file: string }) => (move.file === "mise.toml" || move.file === "office.yaml" ? "" : ` in ${move.file.endsWith("/mise.toml") ? dirname(move.file) : move.file}`);
    const subject = `chore: bump ${report.map((move) => `${move.tool} ${move.from} → ${move.to}${where(move)}`).join(", ")}`;
    const body = report.map((move) => `- ${move.file}: ${move.tool} ${move.from} → ${move.to}`).join("\n");

    const { name, email } = committer(office);

    git(["-c", `user.name=${name}`, "-c", `user.email=${email}`, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", subject, "-m", body, "--", ...changed], office.dir);
    stage.note(subject);
  } else {
    for (const move of report) stage.note(`${move.file}: ${move.tool} ${move.from} → ${move.to}`);
  }

  for (const failure of failures) stage.error(failure);

  if (report.length === 0 && failures.length === 0) {
    stage.done(skipped ? "No pins updated; some files were skipped" : "No updates needed");

    return;
  }

  if (failures.length > 0) {
    stage.fail(`${failures.length} ${failures.length === 1 ? "upgrade failed" : "upgrades failed"}`);
    throw new OfficeError("Some tool pins could not be upgraded");
  }

  stage.done(`${report.length} ${report.length === 1 ? "pin" : "pins"} updated${commit ? " and committed" : "; changes left uncommitted"}`);
}
