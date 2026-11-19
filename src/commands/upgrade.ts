// `office upgrade-tools`: bumps each exact pin in the office's own mise.toml files (the root's and
// each desk's), its machine-wide mise files (machine.toml, and machine.packages.toml, whose package
// comments stay as they are), and the runtimes' versions in office.yaml, to the newest release at
// least the office's minimum release age old (`tools.minimum_release_age`, or a runtime's own), and
// commits the changed files alone under the office's git identity (office.yaml's `git`), else
// "office cron". mise.toml pins are looked up and installed through mise, at the age the office's
// environment gives package managers too, so an install never asks for a release they refuse; the
// runtimes' versions on GitHub (and Executor's image on its registry), and only
// recorded: `office up --upgrade` applies them. Files with uncommitted changes are left for the
// user. A failed install or lookup keeps the old pin. Never pushes.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { git } from "../git.ts";
import { entryPattern, toolPins } from "../mise-toml.ts";
import { installedTool } from "../host-tools.ts";
import { notify } from "../notify.ts";
import { pinnedMachineFiles } from "../package-tools.ts";
import { type Document, isMap, isNode, isScalar, parseDocument } from "yaml";

import { type Office, OfficeError } from "../office.ts";
import { newestRelease, pinFor } from "../releases.ts";
import { type PinnedTool, pinnedTools } from "../schema.ts";
import { compareVersions as compareSemver, lockFile, wantedPins, writeLock } from "../versions.ts";

/**
 * How old a release must be before the job takes it: a runtime's own age under `tools`, else the
 * office's `tools.minimum_release_age`; a mise tool (`runtime` undefined) always takes the office's,
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

function mise(args: string[], cwd: string) {
  const result = spawnSync(installedTool("mise")?.path ?? "mise", args, { cwd, encoding: "utf8", env: { ...process.env, MISE_YES: "1" } });

  const errors = (result.stderr ?? "").split("\n").filter((line) => line.includes("ERROR") && !line.includes("MISE_VERBOSE"));

  // mise ends every failure with a hint to rerun verbosely; the first error line says what failed.
  return { ok: result.status === 0, out: (result.stdout ?? "").trim(), error: errors[0]?.replace(/^.*?ERROR\s*/, "") ?? "unknown error" };
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

/**
 * Upgrades one mise.toml. Returns the moves made and the failures. A pin counts as exact when
 * mise resolves it to itself, so ranges such as "26" or "latest" are left as they are.
 */
function upgradeFile(office: Office, path: string) {
  const dir = dirname(path);
  const lines = readFileSync(path, "utf8").split("\n");
  const moves: Move[] = [];
  const failures: string[] = [];

  for (const pin of toolPins(lines.join("\n"))) {
    const exact = mise(["latest", `${pin.tool}@${pin.version}`], dir);

    if (!exact.ok || exact.out !== pin.version) continue;

    const newest = mise(["latest", pin.tool, "--minimum-release-age", ageFor(office)], dir);

    if (!newest.ok || newest.out === "") {
      failures.push(`${pin.tool}: couldn't find the newest version (${newest.error})`);
      continue;
    }

    if (compareVersions(newest.out, pin.version) <= 0) continue;

    const installed = mise(["install", `${pin.tool}@${newest.out}`], dir);

    if (!installed.ok) {
      failures.push(`${pin.tool} ${pin.version} → ${newest.out}: install failed: ${installed.error}`);
      continue;
    }

    lines[pin.index] = withVersion(lines[pin.index], newest.out);
    moves.push({ tool: pin.tool, from: pin.version, to: newest.out });
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
 * The edit that sets one runtime's version under `block` (`tools`, or `versions` before it): the
 * version's text replaced in the short form (`opencode: 2.3.2`) or in a mapping, flow or block
 * (`{ version: 2.3.2, minimum_release_age: 0d }`), in the quotes it had; a mapping without one gets
 * `version` first; a runtime the block doesn't list is added after its last entry, in the short form.
 */
function versionEdit(document: Document, text: string, block: "tools" | "versions", tool: PinnedTool, version: string): Edit {
  const entry = document.getIn([block, tool], true);
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

  const map = document.get(block, true);

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

  throw new OfficeError(`set ${block}.${tool} to ${version} in office.yaml by hand`);
}

/**
 * Rewrites only the text of each moved version in office.yaml, under `tools` or, in an office.yaml
 * from before it, `versions`, so every comment, quote and the layout stay as the user wrote them.
 * It never moves an office.yaml from `versions` to `tools`.
 */
export function setVersions(text: string, moves: { tool: PinnedTool; to: string }[]): string {
  const document = parseDocument(text, { keepSourceTokens: true });
  const block = document.has("tools") ? "tools" : "versions";
  const edits = moves.map((move) => versionEdit(document, text, block, move.tool, move.to));

  return edits.sort((left, right) => right.start - left.start).reduce((result, edit) => `${result.slice(0, edit.start)}${edit.value}${result.slice(edit.end)}`, text);
}

/**
 * Bumps the runtimes' versions office.yaml pins to the highest release of each line at least its age
 * old, rewriting office.yaml (keeping its comments and layout) and office.lock. A lookup that
 * fails (GitHub's rate limit, no network) skips that tool and is reported.
 */
async function upgradeVersions(office: Office): Promise<{ moves: Move[]; failures: string[]; changed: string[] }> {
  const none = { moves: [], failures: [], changed: [] };

  if (!office.tools.pinsVersions) {
    console.log("skipped the office's versions: office.yaml pins none, so the tool's defaults apply");

    return none;
  }

  if (git(["status", "--porcelain", "--", "office.yaml", lockFile], office.dir) !== "") {
    console.log(`skipped office.yaml's versions: office.yaml or ${lockFile} has uncommitted changes`);

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

  for (const tool of pinnedTools) {
    try {
      const { chosen } = await newestRelease(tool, ageFor(office, tool));

      if (chosen === undefined || compareSemver(chosen.version, lock[tool].version) <= 0) continue;

      next[tool] = await pinFor(tool, chosen.version, chosen.release);
      moves.push({ tool, from: lock[tool].version, to: chosen.version });
    } catch (error) {
      failures.push(`${tool}: skipped, its release lookup failed (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  if (moves.length === 0) return { ...none, failures };

  const path = join(office.dir, "office.yaml");
  let text;

  try {
    text = setVersions(readFileSync(path, "utf8"), moves);
  } catch (error) {
    return { ...none, failures: [`office.yaml's versions: ${error instanceof Error ? error.message : String(error)}`] };
  }

  writeFileSync(path, text);
  writeLock(office.dir, next);

  return { moves, failures, changed: ["office.yaml", lockFile] };
}

export async function upgradeTools(office: Office): Promise<boolean> {
  // The office's own files only: never one inside a desk's repos or under references/. The
  // versions of the packages' tools are the office's too, with the same ages.
  const projects = ["mise.toml", ...office.desks.map((desk) => join(desk.name, "mise.toml"))]
    .values()
    .map((name) => join(office.dir, name))
    .filter((path) => existsSync(path))
    .toArray();

  const files = [...projects, ...pinnedMachineFiles(office)];

  const changed: string[] = [];
  const report: (Move & { file: string })[] = [];
  const failures: string[] = [];

  for (const path of files) {
    const name = relative(office.dir, path);

    if (git(["status", "--porcelain", "--", name], office.dir) !== "") {
      console.log(`skipped ${name}: it has uncommitted changes`);
      continue;
    }

    const result = upgradeFile(office, path);

    for (const failure of result.failures) failures.push(`${name}: ${failure}`);

    if (result.moves.length === 0) continue;

    changed.push(name);

    // The lock file, when the office uses one, follows the pins of the mise.toml beside it. The
    // machine-wide files apply through the global conf.d, which no lock in the office covers.
    const project = dirname(path);
    const lock = join(project, "mise.lock");

    if (projects.includes(path) && existsSync(lock)) {
      mise(["lock"], project);

      if (!changed.includes(relative(office.dir, lock))) changed.push(relative(office.dir, lock));
    }

    report.push(...result.moves.map((move) => ({ ...move, file: name })));
  }

  const versions = await upgradeVersions(office);

  for (const failure of versions.failures) failures.push(failure);

  changed.push(...versions.changed);
  report.push(...versions.moves.map((move) => ({ ...move, file: "office.yaml" })));

  if (report.length > 0) {
    const where = (move: { file: string }) => (move.file === "mise.toml" || move.file === "office.yaml" ? "" : ` in ${move.file.endsWith("/mise.toml") ? dirname(move.file) : move.file}`);
    const subject = `chore: bump ${report.map((move) => `${move.tool} ${move.from} → ${move.to}${where(move)}`).join(", ")}`;
    const body = report.map((move) => `- ${move.file}: ${move.tool} ${move.from} → ${move.to}`).join("\n");

    const { name, email } = committer(office);

    git(["-c", `user.name=${name}`, "-c", `user.email=${email}`, "-c", "commit.gpgsign=false", "commit", "--quiet", "-m", subject, "-m", body, "--", ...changed], office.dir);
    console.log(subject);
  }

  for (const failure of failures) console.log(`FAILED ${failure}`);

  if (report.length === 0 && failures.length === 0) {
    console.log("every pin is current");

    return true;
  }

  const lines = [...report.map((move) => `${move.tool} ${move.from} → ${move.to} (${move.file})`), ...failures.map((failure) => `Failed: ${failure}`)];

  await notify(office, {
    title: failures.length === 0 ? "Tools upgraded" : "Tool upgrade needs attention",
    body: `${lines.join("\n")}${report.length > 0 ? `\nCommitted locally as ${committer(office).name}; revert the commit to undo.` : ""}${versions.moves.length > 0 ? "\n`office up --upgrade` applies the new versions in office.yaml." : ""}`,
  });

  return failures.length === 0;
}
