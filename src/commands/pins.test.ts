// `office skills update` and `office packages update`, run in-process against local Git
// repositories (and `office refresh` as the CLI, for its output): each moves only its own pins, along
// branches and stable SemVer tags, and a failure leaves a group or package as it was.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { git } from "../git.ts";
import { loadOffice } from "../office.ts";
import { silentStage, type Stage } from "../report/index.ts";
import { editLock, readLockSection } from "../versions.ts";
import { updatePackages, updateSkills } from "./pins.ts";
import { sync } from "./sync.ts";
import { definitionText, packageJsonText } from "../test-package.ts";

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
  const run = Bun.spawnSync([process.execPath, join(import.meta.dir, "../cli.ts"), "--office", join(dir, "office"), ...args], { env: { ...process.env, NO_COLOR: "1" }, cwd: dir });

  return { status: run.exitCode, out: run.stdout.toString(), err: run.stderr.toString() };
}

/**
 * `office skills update` or `office packages update` in-process: `ok` is false where the CLI exits 1,
 * and `out` holds the stage's lines (details, notes, errors, then "done: …" or "FAILED: …").
 */
async function update(command: "skills" | "packages") {
  const lines: string[] = [];
  const stage: Stage = { ...silentStage, detail: (text) => lines.push(text), note: (text) => lines.push(text), warn: (text) => lines.push(text), error: (text) => lines.push(text), done: (summary) => lines.push(`done: ${summary}`), fail: (reason) => lines.push(`FAILED: ${reason}`) };

  try {
    await (command === "skills" ? updateSkills : updatePackages)(loadOffice(join(dir, "office")), stage);

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

const skill = (text: string) => `---\nname: x\ndescription: ${text}\n---\n${text}\n`;

test("refresh keeps both updated pins through full sync and stops before up on a failed reference", () => {
  const repo = join(dir, "upstream");
  const old = commit(repo, { "demo/package.json": packageJsonText("demo", "package.yaml"), "demo/package.yaml": "# Before\n{}\n", "x/SKILL.md": skill("Before") });
  const next = commit(repo, { "demo/package.yaml": "# After\n{}\n", "x/SKILL.md": skill("After") });

  write(join(dir, "office/office.yaml"), `name: test\nstate: ${dir}/state\npackages:\n  - { name: demo, repo: ${repo}, ref: ${old}, track: main, path: demo }\nskills:\n  copied:\n    - { repo: ${repo}, ref: ${old}, track: main, skills: [x] }\nreferences: [{ name: missing, url: ${dir}/missing }]\n`);
  const result = office("refresh");

  expect(result.status).toBe(1);
  expect(result.out).toContain("office refresh: office test");
  expect(result.err).toContain("office refresh: stopped:");
  expect(result.out).toContain("packages: done: 1 updated");
  expect(result.out).toContain("skills: done: 1 updated");
  expect(result.out).toContain("sync: FAILED");
  expect(result.out).not.toContain("services:");
  expect(result.out).not.toContain("check:");
  expect(record(".office/packages/demo").commit).toBe(next);
  expect(record("skills/x").commit).toBe(next);
  expect(read(join(dir, "office/office.yaml"))).not.toContain(old);
});

test("skills update moves each tracked group along its tags or branch, all its copies at once, and touches no package, reference or untracked pin", async () => {
  const skills = join(dir, "skills-repo");
  const other = join(dir, "other-repo");
  const pkg = join(dir, "package-repo");
  const reference = join(dir, "reference-repo");

  const v290 = commit(skills, { "skills/alpha/SKILL.md": skill("alpha 2.9"), "skills/beta/SKILL.md": skill("beta 2.9"), LICENSE: "MIT\n" }, "v2.9.0");
  const v2100 = commit(skills, { "skills/alpha/SKILL.md": skill("alpha 2.10"), "skills/beta/SKILL.md": skill("beta 2.10") }, "v2.10.0");

  // Pushed after v2.10.0, but none is a higher stable v2 release.
  commit(skills, { "skills/alpha/SKILL.md": skill("alpha rc") }, "v2.11.0-rc.1");
  commit(skills, { "skills/alpha/SKILL.md": skill("alpha 20") }, "v20.0.0");
  commit(skills, { "skills/alpha/SKILL.md": skill("alpha 3") }, "v3.0.0");

  const gammaOne = commit(other, { "tools/gamma-skill/SKILL.md": skill("gamma one") });
  const pkgOne = commit(pkg, { "demo/package.json": packageJsonText("demo", "package.yaml"), "demo/package.yaml": "# Demo.\n{}\n" }, "v1.0.0");
  const pinned = commit(skills, {});

  commit(reference, { "README.md": "one\n" });
  write(
    join(dir, "office/office.yaml"),
    `# The office.
name: t
state: ${join(dir, "state")}

references:
  - name: ref
    url: ${reference}

skills:
  enabled: []
  copied:
    # Follows v2 releases.
    - repo: ${skills}
      ref: ${v290} # moved by office skills update
      track: 'v2.*'
      base: skills
      skills: [alpha, beta]
    - { repo: ${other}, ref: ${gammaOne}, track: main, skills: [{ name: gamma, path: tools/gamma-skill }] }
    - repo: ${skills}
      ref: ${pinned}
      skills: [{ name: fixed, path: skills/alpha }]
    - { name: solo, repo: ${skills}, ref: v2.9.0, path: skills/beta }

packages:
  - name: demo
    repo: ${pkg}
    path: demo
    ref: ${pkgOne}
    track: 'v1.*'
`,
  );

  await synced();
  // Sync applies pins without moving them.
  expect(record("skills/alpha").commit).toBe(v290);
  expect(record("skills/gamma").commit).toBe(gammaOne);
  expect(read(join(dir, "office/skills/alpha/LICENSE"))).toBe("MIT\n");

  const gammaTwo = commit(other, { "tools/gamma-skill/SKILL.md": skill("gamma two") });

  commit(pkg, { "demo/package.yaml": "# Demo two.\n{}\n" }, "v1.1.0");
  commit(reference, { "README.md": "two\n" });

  const referenceHead = git(["rev-parse", "HEAD"], join(dir, "office/references/ref"));
  const before = read(join(dir, "office/office.yaml"));
  const updated = await update("skills");

  expect(updated.ok).toBe(true);
  expect(updated.out).toContain("checking alpha, beta (v2.*)");
  expect(updated.out).toContain("done: 2 updated");
  expect(updated.out).toContain(`skills alpha, beta from ${skills}: pinned ${v290.slice(0, 12)} → ${v2100} (tag v2.10.0, the highest of 2 stable tags matching v2.*)`);
  expect(updated.out).toContain(`skills gamma from ${other}: pinned ${gammaOne.slice(0, 12)} → ${gammaTwo} (branch main)`);
  expect(updated.out).toContain("skills fixed from");
  expect(updated.out).toContain("with no track, so left there");
  expect(read(join(dir, "office/skills/alpha/SKILL.md"))).toBe(skill("alpha 2.10"));
  expect(read(join(dir, "office/skills/beta/SKILL.md"))).toBe(skill("beta 2.10"));
  expect(record("skills/beta")).toMatchObject({ commit: v2100, ref: v2100 });
  expect(read(join(dir, "office/skills/gamma/SKILL.md"))).toBe(skill("gamma two"));
  // Only the two refs changed, each to a full SHA; comments, quoting and layout stay.
  expect(read(join(dir, "office/office.yaml"))).toBe(before.replace(`ref: ${v290} #`, `ref: ${v2100} #`).replace(`ref: ${gammaOne},`, `ref: ${gammaTwo},`));
  // The other category, the references and untracked pins are untouched.
  expect(record(".office/packages/demo").commit).toBe(pkgOne);
  expect(git(["rev-parse", "HEAD"], join(dir, "office/references/ref"))).toBe(referenceHead);
  expect(record("skills/fixed").commit).toBe(pinned);
  expect(record("skills/solo").commit).toBe(v290);

  // Running again finds nothing to move.
  expect((await update("skills")).out).toContain(`already at ${v2100.slice(0, 12)}`);
});

test("a group missing a skill at the new tag, edited where it would be replaced, or matching no tag keeps its pin and every copy", async () => {
  const skills = join(dir, "skills-repo");
  const v100 = commit(skills, { "alpha/SKILL.md": skill("alpha 1.0"), "beta/SKILL.md": skill("beta 1.0") }, "v1.0.0");
  const config = (track: string) => `name: t\nstate: ${join(dir, "state")}\nskills:\n  copied:\n    - repo: ${skills}\n      ref: ${v100}\n      track: '${track}'\n      skills: [alpha, beta]\n`;

  write(join(dir, "office/office.yaml"), config("v1.*"));
  await synced();

  // v1.1.0 drops beta: the whole group stays at v1.0.0, alpha included.
  commit(skills, { "alpha/SKILL.md": skill("alpha 1.1"), beta: null }, "v1.1.0");

  const before = read(join(dir, "office/office.yaml"));
  const missing = await update("skills");

  expect(missing.ok).toBe(false);
  expect(missing.out).toContain("FAILED: 0 updated, 1 failed");
  expect(missing.out).toContain("FAILED skills alpha, beta");
  expect(missing.out).toContain("tag v1.1.0");
  expect(missing.out).toContain("has no beta/SKILL.md");
  expect(missing.out).toContain(`pin left at ${v100.slice(0, 12)}`);
  expect(read(join(dir, "office/office.yaml"))).toBe(before);
  expect(read(join(dir, "office/skills/alpha/SKILL.md"))).toBe(skill("alpha 1.0"));

  // v1.2.0 has both again, but beta was edited here: nothing changes until the edit goes.
  const v120 = commit(skills, { "alpha/SKILL.md": skill("alpha 1.2"), "beta/SKILL.md": skill("beta 1.2") }, "v1.2.0");

  write(join(dir, "office/skills/beta/SKILL.md"), "edited here\n");

  const edited = await update("skills");

  expect(edited.ok).toBe(false);
  expect(edited.out).toContain("skills/beta has local edits that replacing it would lose: SKILL.md (edited)");
  expect(read(join(dir, "office/office.yaml"))).toBe(before);
  expect(read(join(dir, "office/skills/alpha/SKILL.md"))).toBe(skill("alpha 1.0"));
  expect(read(join(dir, "office/skills/beta/SKILL.md"))).toBe("edited here\n");
  expect(readFileSync(join(dir, "office/skills/alpha/.source.json"), "utf8")).toContain(v100);

  // Undone, the group moves; a copy recorded before hashes were is checked against its commit.
  write(join(dir, "office/skills/beta/SKILL.md"), skill("beta 1.0"));

  const legacy = JSON.parse(read(join(dir, "office/skills/alpha/.source.json")));

  delete legacy.files;
  write(join(dir, "office/skills/alpha/.source.json"), JSON.stringify(legacy));
  expect((await update("skills")).ok).toBe(true);
  expect(record("skills/alpha").commit).toBe(v120);
  expect(read(join(dir, "office/office.yaml"))).toContain(`ref: ${v120}`);

  // A pattern no stable tag matches leaves the pin alone.
  write(join(dir, "office/office.yaml"), config("v9.*").replace(v100, v120));

  const none = await update("skills");

  expect(none.ok).toBe(false);
  expect(none.out).toContain("no stable SemVer tag");
  expect(none.out).toContain("matches v9.*");
  expect(read(join(dir, "office/office.yaml"))).toContain(`ref: ${v120}`);
});

test("packages update advances tracked packages to a full SHA and moves untracked tags in office.lock, applying them as sync does, leaving full-SHA pins, skill pins and failed packages alone", async () => {
  const pkg = join(dir, "package-repo");
  const skills = join(dir, "skills-repo");
  const manifest = (text: string) => `# ${text}\nsettings: {type: object, additionalProperties: false, properties: {greeting: {type: string, default: hi}}}\n`;
  const pkgOne = commit(pkg, { "demo/package.json": packageJsonText("demo", "package.yaml"), "fixed/package.json": packageJsonText("fixed", "package.yaml"), "tagged/package.json": packageJsonText("tagged", "package.yaml"), "demo/package.yaml": manifest("one"), "fixed/package.yaml": "# Fixed.\n{}\n", "tagged/package.yaml": "# Tagged.\n{}\n" }, "v1.0.0");
  const skillOne = commit(skills, { "alpha/SKILL.md": skill("alpha one") }, "v1.0.0");

  write(
    join(dir, "office/office.yaml"),
    `name: t
state: ${join(dir, "state")}
skills:
  copied:
    - { repo: ${skills}, ref: ${skillOne}, track: 'v1.*', skills: [alpha] }
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

  const pkgTwo = commit(pkg, { "demo/package.yaml": manifest("two"), "demo/seed/notes/DEMO.md": "from demo\n", "tagged/package.yaml": "# Tagged two.\n{}\n" }, "v1.1.0");

  // The untracked tag moves to the new commit.
  git([...identity, "tag", "-f", "-a", "v1.0.0", "-m", "moved"], pkg);
  commit(skills, { "alpha/SKILL.md": skill("alpha two") }, "v1.1.0");

  const yaml = read(join(dir, "office/office.yaml"));
  const updated = await update("packages");

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
  // Applied as sync applies a package: its seed file is created.
  expect(read(join(dir, "office/notes/DEMO.md"))).toBe("from demo\n");
  expect(record(".office/packages/fixed").commit).toBe(pkgOne);
  // Skill pins and copies wait for office skills update.
  expect(record("skills/alpha").commit).toBe(skillOne);
  expect(read(join(dir, "office/office.yaml"))).toContain(`ref: ${skillOne}`);

  // A release without the package keeps the pin and the installed copy.
  commit(pkg, { demo: null }, "v1.2.0");

  const failed = await update("packages");

  expect(failed.ok).toBe(false);
  expect(failed.out).toContain("FAILED package demo: found ");
  expect(failed.out).toContain("(tag v1.2.0, the highest of 3 stable tags matching v1.*), but");
  expect(failed.out).toContain(`pin left at ${pkgTwo.slice(0, 12)}`);
  expect(failed.out).toContain(`package tagged: v1.0.0 still at ${pkgTwo.slice(0, 12)} (tag v1.0.0)`);
  expect(read(join(dir, "office/office.yaml"))).toContain(`ref: ${pkgTwo}`);
  expect(record(".office/packages/demo").commit).toBe(pkgTwo);

  // A lock entry gone while the copy is already at the tag's commit: the entry is published again, from the installed copy.
  const { tagged: _tagged, ...untagged } = readPackageLock(join(dir, "office"));
  const copied = record(".office/packages/tagged");

  editLock(join(dir, "office"), (sections) => {
    sections.packages = new Map(Object.entries(untagged));
  });
  const relocked = await update("packages");

  expect(relocked.out).toContain(`package tagged: locked (none) → ${pkgTwo} (tag v1.0.0; office.yaml unchanged)`);
  expect(readPackageLock(join(dir, "office")).tagged).toEqual({ ...locked.tagged, commit: pkgTwo });
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

  for (const [code, problem] of [
    [installer("alpha", "~/.local/bin/browse"), "claimed by both package browser and package alpha"],
    [installer("alpha", "~/.local/alpha", `for(const v of ["1.1","1.2"])c.add(requirements,{name:"widget",minimumVersion:v})`), "tooling.requirements widget claimed by both"],
  ]) {
    commit(repo, { "alpha/office.ts": code, "alpha/run.ts": "// rejected" });
    const rejected = await update("packages");
    expect(rejected.ok).toBe(false);
    expect(rejected.out).toContain(problem);
    expect(stamp()).toEqual(before);
  }

  const next = commit(repo, { "alpha/office.ts": alpha, "alpha/run.ts": "// repaired", "bravo/run.ts": "// new" });

  // A valid tree must also roll back if the pin editor refuses a YAML alias.
  write(yaml, read(yaml).replace(`ref: ${first}`, "ref: *original").replace("packages:", `references: [{name: fixture, url: &original "${first}"}]\npackages:`));
  const aliased = stamp();
  expect((await update("packages")).out).toContain("by hand");
  expect(stamp()).toEqual(aliased);
  write(yaml, selected);
  expect((await update("packages")).out).toContain("done: 2 updated");

  for (const name of names) expect(record(`.office/packages/${name}`).commit).toBe(next);
});

test("help names both update commands, and office.yaml refuses a track without a repository", () => {
  const help = office("--help").out;

  expect(help).toContain("skills update");
  expect(help).toContain("packages update");
  write(join(dir, "office/office.yaml"), "name: t\npackages:\n  - name: knowledge\n    track: main\n");
  expect(() => loadOffice(join(dir, "office"))).toThrow("track needs repo, path and ref");
  write(join(dir, "office/office.yaml"), "name: t\nskills:\n  copied:\n    - { repo: r, ref: x, skills: [a] }\n    - { name: a, repo: r, path: a }\n");
  expect(() => loadOffice(join(dir, "office"))).toThrow("lists a skill name twice");
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

  expect((await update("packages")).ok).toBe(false);
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

  const updated = await update("packages");
  expect(updated.ok).toBe(false);
  expect(updated.out).toContain("FAILED package alpha: found");
  expect(updated.out).toContain("depends on @office/absent, which isn't selected");
  expect(record(".office/packages/alpha").commit).toBe(first);
  expect(record(".office/packages/beta").commit).toBe(next);
  expect(read(yaml)).toContain(`{name: alpha, repo: ${repo}, ref: ${first}`);
  expect(read(yaml)).toContain(`{name: beta, repo: ${repo}, ref: ${next}`);
});
