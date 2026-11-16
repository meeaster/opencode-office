// `office upgrade-tools`: bumps each exact pin in the office's own mise.toml files (the root's and
// each desk's) to the newest version released at least a day ago, installs it, and commits the
// changed files alone under the "office cron" identity. Files with uncommitted changes are left
// for the user. A failed install keeps the old pin. Never pushes.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { git } from "../git.ts";
import { notify } from "../notify.ts";
import type { Office } from "../office.ts";

/** The cutoff passed to `mise latest`: the user's rule is nothing released less than a day ago. */
const minimumReleaseAge = "1d";

/** Commits made by the job carry this identity, set for that commit only. */
const identity = ["-c", "user.name=office cron", "-c", "user.email=office-cron@localhost", "-c", "commit.gpgsign=false"];

// A [tools] entry: `name = "1.2.3"` or `name = { version = "1.2.3", ... }`, name optionally quoted.
const entryPattern = /^(\s*)("[^"]+"|[A-Za-z0-9_.:@/-]+)(\s*=\s*(?:\{[^}]*?\bversion\s*=\s*)?")([^"]+)(".*)$/;

/** A pin the job moved. */
type Move = { tool: string; from: string; to: string };

function mise(args: string[], cwd: string) {
  const result = spawnSync("mise", args, { cwd, encoding: "utf8", env: { ...process.env, MISE_YES: "1" } });

  const errors = (result.stderr ?? "").split("\n").filter((line) => line.includes("ERROR") && !line.includes("MISE_VERBOSE"));

  // mise ends every failure with a hint to rerun verbosely; the first error line says what failed.
  return { ok: result.status === 0, out: (result.stdout ?? "").trim(), error: errors[0]?.replace(/^.*?ERROR\s*/, "") ?? "unknown error" };
}

/** The pins in a mise.toml's [tools] table, with the line each is on. */
function pins(text: string): { index: number; tool: string; version: string }[] {
  let inTools = false;

  return text.split("\n").flatMap((line, index) => {
    if (/^\s*\[/.test(line)) inTools = /^\s*\[tools\]\s*(#.*)?$/.test(line);

    const match = inTools ? entryPattern.exec(line) : null;

    return match === null ? [] : [{ index, tool: match[2].replaceAll('"', ""), version: match[4] }];
  });
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
function upgradeFile(path: string) {
  const dir = dirname(path);
  const lines = readFileSync(path, "utf8").split("\n");
  const moves: Move[] = [];
  const failures: string[] = [];

  for (const pin of pins(lines.join("\n"))) {
    const exact = mise(["latest", `${pin.tool}@${pin.version}`], dir);

    if (!exact.ok || exact.out !== pin.version) continue;

    const newest = mise(["latest", pin.tool, "--minimum-release-age", minimumReleaseAge], dir);

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
export async function upgradeTools(office: Office): Promise<boolean> {
  // The office's own files only: never one inside a desk's repos or under references/.
  const files = ["mise.toml", ...office.desks.map((desk) => join(desk.name, "mise.toml"))]
    .values()
    .map((name) => join(office.dir, name))
    .filter((path) => existsSync(path))
    .toArray();

  const changed: string[] = [];
  const report: (Move & { file: string })[] = [];
  const failures: string[] = [];

  for (const path of files) {
    const name = relative(office.dir, path);

    if (git(["status", "--porcelain", "--", name], office.dir) !== "") {
      console.log(`skipped ${name}: it has uncommitted changes`);
      continue;
    }

    const result = upgradeFile(path);

    for (const failure of result.failures) failures.push(`${name}: ${failure}`);

    if (result.moves.length === 0) continue;

    changed.push(name);

    // The lock file, when the office uses one, follows the pins it records.
    const lock = join(dirname(path), "mise.lock");

    if (existsSync(lock)) {
      mise(["lock"], dirname(path));
      changed.push(relative(office.dir, lock));
    }

    report.push(...result.moves.map((move) => ({ ...move, file: name })));
  }

  if (report.length > 0) {
    const where = (move: { file: string }) => (move.file === "mise.toml" ? "" : ` in ${dirname(move.file)}`);
    const subject = `chore: bump ${report.map((move) => `${move.tool} ${move.from} → ${move.to}${where(move)}`).join(", ")}`;
    const body = report.map((move) => `- ${move.file}: ${move.tool} ${move.from} → ${move.to}`).join("\n");

    git([...identity, "commit", "--quiet", "-m", subject, "-m", body, "--", ...changed], office.dir);
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
    body: `${lines.join("\n")}${report.length > 0 ? "\nCommitted locally as office cron; revert the commit to undo." : ""}`,
  });

  return failures.length === 0;
}
