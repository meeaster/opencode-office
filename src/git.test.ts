import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { excludeEnd, excludeStart, excludePlumbing, summarize, sync } from "./commands/sync.ts";
import { cloneShallow, git } from "./git.ts";
import { loadOffice } from "./office.ts";
import { sha256, storedSeedProblems } from "./seeds.ts";
import { readLockSection } from "./versions.ts";
import { PlainReporter } from "./report/plain.ts";
import { silentStage } from "./report/reporter.ts";
import { writePackage } from "./test-package.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-git-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("sync refreshes a reference that is its own clone, and refuses a plain folder at a clone path instead of running git in the office", async () => {
  const office = join(dir, "office");
  const upstream = join(dir, "upstream");

  const commit = (message: string) => {
    writeFileSync(join(upstream, "notes.md"), `${message}\n`);
    git(["add", "-A"], upstream);
    git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", message], upstream);
  };

  mkdirSync(upstream);
  git(["init", "--quiet", upstream]);
  commit("one");
  mkdirSync(office);
  writeFileSync(join(office, "office.yaml"), `name: t\nreferences:\n  - { name: up, url: ${upstream} }\n  - { name: plain, url: ${upstream} }\n`);
  git(["init", "--quiet", office]);
  mkdirSync(join(office, "references/plain"), { recursive: true });
  writeFileSync(join(office, "references/plain/keep.md"), "not a clone\n");

  const first = await sync(loadOffice(office), { scope: "references" });

  expect(first).toContain("cloned reference references/up");
  expect(first).toContain(`FAILED reference references/plain: ${join(office, "references/plain")} holds a folder that isn't a repository of its own (no .git), not a clone; move it away so office sync can clone there`);

  commit("two");

  expect(await sync(loadOffice(office), { scope: "references" })).toContain("updated reference references/up");
});

test("sync reports each clone as a part while it runs, keeps git's error for one that fails, and returns the same lines in office.yaml's order", async () => {
  const office = join(dir, "office");
  const upstream = join(dir, "upstream");

  mkdirSync(upstream);
  git(["init", "--quiet", upstream]);
  writeFileSync(join(upstream, "notes.md"), "one\n");
  git(["add", "-A"], upstream);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "one"], upstream);
  mkdirSync(office);
  writeFileSync(
    join(office, "office.yaml"),
    `name: t\nreferences:\n${["a", "b", "c", "d", "e"].map((name) => `  - { name: ${name}, url: ${upstream} }\n`).join("")}  - { name: missing, url: ${join(dir, "nowhere")} }\n`,
  );
  git(["init", "--quiet", office]);

  const lines: string[] = [];
  const reporter = new PlainReporter("office sync", false, (line) => lines.push(line), (line) => lines.push(line));
  const stage = reporter.stage("Repositories and packages", { key: "repos" });
  const changes = await sync(loadOffice(office), { scope: "references", stage });

  expect(changes.slice(0, 5)).toEqual(["a", "b", "c", "d", "e"].map((name) => `cloned reference references/${name}`));
  expect(changes[5]).toStartWith("FAILED reference references/missing: Command failed: git fetch --quiet --depth 1 origin HEAD\n");
  expect(summarize(changes)).toBe("5 cloned, 1 failed");

  expect(lines[0]).toBe("repos: cloning and updating 6 sources, up to 8 at a time (4 new clones)");

  for (const name of ["a", "b", "c", "d", "e"]) {
    expect(lines).toContain(`repos: cloning references/${name}`);
    expect(lines).toContain(`repos: references/${name}: cloned`);
  }

  // Four at once: the fifth starts only after one of the first four has finished.
  expect(lines.indexOf("repos: cloning references/e")).toBeGreaterThan(lines.findIndex((line) => / cloned$/.test(line)));
  expect(lines.find((line) => line.startsWith("repos: references/missing: FAILED: Command failed: git fetch"))).toBeDefined();
  // The failing clone's own last lines follow, git's error among them.
  expect(lines.some((line) => line.startsWith("repos: | references/missing: ") && line.includes("nowhere"))).toBe(true);
  // A rerun updates nothing: every part says current, and there is no change to return.
  lines.length = 0;
  const existing = [..."abcdefghi"];

  for (const name of existing.slice(5)) cpSync(join(office, "references/a"), join(office, "references", name), { recursive: true });
  writeFileSync(join(office, "office.yaml"), `name: t\nreferences:\n${existing.map((name) => `  - { name: ${name}, url: ${upstream} }\n`).join("")}`);

  expect(await sync(loadOffice(office), { scope: "references", stage: reporter.stage("Repositories and packages", { key: "repos" }) })).toEqual([]);
  expect(lines.slice(1, 9)).toEqual(existing.slice(0, 8).map(name => `repos: updating references/${name}`));
  expect(lines.indexOf("repos: updating references/i")).toBeGreaterThan(lines.findIndex(line => line.endsWith(": current")));
  expect(lines.filter(line => line.endsWith(": current"))).toHaveLength(9);
  expect(summarize([])).toBe("already in sync");
});

test("a full sync reports its change lines as notes and FAILED lines as errors while returning them", async () => {
  const office = join(dir, "office");

  mkdirSync(office);
  writeFileSync(join(office, "office.yaml"), "name: t\n");
  git(["init", "--quiet", office]);

  const seen: { kind: string; text: string }[] = [];
  const stage = { ...silentStage, note: (text: string) => seen.push({ kind: "note", text }), error: (text: string) => seen.push({ kind: "error", text }) };
  const changes = await sync(loadOffice(office), { stage });

  expect(changes.length).toBeGreaterThan(0);
  expect(seen.map((entry) => entry.text)).toEqual(changes);
  expect(seen.every((entry) => (entry.kind === "error") === entry.text.startsWith("FAILED"))).toBe(true);
});

test("a failed new reference leaves nothing behind; an existing unborn clone is repaired in place", async () => {
  const office = join(dir, "office");
  const upstream = join(dir, "upstream");

  mkdirSync(upstream);
  git(["init", "--quiet", upstream]);
  writeFileSync(join(upstream, "notes.md"), "one\n");
  git(["add", "-A"], upstream);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "one"], upstream);
  mkdirSync(office);
  writeFileSync(join(office, "office.yaml"), `name: t\nreferences:\n  - { name: up, url: ${upstream}, ref: missing-branch }\n`);
  git(["init", "--quiet", office]);

  const realError = expect.stringMatching(/^FAILED reference references\/up: Command failed: git fetch --quiet --depth 1 origin missing-branch\n.*missing-branch/);

  expect(await sync(loadOffice(office), { scope: "references" })).toEqual([realError]);
  expect(existsSync(join(office, "references/up"))).toBe(false);
  // The same again: still the real error, not git rev-parse on an empty repository.
  expect(await sync(loadOffice(office), { scope: "references" })).toEqual([realError]);

  // What a failed clone left before: an empty folder holding only an initialised .git with the remote.
  mkdirSync(join(office, "references/up"), { recursive: true });
  git(["init", "--quiet", join(office, "references/up")]);
  git(["remote", "add", "origin", upstream], join(office, "references/up"));
  expect((await sync(loadOffice(office), { scope: "references" }))[0]).toContain("couldn't find remote ref missing-branch");
  expect(git(["config", "--get", "remote.origin.url"], join(office, "references/up"))).toBe(upstream);

  writeFileSync(join(office, "office.yaml"), `name: t\nreferences:\n  - { name: up, url: ${upstream} }\n`);
  expect(await sync(loadOffice(office), { scope: "references" })).toEqual(["updated reference references/up"]);
  expect(() => cloneShallow(upstream, "missing-branch", join(dir, "blocking"))).toThrow("missing-branch");
  expect(existsSync(join(dir, "blocking"))).toBe(false);
});

test("packages-only sync applies changed settings and plugin links without visiting unrelated Git remotes", async () => {
  const pkg = join(dir, "packages/demo");
  const upstream = join(dir, "unavailable");

  mkdirSync(join(pkg, "plugin"), { recursive: true });
  writePackage(join(pkg, "package.yaml"), "name: demo\ndescription: Demo\nsettings:\n  title: { description: Title, default: Before }\n");
  writeFileSync(join(dir, "office.yaml"), `name: demo\npackages: [{ name: demo, settings: { title: After } }]\nreferences: [{ name: docs, url: ${upstream} }]\ndesks: { work: { repos: [{ name: example, url: ${upstream} }] } }\nplugins: [{ name: other, repo: ${upstream} }]\n`);

  const changes = await sync(loadOffice(dir), { scope: "packages" });

  expect(changes.filter(line => line.startsWith("FAILED"))).toEqual([]);
  expect(JSON.parse(readFileSync(join(pkg, ".settings.json"), "utf8")).title).toBe("After");
  expect(existsSync(join(dir, ".opencode/plugins/demo"))).toBe(true);

  for (const path of ["references/docs", "work/repos/example", ".opencode/plugins/other"]) expect(existsSync(join(dir, path))).toBe(false);
});

test("a fresh clone of a commit holds every seed its receipts name, byte for byte, under core.autocrlf", async () => {
  const office = join(dir, "office");
  const clone = join(dir, "clone");
  const committer = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.autocrlf=true"];

  mkdirSync(join(office, "packages/demo/seed/notes"), { recursive: true });
  writePackage(join(office, "packages/demo/package.yaml"), "name: demo\ndescription: Demo\n");
  // Git would turn the CRLF file's endings to LF at add, and the LF file's to CRLF at checkout.
  writeFileSync(join(office, "packages/demo/seed/notes/AGENTS.md"), "# Notes\r\n\r\nWindows endings.\r\n");
  writeFileSync(join(office, "packages/demo/seed/notes/README.md"), "# Notes\n\nUnix endings.\n");
  writeFileSync(join(office, "office.yaml"), "name: demo\npackages: [{ name: demo }]\n");
  git(["init", "--quiet", office]);

  const changes = await sync(loadOffice(office), { scope: "packages" });

  expect(changes.filter(line => line.startsWith("FAILED"))).toEqual([]);
  const receipts = [...readLockSection(office, "seeds").values()].flatMap(receipt => ("sha256" in receipt ? [receipt.sha256] : []));

  expect(receipts).toHaveLength(2);
  // A sync with no seed to copy still restores an edited or removed guard.
  for (const edit of [() => writeFileSync(join(office, ".office/seeds/.gitattributes"), "* text\n"), () => rmSync(join(office, ".office/seeds/.gitattributes"))]) {
    edit();
    expect(await sync(loadOffice(office), { scope: "packages" })).toContain("wrote .office/seeds/.gitattributes");
    expect(readFileSync(join(office, ".office/seeds/.gitattributes"), "utf8")).toBe("* -text -filter -ident -working-tree-encoding\n");
  }

  // Of .office/, Git offers the seed store alone: its seeds and its .gitattributes.
  const offered = git(["status", "--porcelain", "--untracked-files=all"], office).split("\n").filter(line => line.slice(3).startsWith(".office/"));

  expect(offered.sort()).toEqual([".gitattributes", ...receipts].map(name => `?? .office/seeds/${name}`).sort());
  git([...committer, "add", "office.lock", ".office/seeds"], office);
  git([...committer, "commit", "--quiet", "-m", "seeds"], office);
  git(["-c", "core.autocrlf=true", "clone", "--quiet", "--config", "core.autocrlf=true", office, clone]);

  // The committed bytes hash to their names too, so a conversion at add would show even where checkout undoes it.
  const cloned = [...readLockSection(clone, "seeds").values()].flatMap(receipt => ("sha256" in receipt ? [receipt.sha256] : []));

  expect(cloned.sort()).toEqual(receipts.sort());
  for (const hash of cloned) expect(sha256(execFileSync("git", ["show", `HEAD:.office/seeds/${hash}`], { cwd: clone }))).toBe(hash);
  expect(storedSeedProblems(clone)).toEqual([]);
});

// One full sync: the block is written after plugins and skills are both linked, replaces the line an
// earlier release wrote, and a second sync leaves it alone.
test("sync of an office that is a Git worktree excludes its plumbing in the exclude file its repository shares", async () => {
  const main = join(dir, "main");
  const office = join(dir, "office");
  const upstream = join(dir, "upstream");
  const exclude = join(main, ".git/info/exclude");

  mkdirSync(upstream);
  git(["init", "--quiet", upstream]);
  writeFileSync(join(upstream, "index.js"), "export default {}\n");
  git(["add", "-A"], upstream);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "one"], upstream);
  mkdirSync(main);
  git(["init", "--quiet", main]);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "--allow-empty", "-m", "init"], main);
  git(["worktree", "add", "--quiet", office], main);
  mkdirSync(join(main, ".git/info"), { recursive: true });
  // The owner's line, and one an earlier release wrote for a clone in .opencode/plugins/.
  writeFileSync(exclude, "# mine\n/.opencode/plugins/demo/\n");
  writeFileSync(join(office, "office.yaml"), `name: t\nplugins: [{ name: demo, repo: ${upstream} }]\nskills: { enabled: [alpha] }\n`);
  mkdirSync(join(office, "skills/alpha"), { recursive: true });
  writeFileSync(join(office, "skills/alpha/SKILL.md"), "---\nname: alpha\ndescription: fixture\n---\n");

  const changes = await sync(loadOffice(office));
  const block = `# mine\n${excludeStart}\n/.office/*\n!/.office/seeds/\n/packages/node_modules/\n/.opencode/plugins/demo\n/.opencode/plugins/office\n/.opencode/skills/alpha\n${excludeEnd}\n`;

  expect(changes.filter(line => line.startsWith("FAILED"))).toEqual([]);
  expect(changes).toContain("excluded /.opencode/plugins/demo from commits (info/exclude)");
  expect(readFileSync(join(office, ".opencode/plugins/demo/index.js"), "utf8")).toBe("export default {}\n");
  expect(readlinkSync(join(office, ".opencode/plugins/demo"))).toBe("../../.office/plugins/demo");
  expect(readFileSync(exclude, "utf8")).toBe(block);
  expect(git(["status", "--porcelain", "--untracked-files=all"], office)).not.toMatch(/\.office|\.opencode\/(plugins|skills)/);
  expect((await sync(loadOffice(office))).filter(line => line.includes("exclude"))).toEqual([]);
  expect(readFileSync(exclude, "utf8")).toBe(block);
});

/** An office with Office's links on disk (officeEntries reads them by their text) and the owner's entries beside them. */
function linkedOffice(office: string) {
  const link = (target: string, path: string) => {
    mkdirSync(dirname(join(office, path)), { recursive: true });
    symlinkSync(target, join(office, path));
  };

  const file = (path: string, text: string) => {
    mkdirSync(dirname(join(office, path)), { recursive: true });
    writeFileSync(join(office, path), text);
  };

  file("office.yaml", `name: t\ndesks: { builder: { app: false } }\nplugins: [{ name: imported, repo: ${join(dir, "remote")} }]\n`);
  file(".office/packages/office/plugin/index.js", "export default {}\n");
  file("skills/alpha/SKILL.md", "---\nname: alpha\ndescription: fixture\n---\n");
  file(".opencode/plugins/owner-plugin/index.js", "export default {}\n");
  file(".opencode/skills/owner-skill/SKILL.md", "---\nname: owner-skill\ndescription: fixture\n---\n");
  link("../../packages/common/plugin", ".opencode/plugins/common");
  link("../../.office/plugins/imported", ".opencode/plugins/imported");
  link("../../.office/packages/office/plugin", ".opencode/plugins/office");
  link("../../skills/alpha", ".opencode/skills/alpha");
  link("../../../skills/alpha", "builder/.opencode/skills/alpha");
}

test("info/exclude: a malformed block is left alone and reported, CRLF endings are kept, and only declared clones' legacy lines go", () => {
  const office = join(dir, "office");
  const exclude = join(office, ".git/info/exclude");
  linkedOffice(office);
  rmSync(join(office, ".opencode/skills"), { recursive: true });
  rmSync(join(office, "builder"), { recursive: true });
  git(["init", "--quiet", office]);
  const plumbing = () => excludePlumbing(loadOffice(office));
  const lines = ["/.office/*", "!/.office/seeds/", "/packages/node_modules/", "/.opencode/plugins/common", "/.opencode/plugins/imported", "/.opencode/plugins/office"];
  const block = (eol: string) => [excludeStart, ...lines, excludeEnd].map(line => line + eol).join("");

  // A start without an end (an end without a start, duplicates): nothing is guessed or rewritten.
  for (const text of [
    `# mine\n${excludeStart}\n/.office/\n/owner-after\n`,
    `# mine\n/owner-before\n${excludeEnd}\n`,
    `${block("\n")}/owner-between\n${block("\n")}`,
    `/owner\n${excludeEnd}\n${excludeStart}\n`,
  ]) {
    writeFileSync(exclude, text);
    const report = plumbing();
    expect(report).toEqual([expect.stringMatching(/^FAILED .*not one block; left unchanged/)]);
    expect(readFileSync(exclude, "utf8")).toBe(text);
  }

  // CRLF: the block is recognized and kept CRLF, with the owner's lines as they were.
  writeFileSync(exclude, `# mine\r\n/owner\r\n${block("\r\n")}/after\r\n`);
  expect(plumbing()).toEqual([]);
  writeFileSync(exclude, `# mine\r\n/owner\r\n${block("\r\n").replace("/.opencode/plugins/common\r\n", "")}`);
  expect(plumbing()).toEqual(["excluded /.opencode/plugins/common from commits (info/exclude)"]);
  expect(readFileSync(exclude, "utf8")).toBe(`# mine\r\n/owner\r\n${block("\r\n")}`);

  // Legacy per-clone lines go only for names plugins: declares; the owner's line of that shape stays.
  writeFileSync(exclude, "/.opencode/plugins/private-wip/\n/.opencode/plugins/imported/\n/.office-plugin-*/\n", { mode: 0o600 });
  // A common umask, so a narrower mode than 0644 shows (a 077 umask would hide it).
  const umask = process.umask(0o022);

  try {
    expect(plumbing()).toContain("replaced 2 plugin exclude lines earlier releases wrote with the office sync block (info/exclude)");
  } finally {
    process.umask(umask);
  }

  expect(readFileSync(exclude, "utf8")).toBe(`/.opencode/plugins/private-wip/\n${block("\n")}`);
  // Replaced whole by rename, as 0644 under the umask, leaving no temporary file.
  expect(statSync(exclude).mode & 0o777).toBe(0o644);
  expect(readdirSync(dirname(exclude))).toEqual(["exclude"]);
});

test("info/exclude holds Office's plumbing in one block after the owner's lines, leaving the owner's entries to commit", () => {
  const office = join(dir, "office");
  const exclude = join(office, ".git/info/exclude");
  linkedOffice(office);

  // Without Git, nothing is written and no repository is made.
  expect(excludePlumbing(loadOffice(office))).toEqual([]);
  expect(existsSync(join(office, ".git"))).toBe(false);

  git(["init", "--quiet", office]);
  writeFileSync(join(office, ".gitignore"), "/builder/repos/\n");
  // The owner's lines, one an earlier release wrote for a clone in .opencode/plugins/, and the block
  // as the release before the seed store wrote it.
  writeFileSync(exclude, `# the owner's\n*.log\n/.opencode/plugins/imported/\n${excludeStart}\n/.office/\n${excludeEnd}\n/after\n`);
  const block = (lines: string[]) => [excludeStart, "/.office/*", "!/.office/seeds/", "/packages/node_modules/", ...lines, excludeEnd].join("\n");
  const all = block(["/.opencode/plugins/common", "/.opencode/plugins/imported", "/.opencode/plugins/office", "/.opencode/skills/alpha", "/builder/.opencode/skills/alpha"]);
  const changes = excludePlumbing(loadOffice(office));

  expect(changes).toContain("replaced 1 plugin exclude line earlier releases wrote with the office sync block (info/exclude)");
  expect(changes).toContain("excluded /.office/* from commits (info/exclude)");
  expect(changes).toContain("stopped excluding /.office/seeds/ from commits (info/exclude)");
  expect(changes).toContain("stopped excluding /.office/ from commits (info/exclude)");
  expect(readFileSync(exclude, "utf8")).toBe(`# the owner's\n*.log\n${all}\n/after\n`);

  const staged = git(["add", "-A", "--dry-run"], office).split("\n").map(line => line.replace(/^add '(.*)'$/, "$1"));
  expect(staged.filter(line => /^(\.office\/|\.opencode\/plugins\/(common|imported|office)$|\.opencode\/skills\/alpha$|builder\/\.opencode\/skills\/alpha$)/.test(line))).toEqual([]);
  expect(staged).toContain(".opencode/plugins/owner-plugin/index.js");
  expect(staged).toContain(".opencode/skills/owner-skill/SKILL.md");

  // Withdrawn entries leave the block, which stays in place; the owner's lines around it stay.
  for (const path of [".opencode/plugins/common", ".opencode/skills/alpha", "builder/.opencode/skills/alpha"]) rmSync(join(office, path));
  expect(excludePlumbing(loadOffice(office))).toContain("stopped excluding /.opencode/plugins/common from commits (info/exclude)");
  expect(readFileSync(exclude, "utf8")).toBe(`# the owner's\n*.log\n${block(["/.opencode/plugins/imported", "/.opencode/plugins/office"])}\n/after\n`);
});
