// `office skills update` and `office packages update`, run as the CLI against local Git
// repositories: each moves only its own pins, along branches and stable SemVer tags, and a failure
// leaves a group or package as it was.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { git } from "../git.ts";

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

function record(path: string): { commit: string; ref: string | null } {
  return JSON.parse(read(join(dir, "office", path, ".source.json")));
}

const skill = (text: string) => `---\nname: x\ndescription: ${text}\n---\n${text}\n`;

test("refresh keeps both updated pins through full sync and stops before up on a failed reference", () => {
  const repo = join(dir, "upstream");
  const old = commit(repo, { "demo/package.yaml": "name: demo\ndescription: Before\n", "x/SKILL.md": skill("Before") });
  const next = commit(repo, { "demo/package.yaml": "name: demo\ndescription: After\n", "x/SKILL.md": skill("After") });

  write(join(dir, "office/office.yaml"), `name: test\nstate: ${dir}/state\npackages:\n  - { name: demo, repo: ${repo}, ref: ${old}, track: main, path: demo }\nskills:\n  copied:\n    - { repo: ${repo}, ref: ${old}, track: main, skills: [x] }\nreferences: [{ name: missing, url: ${dir}/missing }]\n`);
  const result = office("refresh");

  expect(result.status).toBe(1);
  expect(result.out).toContain("packages: done: 1 updated");
  expect(result.out).toContain("skills: done: 1 updated");
  expect(result.out).toContain("sync: FAILED");
  expect(result.out).not.toContain("services:");
  expect(result.out).not.toContain("check:");
  expect(record(".office/packages/demo").commit).toBe(next);
  expect(record("skills/x").commit).toBe(next);
  expect(read(join(dir, "office/office.yaml"))).not.toContain(old);
});

test("skills update moves each tracked group along its tags or branch, all its copies at once, and touches no package, reference or untracked pin", () => {
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
  const pkgOne = commit(pkg, { "demo/package.yaml": "name: demo\ndescription: Demo.\n" }, "v1.0.0");
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

  const synced = office("sync");

  expect(synced.status).toBe(0);
  // Sync applies pins without moving them.
  expect(record("skills/alpha").commit).toBe(v290);
  expect(record("skills/gamma").commit).toBe(gammaOne);
  expect(read(join(dir, "office/skills/alpha/LICENSE"))).toBe("MIT\n");

  const gammaTwo = commit(other, { "tools/gamma-skill/SKILL.md": skill("gamma two") });

  commit(pkg, { "demo/package.yaml": "name: demo\ndescription: Demo two.\n" }, "v1.1.0");
  commit(reference, { "README.md": "two\n" });

  const referenceHead = git(["rev-parse", "HEAD"], join(dir, "office/references/ref"));
  const before = read(join(dir, "office/office.yaml"));
  const updated = office("skills", "update");

  expect(updated.err).toBe("");
  expect(updated.status).toBe(0);
  expect(updated.out).toContain("office skills update: office t");
  expect(updated.out).toContain("skills: checking alpha, beta (v2.*)");
  expect(updated.out).toContain("skills: done: 2 updated");
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
  expect(office("skills", "update").out).toContain(`already at ${v2100.slice(0, 12)}`);
});

test("a group missing a skill at the new tag, edited where it would be replaced, or matching no tag keeps its pin and every copy", () => {
  const skills = join(dir, "skills-repo");
  const v100 = commit(skills, { "alpha/SKILL.md": skill("alpha 1.0"), "beta/SKILL.md": skill("beta 1.0") }, "v1.0.0");
  const config = (track: string) => `name: t\nstate: ${join(dir, "state")}\nskills:\n  copied:\n    - repo: ${skills}\n      ref: ${v100}\n      track: '${track}'\n      skills: [alpha, beta]\n`;

  write(join(dir, "office/office.yaml"), config("v1.*"));
  expect(office("sync").status).toBe(0);

  // v1.1.0 drops beta: the whole group stays at v1.0.0, alpha included.
  commit(skills, { "alpha/SKILL.md": skill("alpha 1.1"), beta: null }, "v1.1.0");

  const before = read(join(dir, "office/office.yaml"));
  const missing = office("skills", "update");

  expect(missing.status).toBe(1);
  expect(missing.err).toContain("office skills update: stopped:");
  expect(missing.out).toContain("skills: FAILED: 0 updated, 1 failed");
  expect(missing.out).toContain("FAILED skills alpha, beta");
  expect(missing.out).toContain("tag v1.1.0");
  expect(missing.out).toContain("has no beta/SKILL.md");
  expect(missing.out).toContain(`pin left at ${v100.slice(0, 12)}`);
  expect(read(join(dir, "office/office.yaml"))).toBe(before);
  expect(read(join(dir, "office/skills/alpha/SKILL.md"))).toBe(skill("alpha 1.0"));

  // v1.2.0 has both again, but beta was edited here: nothing changes until the edit goes.
  const v120 = commit(skills, { "alpha/SKILL.md": skill("alpha 1.2"), "beta/SKILL.md": skill("beta 1.2") }, "v1.2.0");

  write(join(dir, "office/skills/beta/SKILL.md"), "edited here\n");

  const edited = office("skills", "update");

  expect(edited.status).toBe(1);
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
  expect(office("skills", "update").status).toBe(0);
  expect(record("skills/alpha").commit).toBe(v120);
  expect(read(join(dir, "office/office.yaml"))).toContain(`ref: ${v120}`);

  // A pattern no stable tag matches leaves the pin alone.
  write(join(dir, "office/office.yaml"), config("v9.*").replace(v100, v120));

  const none = office("skills", "update");

  expect(none.status).toBe(1);
  expect(none.out).toContain("no stable SemVer tag");
  expect(none.out).toContain("matches v9.*");
  expect(read(join(dir, "office/office.yaml"))).toContain(`ref: ${v120}`);

  // A pin changed by hand is what sync applies, and sync doesn't advance it along the track.
  write(join(dir, "office/office.yaml"), config("v1.*"));
  expect(office("sync").status).toBe(0);
  expect(record("skills/alpha").commit).toBe(v100);
  expect(read(join(dir, "office/skills/beta/SKILL.md"))).toBe(skill("beta 1.0"));
  expect(read(join(dir, "office/office.yaml"))).toBe(config("v1.*"));
});

test("packages update advances tracked packages to a full SHA and applies them as sync does, leaving skill pins and failed packages alone", () => {
  const pkg = join(dir, "package-repo");
  const skills = join(dir, "skills-repo");
  const manifest = (text: string) => `name: demo\ndescription: ${text}\nsettings:\n  greeting:\n    description: A greeting\n    default: hi\n`;
  const pkgOne = commit(pkg, { "demo/package.yaml": manifest("one"), "fixed/package.yaml": "name: fixed\ndescription: Fixed.\n" }, "v1.0.0");
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
`,
  );
  expect(office("sync").status).toBe(0);

  const pkgTwo = commit(pkg, { "demo/package.yaml": manifest("two"), "demo/template/notes/DEMO.md": "from demo\n" }, "v1.1.0");

  commit(skills, { "alpha/SKILL.md": skill("alpha two") }, "v1.1.0");

  const updated = office("packages", "update");

  expect(updated.err).toBe("");
  expect(updated.status).toBe(0);
  expect(updated.out).toContain("packages: applying packages");
  expect(updated.out).toContain("packages: done: 1 updated");
  expect(updated.out).toContain(`package demo: pinned ${pkgOne.slice(0, 12)} → ${pkgTwo} (tag v1.1.0, the highest of 2 stable tags matching v1.*)`);
  expect(updated.out).toContain("package fixed: pinned");
  expect(read(join(dir, "office/office.yaml"))).toContain(`    ref: ${pkgTwo}\n    track: 'v1.*'`);
  expect(read(join(dir, "office/office.yaml"))).toContain("  # Follows the v1 line.\n");
  expect(record(".office/packages/demo")).toMatchObject({ commit: pkgTwo, ref: pkgTwo });
  // Applied as sync applies a package: its template file is created.
  expect(read(join(dir, "office/notes/DEMO.md"))).toBe("from demo\n");
  expect(record(".office/packages/fixed").commit).toBe(pkgOne);
  // Skill pins and copies wait for office skills update.
  expect(record("skills/alpha").commit).toBe(skillOne);
  expect(read(join(dir, "office/office.yaml"))).toContain(`ref: ${skillOne}`);

  // A release without the package keeps the pin and the installed copy.
  commit(pkg, { demo: null }, "v1.2.0");

  const failed = office("packages", "update");

  expect(failed.status).toBe(1);
  expect(failed.err).toContain("office packages update: stopped:");
  expect(failed.out).toContain("FAILED package demo: found ");
  expect(failed.out).toContain("(tag v1.2.0, the highest of 3 stable tags matching v1.*), but");
  expect(failed.out).toContain(`pin left at ${pkgTwo.slice(0, 12)}`);
  expect(read(join(dir, "office/office.yaml"))).toContain(`ref: ${pkgTwo}`);
  expect(record(".office/packages/demo").commit).toBe(pkgTwo);
});

test("help names both update commands, and office.yaml refuses a track without a repository", () => {
  expect(office("--help").out).toContain("skills update");
  expect(office("--help").out).toContain("packages update");
  write(join(dir, "office/office.yaml"), "name: t\npackages:\n  - name: knowledge\n    track: main\n");
  expect(office("packages", "update").err).toContain("track needs repo, path and ref");
  write(join(dir, "office/office.yaml"), "name: t\nskills:\n  copied:\n    - { repo: r, ref: x, skills: [a] }\n    - { name: a, repo: r, path: a }\n");
  expect(office("skills", "update").err).toContain("lists a skill name twice");
});
