// `office upgrade-tools`: bumps each exact pin in the office's own mise.toml files (the root's and
// each desk's) and in the root's .mise/conf.d/ fragments (packages' tools among them), and the four versions office.yaml pins, to the newest release at least the
// office's minimum release age old, and commits the changed files alone under the office's git
// identity (office.yaml's `git`), else "office cron". mise.toml pins are looked up and installed
// through mise; the four versions on GitHub (and Executor's image on its registry), and only
// recorded: `office up --upgrade` applies them. Files with uncommitted changes are left for the
// user. A failed install or lookup keeps the old pin. Never pushes.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { git } from "../git.ts";
import { entryPattern, toolPins } from "../mise-toml.ts";
import { installedTool } from "../host-tools.ts";
import { notify } from "../notify.ts";
import { fragmentFiles } from "../package-tools.ts";
import { isScalar, parseDocument } from "yaml";

import type { Office } from "../office.ts";
import { newestRelease, pinFor } from "../releases.ts";
import { pinnedTools } from "../schema.ts";
import { compareVersions as compareSemver, lockFile, wantedPins, writeLock } from "../versions.ts";

/** How old a tool's release must be: its own age in office.yaml's `upgrades`, else the default there, else a day. */
function ageFor(office: Office, tool: string): string {
  return office.upgrades[tool] ?? office.upgrades.minimum_release_age ?? "1d";
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

    const newest = mise(["latest", pin.tool, "--minimum-release-age", ageFor(office, pin.tool)], dir);

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

    lines[pin.index] = lines[pin.index].replace(entryPattern, (_, indent: string, name: string, middle: string, _version: string, rest: string) => `${indent}${name}${middle}${newest.out}${rest}`);
    moves.push({ tool: pin.tool, from: pin.version, to: newest.out });
  }

  if (moves.length > 0) writeFileSync(path, lines.join("\n"));

  return { moves, failures };
}

/** Runs the upgrade over the office; returns whether everything that was tried succeeded. */
/**
 * Rewrites only the text of each moved version in office.yaml, so every comment and the layout
 * stay as the user wrote them. A tool the block doesn't list yet is added at its end.
 */
function setVersions(text: string, moves: Move[]): string {
  const document = parseDocument(text, { keepSourceTokens: true });
  const edits: { start: number; end: number; value: string }[] = [];
  const added: string[] = [];

  for (const move of moves) {
    const node = document.getIn(["versions", move.tool], true);

    if (isScalar(node) && node.range !== undefined && node.range !== null) edits.push({ start: node.range[0], end: node.range[1], value: move.to });
    else added.push(`  ${move.tool}: ${move.to}`);
  }

  let result = text;

  for (const edit of edits.sort((left, right) => right.start - left.start)) result = `${result.slice(0, edit.start)}${edit.value}${result.slice(edit.end)}`;

  if (added.length > 0) result = result.replace(/^versions:[^\n]*\n((?:[ \t]+[^\n]*\n)*)/m, (block) => `${block}${added.join("\n")}\n`);

  return result;
}

/**
 * Bumps the four versions office.yaml pins to the highest release of each line at least its age
 * old, rewriting office.yaml (keeping its comments and layout) and office.lock. A lookup that
 * fails (GitHub's rate limit, no network) skips that tool and is reported.
 */
async function upgradeVersions(office: Office): Promise<{ moves: Move[]; failures: string[]; changed: string[] }> {
  const none = { moves: [], failures: [], changed: [] };

  if (office.versions === undefined) {
    console.log("skipped the office's versions: office.yaml has no versions block, so the tool's defaults apply");

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

  const moves: Move[] = [];
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

  writeFileSync(path, setVersions(readFileSync(path, "utf8"), moves));
  writeLock(office.dir, next);

  return { moves, failures, changed: ["office.yaml", lockFile] };
}

export async function upgradeTools(office: Office): Promise<boolean> {
  // The office's own files only: never one inside a desk's repos or under references/. Fragments
  // a package's tools started in are the office's too, with the same ages.
  const files = [
    ...["mise.toml", ...office.desks.map((desk) => join(desk.name, "mise.toml"))]
      .values()
      .map((name) => join(office.dir, name))
      .filter((path) => existsSync(path)),
    ...fragmentFiles(office),
  ];

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

    // The lock file, when the office uses one, follows the pins it records. A fragment's tools
    // share the root's.
    const project = name.startsWith(".mise/") ? office.dir : dirname(path);
    const lock = join(project, "mise.lock");

    if (existsSync(lock)) {
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
    const where = (move: { file: string }) => (move.file === "mise.toml" || move.file === "office.yaml" ? "" : ` in ${move.file.startsWith(".mise/") ? move.file : dirname(move.file)}`);
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
    body: `${lines.join("\n")}${report.length > 0 ? `\nCommitted locally as ${committer(office).name}; revert the commit to undo.` : ""}${versions.moves.length > 0 ? "\nNothing restarted: `office up --upgrade` applies the new versions in office.yaml." : ""}`,
  });

  return failures.length === 0;
}
