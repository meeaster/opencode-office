import { changeText, failure } from "../../src/lib/change.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { excludeAppliedSettings, excludedPath, updateExcluded, updateExcludedOrThrow, excludeEnd, excludeStart, excludePlumbing } from "../../src/exclude-plumbing.ts";
import { summarize, sync as syncChanges } from "../../src/commands/sync.ts";
import { syncLines as sync } from "../support/sync.fixture.ts";
import { cloneShallow, git } from "../../src/git.ts";
import { loadOffice } from "../../src/office.ts";
import { readReceipts, sha256 } from "../../packages/seeds/store.ts";
import { PlainReporter } from "../../src/report/plain.ts";
import { silentStage } from "../../src/report/reporter.ts";
import { pluginDefinition, seedingDefinition, writePackage } from "../support/test-package.ts";
import { readAppliedSettings } from "../../sdk/applied-settings.ts";

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
  // A part that takes 500 ms or more ends with its elapsed time, like " (1s)"; drop it so a slow clone still matches.
  const capture = (line: string) => lines.push(line.replace(/ \((\d+m )?\d+s\)$/, ""));
  const reporter = new PlainReporter("office sync", false, capture, capture);
  const stage = reporter.stage("Repositories and packages", { key: "repos" });
  const results = await syncChanges(loadOffice(office), { scope: "references", stage });
  const changes = results.map(changeText);

  expect(changes.slice(0, 5)).toEqual(["a", "b", "c", "d", "e"].map((name) => `cloned reference references/${name}`));
  expect(changes[5]).toStartWith("FAILED reference references/missing: Command failed: git fetch --quiet --depth 1 origin HEAD\n");
  expect(summarize(results)).toBe("5 cloned, 1 failed");

  expect(lines[0]).toBe("repos: cloning and updating 6 sources, up to 8 at a time (4 new clones)");

  for (const name of ["a", "b", "c", "d", "e"]) {
    expect(lines).toContain(`repos: cloning references/${name}`);
    expect(lines).toContain(`repos: references/${name}: cloned`);
  }

  // Four at once: the fifth starts only after one of the first four has finished.
  const firstCloned = lines.findIndex((line) => / cloned$/.test(line));

  expect(firstCloned).toBeGreaterThan(-1);
  expect(lines.indexOf("repos: cloning references/e")).toBeGreaterThan(firstCloned);
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
  const firstCurrent = lines.findIndex(line => line.endsWith(": current"));

  expect(firstCurrent).toBeGreaterThan(-1);
  expect(lines.indexOf("repos: updating references/i")).toBeGreaterThan(firstCurrent);
  expect(lines.filter(line => line.endsWith(": current"))).toHaveLength(9);
  expect(summarize([])).toBe("already in sync");
});

test("sync counts failures independently of diagnostic wording", () => {
  expect(summarize(["FAILED is part of this note"])).toBe("1 other change");
  expect(summarize([failure("source unavailable")])).toBe("1 failed");
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
  writePackage(join(pkg, "office.ts"), pluginDefinition("plugin", { fields: "settings: { type: \"object\", additionalProperties: false, properties: { title: { type: \"string\", default: \"Before\" } } }," }), { dependencies: ["opencode"] });
  // From source, a local package resolves its @office imports through the published set.
  writeFileSync(join(dir, "office.yaml"), "name: demo\n");
  await sync(loadOffice(dir), { scope: "packages" });
  writeFileSync(join(dir, "office.yaml"), `name: demo\npackages: [{ name: demo, settings: { title: After } }]\nreferences: [{ name: docs, url: ${upstream} }]\nplugins: [{ name: other, repo: ${upstream} }]\n`);

  const changes = await sync(loadOffice(dir), { scope: "packages" });

  expect(changes.filter(line => line.startsWith("FAILED"))).toEqual([]);
  expect(readAppliedSettings(dir, "demo").title).toBe("After");
  // Settings are the office's runtime state, not the local package's source.
  expect(existsSync(join(pkg, ".settings.json"))).toBe(false);
  expect(existsSync(join(dir, ".opencode/plugins/demo"))).toBe(true);

  for (const path of ["references/docs", ".opencode/plugins/other"]) expect(existsSync(join(dir, path))).toBe(false);
});

test("a fresh clone of a commit holds the receipts and every seed they name, byte for byte, under core.autocrlf, and Git offers nothing else of .office/", async () => {
  const office = join(dir, "office");
  const clone = join(dir, "clone");
  const committer = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.autocrlf=true"];

  // Git would turn the CRLF file's endings to LF at add, and the LF file's to CRLF at checkout.
  writePackage(join(office, "packages/demo/office.ts"), seedingDefinition([{ destination: "notes", source: "starter" }]));
  mkdirSync(join(office, "packages/demo/starter"));
  writeFileSync(join(office, "packages/demo/starter/AGENTS.md"), "# Notes\r\n\r\nWindows endings.\r\n");
  writeFileSync(join(office, "packages/demo/starter/README.md"), "# Notes\n\nUnix endings.\n");
  writeFileSync(join(office, "office.yaml"), "name: demo\npackages: [{ name: demo }]\n");
  git(["init", "--quiet", office]);

  const changes = await sync(loadOffice(office), { scope: "packages" });

  expect(changes.filter(line => line.startsWith("FAILED"))).toEqual([]);
  const receipts = [...readReceipts(office).values()].flatMap(receipt => ("sha256" in receipt ? [receipt.sha256] : []));

  expect(receipts).toHaveLength(2);

  // A sync with no seed to copy still restores an edited or removed guard.
  for (const edit of [() => writeFileSync(join(office, ".office/seeds/.gitattributes"), "* text\n"), () => rmSync(join(office, ".office/seeds/.gitattributes"))]) {
    edit();
    expect(await sync(loadOffice(office), { scope: "packages" })).toContain("package seeds: wrote .office/seeds/.gitattributes");
    expect(readFileSync(join(office, ".office/seeds/.gitattributes"), "utf8")).toBe("* -text -filter -ident -working-tree-encoding\n");
  }

  // Of .office/, Git offers the seed store alone: its seeds, its receipts and its .gitattributes.
  const offered = git(["status", "--porcelain", "--untracked-files=all"], office).split("\n").filter(line => line.slice(3).startsWith(".office/"));

  expect(offered.sort()).toEqual([".gitattributes", "receipts.json", ...receipts].map(name => `?? .office/seeds/${name}`).sort());
  git([...committer, "add", ".office/seeds"], office);
  git([...committer, "commit", "--quiet", "-m", "seeds"], office);
  git(["-c", "core.autocrlf=true", "clone", "--quiet", "--config", "core.autocrlf=true", office, clone]);

  // The committed bytes hash to their names too, so a conversion at add would show even where checkout undoes it.
  expect(readReceipts(clone)).toEqual(readReceipts(office));

  for (const hash of receipts) {
    expect(sha256(execFileSync("git", ["show", `HEAD:.office/seeds/${hash}`], { cwd: clone }))).toBe(hash);
    expect(sha256(readFileSync(join(clone, ".office/seeds", hash)))).toBe(hash);
  }
});

// One full sync: the block is written after plugins and skills are both linked, after the owner's
// lines, and a second sync leaves it alone.
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
  writeFileSync(exclude, "# mine\n");
  writeFileSync(join(office, "office.yaml"), `name: t\nplugins: [{ name: demo, repo: ${upstream} }]\n`);

  const changes = await sync(loadOffice(office));
  const block = `# mine\n${excludeStart}\n/.office/*\n/.office/runtime/\n!/.office/seeds/\n/packages/node_modules/\n/.opencode/plugins/demo\n/.opencode/plugins/office\n${excludeEnd}\n`;

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

  file("office.yaml", `name: t\nplugins: [{ name: imported, repo: ${join(dir, "remote")} }]\n`);
  file(".office/packages/office/plugin/index.js", "export default {}\n");
  file("skills/alpha/SKILL.md", "---\nname: alpha\ndescription: fixture\n---\n");
  file(".opencode/plugins/owner-plugin/index.js", "export default {}\n");
  file(".opencode/skills/owner-skill/SKILL.md", "---\nname: owner-skill\ndescription: fixture\n---\n");
  file(".agents/skills/owner-skill/SKILL.md", "---\nname: owner-skill\ndescription: fixture\n---\n");
  link("../../packages/common/plugin", ".opencode/plugins/common");
  link("../../.office/plugins/imported", ".opencode/plugins/imported");
  link("../../.office/packages/office/plugin", ".opencode/plugins/office");
  // A link a package's sync placed, excluded only because that sync names it.
  link("../../skills/alpha", ".agents/skills/alpha");
}

test("info/exclude: a malformed block is left alone and reported, CRLF endings are kept, and the file is replaced whole", () => {
  const office = join(dir, "office");
  const exclude = join(office, ".git/info/exclude");
  linkedOffice(office);
  git(["init", "--quiet", office]);
  const plumbing = () => excludePlumbing(loadOffice(office), []).map(changeText);
  const lines = ["/.office/*", "/.office/runtime/", "/packages/node_modules/", "/.opencode/plugins/common", "/.opencode/plugins/imported", "/.opencode/plugins/office"];
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

  // The owner's lines stay, every one, the block after them.
  writeFileSync(exclude, "/.opencode/plugins/private-wip/\n", { mode: 0o600 });
  // A common umask, so a narrower mode than 0644 shows (a 077 umask would hide it).
  const umask = process.umask(0o022);

  try {
    expect(plumbing()).toContain("excluded /.office/* from commits (info/exclude)");
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
  expect(excludePlumbing(loadOffice(office), [])).toEqual([]);
  expect(existsSync(join(office, ".git"))).toBe(false);

  git(["init", "--quiet", office]);
  writeFileSync(join(office, ".gitignore"), "/repos/\n");
  // The owner's lines around a block that holds other lines than office sync wants.
  writeFileSync(exclude, `# the owner's\n*.log\n${excludeStart}\n/.office/\n${excludeEnd}\n/after\n`);
  const block = (lines: string[]) => [excludeStart, "/.office/*", "/.office/runtime/", "/packages/node_modules/", ...lines, excludeEnd].join("\n");
  const all = block(["/.agents/skills/alpha", "/.opencode/plugins/common", "/.opencode/plugins/imported", "/.opencode/plugins/office"]);
  const changes = excludePlumbing(loadOffice(office), [], [".agents/skills/alpha"]);

  expect(changes).toContain("excluded /.office/* from commits (info/exclude)");
  expect(changes).toContain("stopped excluding /.office/ from commits (info/exclude)");
  expect(readFileSync(exclude, "utf8")).toBe(`# the owner's\n*.log\n${all}\n/after\n`);

  const staged = git(["add", "-A", "--dry-run"], office).split("\n").map(line => line.replace(/^add '(.*)'$/, "$1"));
  expect(staged.filter(line => /^(\.office\/|\.opencode\/plugins\/(common|imported|office)$|\.agents\/skills\/alpha$)/.test(line))).toEqual([]);
  expect(staged).toContain(".opencode/plugins/owner-plugin/index.js");
  expect(staged).toContain(".opencode/skills/owner-skill/SKILL.md");
  expect(staged).toContain(".agents/skills/owner-skill/SKILL.md");

  // An excluded path is written literally: pattern characters name only that path.
  mkdirSync(join(office, "odd"));

  for (const name of ["a*b?[c] ", "axb_c "]) writeFileSync(join(office, "odd", name), "");
  excludePlumbing(loadOffice(office), [], [".agents/skills/alpha", "odd/a*b?[c] "]);
  expect(readFileSync(exclude, "utf8")).toContain("\n/odd/a\\*b\\?\\[c]\\ \n");
  expect(git(["status", "--porcelain", "--untracked-files=all"], office).split("\n").filter(line => line.includes("odd/"))).toEqual(['?? "odd/axb_c "']);
  rmSync(join(office, "odd"), { recursive: true });

  // Withdrawn entries leave the block, which stays in place; the owner's lines around it stay.
  rmSync(join(office, ".opencode/plugins/common"));
  const withdrawn = excludePlumbing(loadOffice(office), []);

  expect(withdrawn).toContain("stopped excluding /.opencode/plugins/common from commits (info/exclude)");
  expect(withdrawn).toContain("stopped excluding /.agents/skills/alpha from commits (info/exclude)");
  expect(readFileSync(exclude, "utf8")).toBe(`# the owner's\n*.log\n${block(["/.opencode/plugins/imported", "/.opencode/plugins/office"])}\n/after\n`);

  // Committed folders packages declare are taken back out, sorted; an empty list drops them again.
  const kept = ["/.opencode/plugins/imported", "/.opencode/plugins/office"];
  const committed = [excludeStart, "/.office/*", "/.office/runtime/", "!/.office/alpha/", "!/.office/notes/", "/packages/node_modules/", ...kept, excludeEnd].join("\n");
  mkdirSync(join(office, ".office/notes"));
  writeFileSync(join(office, ".office/notes/x.md"), "x\n");
  expect(excludePlumbing(loadOffice(office), [".office/notes/", ".office/alpha/"])).toEqual(["stopped excluding /.office/alpha/ from commits (info/exclude)", "stopped excluding /.office/notes/ from commits (info/exclude)"]);
  expect(readFileSync(exclude, "utf8")).toBe(`# the owner's\n*.log\n${committed}\n/after\n`);
  expect(git(["status", "--porcelain", "--untracked-files=all"], office).split("\n").filter(line => line.includes(".office/"))).toEqual(["?? .office/notes/x.md"]);
  expect(excludePlumbing(loadOffice(office), [])).toEqual(["excluded /.office/alpha/ from commits (info/exclude)", "excluded /.office/notes/ from commits (info/exclude)"]);
  expect(readFileSync(exclude, "utf8")).toBe(`# the owner's\n*.log\n${block(kept)}\n/after\n`);
  expect(git(["status", "--porcelain", "--untracked-files=all"], office)).not.toContain(".office/");
});

test("the applied settings' folder is excluded at once, owner lines kept, and the whole block that follows keeps it without reporting it again", () => {
  const office = join(dir, "office");
  const exclude = join(office, ".git/info/exclude");

  linkedOffice(office);
  git(["init", "--quiet", office]);
  writeFileSync(exclude, "# mine\n/owner\n");

  expect(excludeAppliedSettings(loadOffice(office)).map(changeText)).toEqual(["excluded /.office/runtime/ from commits (info/exclude)"]);
  expect(readFileSync(exclude, "utf8")).toBe(`# mine\n/owner\n${excludeStart}\n/.office/runtime/\n${excludeEnd}\n`);
  expect(excludeAppliedSettings(loadOffice(office))).toEqual([]);
  expect(excludePlumbing(loadOffice(office), []).map(changeText)).not.toContain("excluded /.office/runtime/ from commits (info/exclude)");
  expect(readFileSync(exclude, "utf8")).toStartWith(`# mine\n/owner\n${excludeStart}\n/.office/*\n/.office/runtime/\n`);
});

test("an immediate exclusion update changes only its paths' lines, literally, so Git sees an owner's replacement", () => {
  const office = join(dir, "office");
  const exclude = join(office, ".git/info/exclude");

  const ignored = (path: string) => {
    try {
      return git(["check-ignore", path], office) === path;
    } catch {
      return false;
    }
  };

  linkedOffice(office);
  git(["init", "--quiet", office]);
  // Before any sync wrote a block, removing nothing writes nothing.
  expect(updateExcluded(loadOffice(office), { remove: [".agents/skills/alpha"] })).toEqual([]);
  expect(existsSync(exclude) ? readFileSync(exclude, "utf8") : "").not.toContain(excludeStart);
  excludePlumbing(loadOffice(office), [], [".agents/skills/alpha", ".agents/skills/b*"]);
  const before = readFileSync(exclude, "utf8");
  writeFileSync(exclude, `# the owner's\n${before}/after\n`);
  mkdirSync(join(office, ".agents/skills/alpha"), { recursive: true });
  writeFileSync(join(office, ".agents/skills/alpha/SKILL.md"), "the owner's\n");

  expect(ignored(".agents/skills/alpha")).toBe(true);
  expect(updateExcluded(loadOffice(office), { add: [".agents/skills/gamma"], remove: [".agents/skills/alpha", ".agents/skills/b*"] })).toEqual([
    "excluded /.agents/skills/gamma from commits (info/exclude)",
    "stopped excluding /.agents/skills/alpha from commits (info/exclude)",
    "stopped excluding /.agents/skills/b\\* from commits (info/exclude)",
  ]);
  expect(readFileSync(exclude, "utf8")).toBe(`# the owner's\n${before.replace("/.agents/skills/alpha\n", "").replace("/.agents/skills/b\\*\n", "").replace(excludeEnd, `/.agents/skills/gamma\n${excludeEnd}`)}/after\n`);
  expect(ignored(".agents/skills/alpha/SKILL.md")).toBe(false);
  expect(ignored(".agents/skills/gamma")).toBe(true);
  expect(ignored(".opencode/plugins/common")).toBe(true);
});

test("an up's exclusion update throws, changing nothing, when the block can't be edited; an office outside Git needs none", () => {
  const office = join(dir, "office");
  const exclude = join(office, ".git/info/exclude");

  linkedOffice(office);
  expect(updateExcludedOrThrow(loadOffice(office), { add: [".agents/skills/alpha"] })).toEqual([]);
  git(["init", "--quiet", office]);
  writeFileSync(exclude, `${excludeStart}\n${excludeStart}\n${excludeEnd}\n`);
  expect(() => updateExcludedOrThrow(loadOffice(office), { add: [".agents/skills/alpha"] })).toThrow(`has 2 "${excludeStart}" and 1 "${excludeEnd}" lines, not one block`);
  expect(readFileSync(exclude, "utf8")).toBe(`${excludeStart}\n${excludeStart}\n${excludeEnd}\n`);
});

test("a path a package's sync excludes must be a normalized office path outside .office/, on one line", () => {
  expect(excludedPath(".agents/skills/review")).toBe(".agents/skills/review");

  for (const path of ["", "/etc/passwd", "../outside", "a/../b", ".office/skills/links.json", ".office", "two\nlines"]) expect(() => excludedPath(path)).toThrow("can't exclude");
});
