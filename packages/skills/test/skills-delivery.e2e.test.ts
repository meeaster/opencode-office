// The skills package in the compiled office: what `office skills list` shows, what sync links into
// `.agents/skills/` and keeps out of commits, what it refuses, and what a link outlives.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../../src/git.ts";
import { definitionFixture } from "../../../test/support/package-definition.fixture.ts";
import { definitionText, pluginDefinition, writePackage } from "../../../test/support/test-package.ts";

const { root, write, read, commit, fixture } = definitionFixture({ second: false });

const skill = (name: string) => `---\nname: ${name}\ndescription: ${name} fixture\n---\n${name}\n`;

/** A Git repository at `root/<name>` holding `files`, committed on main; returns its folder and commit. */
function repository(name: string, files: Record<string, string>) {
  const repo = join(root, name);

  git(["init", "-q", "-b", "main", repo]);

  for (const [file, text] of Object.entries(files)) write(join(repo, file), text);

  return { repo, ref: commit(repo) };
}

/** The skills package's entry, with `sources` and `enabled` as YAML flow text. */
const skillsEntry = (sources: string, enabled: string) => `  - name: skills\n    settings:\n      # Sources stay as written.\n      sources: ${sources}\n      enabled: ${enabled}\n`;

test("list shows sources and enablement under setup noise; sync links whole folders, excludes exactly those links, and leaves manual skills and their sources", () => {
  const f = fixture("delivery");
  const { repo, ref } = repository("delivery-handbook", { "engineering/review/SKILL.md": skill("review"), "engineering/review/checklist.md": "check\n", "other/lint/SKILL.md": skill("lint") });
  git(["init", "-q", f.dir]);
  write(join(f.dir, "skills/alpha/SKILL.md"), skill("alpha"));
  write(join(f.dir, "skills/beta/SKILL.md"), skill("beta"));
  write(join(f.dir, ".agents/skills/manual/SKILL.md"), skill("manual"));
  // A package whose setup is noisy offers a skill folder of its own.
  writePackage(join(f.dir, "packages/noisy/office.ts"), definitionText('{setup(ctx){console.log("noise on stdout"); console.error("noise on stderr"); skills.add(ctx, {directory: "bundled/zeta"})}}', 'import {skills} from "@office/skills";'), { dependencies: ["skills"] });
  write(join(f.dir, "packages/noisy/bundled/zeta/SKILL.md"), skill("zeta"));
  const sources = `[{folder: skills}, {repo: ${repo}, ref: ${ref}, skills: [{name: review, path: engineering/review}, {name: lint, path: other/lint}]}]`;
  f.select(`${skillsEntry(sources, "[alpha, review, zeta]")}  - name: noisy\n`);

  // Selected but not synced yet, the package's commands can't run.
  expect(f.cli(1, "skills", "list")).toContain("package skills: not synced yet; run office sync");
  const synced = f.cli(0, "sync");

  expect(synced).toContain(`package skills: fetched ${repo} at ${ref.slice(0, 12)}`);
  expect(synced).toContain("package skills: linked .agents/skills/alpha (folder skills)");
  expect(readlinkSync(join(f.dir, ".agents/skills/zeta"))).toBe("../../packages/noisy/bundled/zeta");
  expect(read(join(f.dir, ".agents/skills/review/checklist.md"))).toBe("check\n");
  expect(readdirSync(join(f.dir, ".agents/skills")).sort()).toEqual(["alpha", "manual", "review", "zeta"]);

  const result = Bun.spawnSync([join(root, "bin/office"), "--office", f.dir, "skills", "list"], { cwd: root, env: f.env });
  const source = `${repo} at ${ref.slice(0, 12)}`;
  const width = source.length;

  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe([
    `alpha   ${"folder skills".padEnd(width)}  enabled`,
    `beta    ${"folder skills".padEnd(width)}  available`,
    `lint    ${source}  available`,
    `review  ${source}  enabled`,
    `zeta    ${"package noisy".padEnd(width)}  enabled`,
    "",
  ].join("\n"));
  expect(result.stderr.toString()).toContain("noise on stdout");

  // Exactly the managed links are kept out of commits; the owner's skills and folders are committed.
  const exclude = read(join(f.dir, ".git/info/exclude"));

  for (const id of ["alpha", "review", "zeta"]) expect(exclude).toContain(`\n/.agents/skills/${id}\n`);
  expect(exclude).not.toContain("/.agents/skills/manual");
  expect(git(["check-ignore", ".agents/skills/alpha"], f.dir)).toBe(".agents/skills/alpha");
  const untracked = git(["status", "--porcelain", "--untracked-files=all"], f.dir);

  expect(untracked).toContain(".agents/skills/manual/SKILL.md");
  expect(untracked).not.toMatch(/\.agents\/skills\/(alpha|review|zeta)/);
  expect(f.cli(0, "sync", "--packages")).not.toContain("package skills:");
  expect(f.cli(0, "check")).toContain("ok   package skills: built-in");

  // Disabling removes only those links; their sources, the checkout and the manual skill stay.
  f.select(`${skillsEntry(sources, "[review]")}  - name: noisy\n`);
  const disabled = f.cli(0, "sync");

  expect(disabled).toContain("package skills: unlinked .agents/skills/alpha");
  expect(disabled).toContain("package skills: unlinked .agents/skills/zeta");
  expect(readdirSync(join(f.dir, ".agents/skills")).sort()).toEqual(["manual", "review"]);
  expect(read(join(f.dir, ".git/info/exclude"))).not.toContain("/.agents/skills/alpha");
  expect(existsSync(join(f.dir, "skills/alpha/SKILL.md"))).toBe(true);
  expect(existsSync(join(f.dir, "packages/noisy/bundled/zeta/SKILL.md"))).toBe(true);
}, 60_000);

test("an occupied destination, a lost receipt or an enabled ID nobody offers stops sync before later delivery, naming it, without undoing earlier steps", () => {
  const f = fixture("refusal");
  git(["init", "-q", f.dir]);
  write(join(f.dir, "skills/alpha/SKILL.md"), skill("alpha"));
  write(join(f.dir, "skills/beta/SKILL.md"), skill("beta"));
  f.select(skillsEntry("[{folder: skills}]", "[alpha]"));
  f.cli(0, "sync");
  const exclude = read(join(f.dir, ".git/info/exclude"));

  // A dangling link of the owner's at beta's destination, and a plugin package selected since.
  symlinkSync("../../nowhere", join(f.dir, ".agents/skills/beta"));
  writePackage(join(f.dir, "packages/later/office.ts"), pluginDefinition(), { dependencies: ["opencode"] });
  write(join(f.dir, "packages/later/plugin/index.js"), "export default {}\n");
  f.select(`${skillsEntry("[{folder: skills}]", "[alpha, beta, ghost]")}  - name: later\n`);
  const stopped = f.cli(1, "sync");

  expect(stopped).toContain("package skills: its sync failed: no skill link changed: skill ghost is enabled, but no source offers it; .agents/skills/beta is already there and isn't a link this package recorded");
  // Earlier steps stay done: the new package set is active; later ones didn't run.
  expect(stopped).toContain("the new package set is active and the rest of this sync did not run");
  expect(existsSync(join(f.dir, ".opencode/plugins/later"))).toBe(false);
  expect(readlinkSync(join(f.dir, ".agents/skills/beta"))).toBe("../../nowhere");
  expect(read(join(f.dir, ".git/info/exclude"))).toBe(exclude);

  // Without its receipt, the package's own link counts as the owner's: reported, never taken over.
  rmSync(join(f.dir, ".agents/skills/beta"));
  rmSync(join(f.dir, ".office/skills/links.json"));
  f.select(`${skillsEntry("[{folder: skills}]", "[alpha]")}  - name: later\n`);
  expect(f.cli(1, "sync")).toContain(".agents/skills/alpha is already there and isn't a link this package recorded");
  expect(f.cli(1, "check")).toMatch(/^FAIL package skills: \.agents\/skills\/alpha is already there/m);
  rmSync(join(f.dir, ".agents/skills/alpha"));
  f.cli(0, "sync");
  expect(readlinkSync(join(f.dir, ".agents/skills/alpha"))).toBe("../../skills/alpha");
  expect(readlinkSync(join(f.dir, ".opencode/plugins/later"))).toBe("../../packages/later/plugin");
  expect(git(["check-ignore", ".agents/skills/alpha"], f.dir)).toBe(".agents/skills/alpha");

  // The owner replaces the recorded link with a folder: sync refuses and stops, and Git shows the
  // folder, while every other exclusion stays.
  const excluded = read(join(f.dir, ".git/info/exclude"));
  rmSync(join(f.dir, ".agents/skills/alpha"));
  write(join(f.dir, ".agents/skills/alpha/SKILL.md"), skill("owner"));
  const replaced = f.cli(1, "sync");

  expect(replaced).toContain(".agents/skills/alpha is already there and isn't a link this package recorded");
  expect(replaced).toContain("the rest of this sync did not run");
  expect(git(["status", "--porcelain", "--untracked-files=all"], f.dir)).toContain(".agents/skills/alpha/SKILL.md");
  expect(git(["check-ignore", ".opencode/plugins/later"], f.dir)).toBe(".opencode/plugins/later");
  expect(read(join(f.dir, ".git/info/exclude"))).toBe(excluded.replace("/.agents/skills/alpha\n", ""));
  expect(f.cli(1, "sync")).toContain(".agents/skills/alpha is already there");
}, 60_000);

test("a skill a pulled package offers is linked through its stable folder: the link's text and contents survive the generation it was made in", () => {
  const f = fixture("generations");
  const { repo, ref } = repository("generations-offer", { "pkg/skills/guide/SKILL.md": skill("guide"), "pkg/skills/guide/notes.md": "one\n" });
  writePackage(join(repo, "pkg/office.ts"), definitionText('{setup(ctx){skills.add(ctx, {directory: "skills/guide"})}}', 'import {skills} from "@office/skills";'), { name: "guides", dependencies: ["skills"] });
  const first = commit(repo);
  const entry = (pin: string) => `${skillsEntry("[]", "[guide]")}  - {name: guides, repo: ${repo}, path: pkg, ref: ${pin}}\n`;

  expect(first).not.toBe(ref);
  f.select(entry(first));
  f.cli(0, "sync");
  const link = join(f.dir, ".agents/skills/guide");
  const text = readlinkSync(link);
  const generation = readlinkSync(join(f.dir, ".office/current"));

  expect(text).toBe("../../.office/packages/guides/skills/guide");

  write(join(repo, "pkg/skills/guide/notes.md"), "two\n");
  f.select(entry(commit(repo)));
  f.cli(0, "sync");
  f.cli(0, "sync");
  expect(readlinkSync(join(f.dir, ".office/current"))).not.toBe(generation);
  expect(existsSync(join(f.dir, ".office", generation))).toBe(false);
  expect(readlinkSync(link)).toBe(text);
  expect(readFileSync(join(link, "notes.md"), "utf8")).toBe("two\n");
}, 60_000);
