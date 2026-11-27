// `office packages update`, run in-process against local Git repositories (and `office refresh` as
// the CLI, for its output): it moves only package pins, along branches and stable SemVer tags, and a
// failure leaves a package as it was.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { git } from "../git.ts";
import { loadOffice } from "../office.ts";
import { silentStage, type Stage } from "../report/index.ts";
import { editLock, readLockSection } from "../versions.ts";
import { updatePackages } from "./pins.ts";
import { syncLines as sync } from "../sync.fixture.ts";
import { definitionText, markingDefinition, packageJsonText, settingsSchema } from "../test-package.ts";
import { readAppliedSettings } from "../../sdk/applied-settings.ts";
import { toolPath } from "../tool.ts";

/** office.lock's `packages:` section in the office at `dir`, as an object. */
const readPackageLock = (dir: string) => Object.fromEntries(readLockSection(dir, "packages"));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-pins-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** A repository with `files`, committed (and tagged with `tag`) in that state; returns the commit. */
function commit(repo: string, files: Record<string, string | null>, tag?: string): string {
  if (!existsSync(join(repo, ".git"))) git(["init", "--quiet", "--initial-branch", "main", repo]);

  for (const [path, content] of Object.entries(files)) {
    if (content === null) rmSync(join(repo, path), { recursive: true, force: true });
    else write(join(repo, path), content);
  }

  git(["add", "--all"], repo);
  git([...identity, "commit", "--quiet", "--allow-empty", "-m", tag ?? "change"], repo);

  if (tag !== undefined) git([...identity, "tag", "-a", tag, "-m", tag], repo);

  return git(["rev-parse", "HEAD"], repo);
}

function office(...args: string[]) {
  const run = Bun.spawnSync([process.execPath, toolPath("src/cli.ts"), "--office", join(dir, "office"), ...args], { env: { ...process.env, NO_COLOR: "1" }, cwd: dir });

  return { status: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}

/**
 * `office packages update` in-process: `ok` is false where the CLI exits 1,
 * and `out` holds the stage's lines (details, notes, errors, then "done: …" or "FAILED: …").
 */
async function update() {
  const lines: string[] = [];
  const stage: Stage = { ...silentStage, detail: (text) => lines.push(text), note: (text) => lines.push(text), warn: (text) => lines.push(text), error: (text) => lines.push(text), done: (summary) => lines.push(`done: ${summary}`), fail: (reason) => lines.push(`FAILED: ${reason}`) };

  try {
    await updatePackages(loadOffice(join(dir, "office")), stage);

    return { ok: true, out: lines.join("\n") };
  } catch (error) {
    // What the CLI reports as "stopped:" before exiting 1; anything else is a bug the test should show.
    if (!(error instanceof Error && error.message === "Fix the failures above and run the update again")) throw error;

    return { ok: false, out: lines.join("\n") };
  }
}

/** `office sync` in-process (or `office sync --packages`), as the CLI would succeed: no FAILED line. */
async function synced(scope: "all" | "packages" = "all") {
  const changes = await sync(loadOffice(join(dir, "office")), { scope });

  expect(changes.filter((line) => line.startsWith("FAILED"))).toEqual([]);
}

function record(path: string): { commit: string; ref: string | null } {
  return JSON.parse(read(join(dir, "office", path, ".source.json")));
}

test("refresh keeps the updated pin through full sync, skips skills without the skills package, and stops before up on a failed reference", () => {
  const repo = join(dir, "upstream");
  const old = commit(repo, { "demo/package.json": packageJsonText("demo", "package.yaml"), "demo/package.yaml": "# Before\n{}\n" });
  const next = commit(repo, { "demo/package.yaml": "# After\n{}\n" });

  write(join(dir, "office/office.yaml"), `name: test\nstate: ${dir}/state\npackages:\n  - { name: demo, repo: ${repo}, ref: ${old}, track: main, path: demo }\nreferences: [{ name: missing, url: ${dir}/missing }]\n`);
  const result = office("refresh");

  expect(result.status).toBe(1);
  expect(result.out).toContain("office refresh: office test");
  expect(result.err).toContain("office refresh: stopped:");
  expect(result.out).toContain("packages: done: 1 updated");
  expect(result.out).toContain("skills: done: the skills package isn't selected");
  expect(result.out).toContain("sync: FAILED");
  expect(result.out).not.toContain("services:");
  expect(result.out).not.toContain("check:");
  expect(record(".office/packages/demo").commit).toBe(next);
  expect(read(join(dir, "office/office.yaml"))).not.toContain(old);
});

test("packages update advances tracked packages to a full SHA and moves untracked tags in office.lock, applying them as sync does, leaving full-SHA pins and failed packages alone", async () => {
  const pkg = join(dir, "package-repo");
  const manifest = (text: string) => `# ${text}\nsettings: {type: object, additionalProperties: false, properties: {greeting: {type: string, default: hi}}}\n`;
  const pkgOne = commit(pkg, { "demo/package.json": packageJsonText("demo", "package.yaml"), "fixed/package.json": packageJsonText("fixed", "package.yaml"), "tagged/package.json": packageJsonText("tagged", "package.yaml"), "demo/package.yaml": manifest("one"), "fixed/package.yaml": "# Fixed.\n{}\n", "tagged/package.yaml": "# Tagged.\n{}\n" }, "v1.0.0");

  write(
    join(dir, "office/office.yaml"),
    `name: t
state: ${join(dir, "state")}
packages:
  # Follows the v1 line.
  - name: demo
    repo: ${pkg}
    path: demo
    ref: "${pkgOne}"
    track: 'v1.*'
  - name: fixed
    repo: ${pkg}
    path: fixed
    ref: ${pkgOne}
  - name: tagged
    repo: ${pkg}
    path: tagged
    ref: v1.0.0
`,
  );
  await synced();
  const locked = { demo: { repo: pkg, path: "demo", ref: pkgOne, commit: pkgOne }, fixed: { repo: pkg, path: "fixed", ref: pkgOne, commit: pkgOne }, tagged: { repo: pkg, path: "tagged", ref: "v1.0.0", commit: pkgOne } };

  expect(readPackageLock(join(dir, "office"))).toEqual(locked);

  const pkgTwo = commit(pkg, { "demo/package.json": packageJsonText("demo"), "demo/package.yaml": null, "demo/office.ts": markingDefinition("notes/DEMO.md", "from demo\n", `settings: ${settingsSchema({ greeting: "hi" })}`), "tagged/package.yaml": "# Tagged two.\n{}\n" }, "v1.1.0");

  // The untracked tag moves to the new commit.
  git([...identity, "tag", "-f", "-a", "v1.0.0", "-m", "moved"], pkg);

  const yaml = read(join(dir, "office/office.yaml"));
  const updated = await update();

  expect(updated.ok).toBe(true);
  expect(updated.out).toContain("applying packages");
  expect(updated.out).toContain("done: 2 updated");
  expect(updated.out).toContain(`package demo: pinned ${pkgOne.slice(0, 12)} → ${pkgTwo} (tag v1.1.0, the highest of 2 stable tags matching v1.*)`);
  expect(updated.out).toContain(`package tagged: locked ${pkgOne.slice(0, 12)} → ${pkgTwo} (tag v1.0.0; office.yaml unchanged)`);
  expect(updated.out).toContain("package fixed: pinned");
  expect(read(join(dir, "office/office.yaml"))).toBe(yaml.replace(`ref: "${pkgOne}"`, `ref: ${pkgTwo}`));
  // The tracked ref and its lock entry move together; the untracked tag moves in the lock only; a full SHA stays.
  expect(readPackageLock(join(dir, "office"))).toEqual({ ...locked, demo: { ...locked.demo, ref: pkgTwo, commit: pkgTwo }, tagged: { ...locked.tagged, commit: pkgTwo } });
  expect(record(".office/packages/tagged")).toMatchObject({ ref: "v1.0.0", commit: pkgTwo });
  expect(read(join(dir, "office/office.yaml"))).toContain("  # Follows the v1 line.\n");
  expect(record(".office/packages/demo")).toMatchObject({ commit: pkgTwo, ref: pkgTwo });
  // Applied as sync applies a package: its sync function runs.
  expect(read(join(dir, "office/notes/DEMO.md"))).toBe("from demo\n");
  expect(record(".office/packages/fixed").commit).toBe(pkgOne);

  // A release without the package keeps the pin and the installed copy.
  commit(pkg, { demo: null }, "v1.2.0");

  const failed = await update();

  expect(failed.ok).toBe(false);
  expect(failed.out).toContain("FAILED package demo: found ");
  expect(failed.out).toContain("(tag v1.2.0, the highest of 3 stable tags matching v1.*), but");
  expect(failed.out).toContain(`pin left at ${pkgTwo.slice(0, 12)}`);
  expect(failed.out).toContain(`package tagged: v1.0.0 still at ${pkgTwo.slice(0, 12)} (tag v1.0.0)`);
  expect(read(join(dir, "office/office.yaml"))).toContain(`ref: ${pkgTwo}`);
  expect(record(".office/packages/demo").commit).toBe(pkgTwo);
});

test("packages update publishes a missing lock entry again from the installed copy already at the tag's commit", async () => {
  const pkg = join(dir, "package-repo");
  const pkgOne = commit(pkg, { "tagged/package.json": packageJsonText("tagged", "package.yaml"), "tagged/package.yaml": "# Tagged.\n{}\n" }, "v1.0.0");

  write(join(dir, "office/office.yaml"), `name: t\nstate: ${join(dir, "state")}\npackages:\n  - { name: tagged, repo: ${pkg}, path: tagged, ref: v1.0.0 }\n`);
  await synced();
  expect(readPackageLock(join(dir, "office"))).toEqual({ tagged: { repo: pkg, path: "tagged", ref: "v1.0.0", commit: pkgOne } });

  const copied = record(".office/packages/tagged");

  editLock(join(dir, "office"), (sections) => {
    sections.packages = new Map();
  });
  const relocked = await update();

  expect(relocked.ok).toBe(true);
  expect(relocked.out).toContain(`package tagged: locked (none) → ${pkgOne} (tag v1.0.0; office.yaml unchanged)`);
  expect(readPackageLock(join(dir, "office"))).toEqual({ tagged: { repo: pkg, path: "tagged", ref: "v1.0.0", commit: pkgOne } });
  expect(record(".office/packages/tagged")).toEqual(copied);
});

test("a pending peer setting and duplicate requirements reject the staged tree; repaired installers advance together", async () => {
  const repo = join(dir, "installers");
  const root = join(dir, "office");
  const yaml = join(root, "office.yaml");
  const names = ["alpha", "bravo"];

  const installer = (name: string, destination: string, extra = "") => definitionText(`{setup(c){
    c.add(installs,{name:"install",description:"Install",script:"run.ts",destination:"${destination}",ready:"${destination}",executable:false});
    ${extra}
  }}`, `import {installs} from "@office/mise-integration/claims"; import {requirements} from "@office/tooling/requirements";`);

  const alpha = installer("alpha", "~/.local/alpha");
  const dependencies = ["mise-integration", "tooling"];
  const first = commit(repo, { "alpha/package.json": packageJsonText("alpha", "office.ts", { dependencies }), "bravo/package.json": packageJsonText("bravo", "office.ts", { dependencies }), "alpha/office.ts": alpha, "bravo/office.ts": installer("bravo", "~/.local/bravo"), "alpha/run.ts": "// original", "bravo/run.ts": "// original" });
  write(yaml, `name: test\nopencode: {mode: host, url: 'http://127.0.0.1:49999'}\npackages:\n  - {name: browser, settings: {browse: false}}\n${names.map(name => `  - {name: ${name}, repo: ${repo}, ref: ${first}, track: main, path: ${name}}`).join("\n")}\n`);
  await synced("packages");
  write(yaml, read(yaml).replace("browse: false", "browse: true"));
  const receipts = ["office.yaml", ".office/resolved/references.json", ".office/mise/alpha.toml", ".office/packages/alpha/.source.json", ".office/packages/alpha/run.ts", ".office/packages/alpha/office.ts"];
  const stamp = () => receipts.map(path => read(join(root, path)));
  // Hold bravo on the old ref while alpha's candidate is invalid.
  git(["branch", "hold", first], repo);
  const selected = read(yaml);
  write(yaml, selected.replace("track: main, path: bravo", "track: hold, path: bravo"));
  const before = stamp();

  const candidates: [code: string, problem: string, script: string | null][] = [
    [installer("alpha", "~/.local/bin/browse"), "claimed by both package browser and package alpha", "// rejected"],
    [installer("alpha", "~/.local/alpha", `for(const v of ["1.1","1.2"])c.add(requirements,{name:"widget",minimumVersion:v})`), "tooling.requirements widget added twice by package alpha", "// rejected"],
    // The install's script is gone from the candidate.
    [alpha, "run.ts must be a file inside package alpha", null],
  ];

  for (const [code, problem, script] of candidates) {
    commit(repo, { "alpha/office.ts": code, "alpha/run.ts": script });
    const rejected = await update();
    expect(rejected.ok).toBe(false);
    expect(rejected.out).toContain(problem);
    expect(stamp()).toEqual(before);
  }

  const next = commit(repo, { "alpha/office.ts": alpha, "alpha/run.ts": "// repaired", "bravo/run.ts": "// new" });

  // A valid tree must also roll back if the pin editor refuses a YAML alias.
  write(yaml, read(yaml).replace(`ref: ${first}`, "ref: *original").replace("packages:", `references: [{name: fixture, url: &original "${first}"}]\npackages:`));
  const aliased = stamp();
  expect((await update()).out).toContain("by hand");
  expect(stamp()).toEqual(aliased);
  write(yaml, selected);
  expect((await update()).out).toContain("done: 2 updated");

  for (const name of names) expect(record(`.office/packages/${name}`).commit).toBe(next);
});

test("help names packages update and no longer skills.copied, and office.yaml refuses a track without a repository and the removed skills keys", () => {
  const help = office("--help").out;

  expect(help).toContain("packages update");
  expect(help).not.toContain("skills.copied");
  write(join(dir, "office/office.yaml"), "name: t\npackages:\n  - name: knowledge\n    track: main\n");
  expect(() => loadOffice(join(dir, "office"))).toThrow("track needs repo, path and ref");
  write(join(dir, "office/office.yaml"), "name: t\nskills:\n  enabled: [a]\n");
  expect(() => loadOffice(join(dir, "office"))).toThrow("skills");
});

test.each([true, false])("packages update holds back a package that declares a dependency on a rejected one (declared: %p)", async (declared) => {
  const repo = join(dir, "pair");
  const yaml = join(dir, "office", "office.yaml");
  const manifest = (name: string, text: string) => `# ${text}\n{}\n`;
  const json = packageJsonText("good", "package.yaml", { dependencies: declared ? ["bad"] : [] });
  const first = commit(repo, { "good/package.json": json, "good/package.yaml": manifest("good", "One."), "bad/package.json": packageJsonText("bad", "package.yaml"), "bad/package.yaml": manifest("bad", "One.") });
  write(yaml, `name: test\npackages:\n${["good", "bad"].map(name => `  - {name: ${name}, repo: ${repo}, ref: ${first}, track: main, path: ${name}}`).join("\n")}\n`);
  await synced("packages");
  const lock = read(join(dir, "office", "office.lock"));
  // The newer commit changes good and loses bad's folder, so bad's copy fails.
  const next = commit(repo, { "good/package.yaml": manifest("good", "Two."), bad: null });

  expect((await update()).ok).toBe(false);
  expect(record(".office/packages/bad").commit).toBe(first);

  if (declared) {
    expect(record(".office/packages/good").commit).toBe(first);
    expect(read(yaml)).not.toContain(next);
    expect(read(join(dir, "office", "office.lock"))).toBe(lock);
  } else {
    expect(record(".office/packages/good").commit).toBe(next);
    expect(read(yaml)).toContain(`{name: good, repo: ${repo}, ref: ${next}`);
    expect(read(join(dir, "office", "office.lock"))).toContain(next);
  }
});

test("packages update holds back only the package whose newer commit fails the check before loading", async () => {
  const repo = join(dir, "checked");
  const yaml = join(dir, "office", "office.yaml");
  const manifest = (name: string, text: string) => `# ${text}\n{}\n`;
  const first = commit(repo, Object.fromEntries(["alpha", "beta"].flatMap(name => [[`${name}/package.json`, packageJsonText(name, "package.yaml")], [`${name}/package.yaml`, manifest(name, "One.")]])));
  write(yaml, `name: test\npackages:\n${["alpha", "beta"].map(name => `  - {name: ${name}, repo: ${repo}, ref: ${first}, track: main, path: ${name}}`).join("\n")}\n`);
  await synced("packages");
  // alpha's newer commit declares a dependency office.yaml doesn't select; beta's only changes.
  const next = commit(repo, { "alpha/package.json": packageJsonText("alpha", "package.yaml", { dependencies: ["absent"] }), "alpha/package.yaml": manifest("alpha", "Two."), "beta/package.yaml": manifest("beta", "Two.") });

  const updated = await update();
  expect(updated.ok).toBe(false);
  expect(updated.out).toContain("FAILED package alpha: found");
  expect(updated.out).toContain("depends on @office/absent, which isn't selected");
  expect(record(".office/packages/alpha").commit).toBe(first);
  expect(record(".office/packages/beta").commit).toBe(next);
  expect(read(yaml)).toContain(`{name: alpha, repo: ${repo}, ref: ${first}`);
  expect(read(yaml)).toContain(`{name: beta, repo: ${repo}, ref: ${next}`);
});

test("packages update retries without a provider whose newer commit fails setup and the package that adds to it; the healthy one advances, and the old copy still runs", async () => {
  const repo = join(dir, "coupled");
  const yaml = join(dir, "office", "office.yaml");
  const names = ["provider", "consumer", "healthy"];
  const provider = (extra: string) => definitionText(`{setup(c){c.registry(items);${extra}},commands:{"provider show":{summary:"show",run({entries}){console.log("entries:" + entries(items).map(e => e.value.name).join(","))}}}}`, 'import {items} from "./items.ts";');
  const consumer = (name: string) => definitionText(`{setup(c){c.add(items,{name:"${name}"})}}`, 'import {items} from "@office/provider/items";');

  const first = commit(repo, {
    "provider/package.json": packageJsonText("provider", "office.ts", { exports: { "./items": "./items.ts" } }),
    "provider/items.ts": 'export const items = {id: "provider.items", parse: i => i};',
    "provider/office.ts": provider(""),
    "consumer/package.json": packageJsonText("consumer", "office.ts", { dependencies: ["provider"] }),
    "consumer/office.ts": consumer("one"),
    "healthy/package.json": packageJsonText("healthy", "package.yaml"),
    "healthy/package.yaml": "# One.\n{}\n",
  });

  write(yaml, `name: test\npackages:\n${names.map(name => `  - {name: ${name}, repo: ${repo}, ref: ${first}, track: main, path: ${name}}`).join("\n")}\n`);
  await synced("packages");
  expect(office("provider", "show").out).toBe("entries:one\n");
  const next = commit(repo, { "provider/office.ts": provider('throw Error("broken provider")'), "consumer/office.ts": consumer("two"), "healthy/package.yaml": "# Two.\n{}\n" });

  const updated = await update();
  expect(updated.ok).toBe(false);
  expect(updated.out).toContain("broken provider");

  for (const name of ["provider", "consumer"]) {
    expect(record(`.office/packages/${name}`).commit).toBe(first);
    expect(read(yaml)).toContain(`{name: ${name}, repo: ${repo}, ref: ${first}`);
    expect(readPackageLock(join(dir, "office"))[name].commit).toBe(first);
  }

  expect(record(".office/packages/healthy").commit).toBe(next);
  expect(read(yaml)).toContain(`{name: healthy, repo: ${repo}, ref: ${next}`);
  expect(readPackageLock(join(dir, "office")).healthy.commit).toBe(next);
  // The refused replacement leaves the installed copy, whose command still runs.
  expect(office("provider", "show").out).toBe("entries:one\n");
});

test("an update that doesn't apply still records the references its switch resolved, and publishes no settings", async () => {
  const repo = join(dir, "recorded");
  const yaml = join(dir, "office", "office.yaml");
  const docs = (name: string) => definitionText(`{settings:{type:"object",properties:{edition:{type:"string",default:"${name}"}}},setup(c){c.add(repositories,{name:"${name}",url:"https://example.invalid/${name}.git"})}}`, 'import {repositories} from "@office/references/repositories";');
  const first = commit(repo, { "docs/package.json": packageJsonText("docs", "office.ts", { dependencies: ["references"] }), "docs/office.ts": docs("old-docs") });
  write(yaml, `name: test\npackages:\n  - {name: docs, repo: ${repo}, ref: ${first}, track: main, path: docs}\n`);
  await synced("packages");
  const applied = join(dir, "office", ".office/resolved/references.json");
  expect(read(applied)).toContain("old-docs");
  commit(repo, { "docs/office.ts": docs("new-docs") });

  await updatePackages(loadOffice(join(dir, "office")), silentStage, { apply: false });
  expect(read(applied)).toContain("new-docs");
  expect(read(applied)).not.toContain("old-docs");
  expect(readAppliedSettings(join(dir, "office"), "docs")).toEqual({ edition: "old-docs" });
  await synced("packages");
  expect(readAppliedSettings(join(dir, "office"), "docs")).toEqual({ edition: "new-docs" });
});
