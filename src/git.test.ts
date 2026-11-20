import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { summarize, sync } from "./commands/sync.ts";
import { cloneShallow, git } from "./git.ts";
import { loadOffice } from "./office.ts";
import { PlainReporter } from "./report/plain.ts";
import { silentStage } from "./report/reporter.ts";

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
  writeFileSync(join(pkg, "package.yaml"), "name: demo\ndescription: Demo\nsettings:\n  title: { description: Title, default: Before }\n");
  writeFileSync(join(dir, "office.yaml"), `name: demo\npackages: [{ name: demo, settings: { title: After } }]\nreferences: [{ name: docs, url: ${upstream} }]\ndesks: { work: { repos: [{ name: example, url: ${upstream} }] } }\nplugins: [{ name: other, repo: ${upstream} }]\n`);

  const changes = await sync(loadOffice(dir), { scope: "packages" });

  expect(changes.filter(line => line.startsWith("FAILED"))).toEqual([]);
  expect(JSON.parse(readFileSync(join(pkg, ".settings.json"), "utf8")).title).toBe("After");
  expect(existsSync(join(dir, ".opencode/plugins/demo"))).toBe(true);

  for (const path of ["references/docs", "work/repos/example", ".opencode/plugins/other"]) expect(existsSync(join(dir, path))).toBe(false);
});

test("sync of an office that is a Git worktree excludes plugin clones in the exclude file its repository shares", async () => {
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
  writeFileSync(exclude, "# mine\n/.office-plugin-*/\n");
  writeFileSync(join(office, "office.yaml"), `name: t\nplugins: [{ name: demo, repo: ${upstream} }]\n`);

  const changes = await sync(loadOffice(office));

  expect(changes.filter(line => line.startsWith("FAILED"))).toEqual([]);
  expect(changes).toContain("excluded /.opencode/plugins/demo/ from commits (.git/info/exclude)");
  expect(readFileSync(join(office, ".opencode/plugins/demo/index.js"), "utf8")).toBe("export default {}\n");
  expect(readFileSync(exclude, "utf8")).toBe("# mine\n/.office-plugin-*/\n/.opencode/plugins/demo/\n");
  expect(git(["status", "--porcelain"], office)).not.toContain(".opencode/plugins/demo");
  expect((await sync(loadOffice(office))).filter(line => line.includes("exclude"))).toEqual([]);
  expect(readFileSync(exclude, "utf8")).toBe("# mine\n/.office-plugin-*/\n/.opencode/plugins/demo/\n");
});
