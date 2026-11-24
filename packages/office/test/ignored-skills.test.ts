import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describeIgnoredSkills, expandFolder, ignoredFolders, ignoredSkills, inFolders, skillsIn } from "../plugin/ignored-skills.ts";

let dir: string;
let home: string;
let office: string;

function write(path: string, text = "---\nname: x\ndescription: d\n---\n"): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ignored-skills-"));
  home = join(dir, "home");
  office = join(dir, "office");
  mkdirSync(home);
  mkdirSync(office);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("a folder names ~ for the home, an absolute path, or a path from the office root", () => {
  expect(expandFolder("~/.claude/skills/synced", home, office)).toBe(join(home, ".claude/skills/synced"));
  expect(expandFolder("~", home, office)).toBe(home);
  expect(expandFolder("/srv/skills/", home, office)).toBe("/srv/skills");
  expect(expandFolder("vendor/skills", home, office)).toBe(join(office, "vendor/skills"));
});

test("the Claude app's synced folder is ignored unless the office turns that off, and the office's list adds to it", () => {
  expect(ignoredFolders({ ignore_claude_synced_skills: true, ignore_skill_folders: ["~/other/skills", "", 3, "~/.claude/skills/synced"] })).toEqual(["~/.claude/skills/synced", "~/other/skills"]);
  expect(ignoredFolders({ ignore_skill_folders: "~/other/skills" })).toEqual(["~/.claude/skills/synced"]);
  expect(ignoredFolders({ ignore_claude_synced_skills: false, ignore_skill_folders: ["~/other/skills"] })).toEqual(["~/other/skills"]);
  expect(ignoredFolders({ ignore_claude_synced_skills: false })).toEqual([]);
  expect(ignoredFolders(undefined)).toEqual(["~/.claude/skills/synced"]);
});

test("skills are found as OpenCode finds them: SKILL.md folders inside group folders, and Markdown files at the top", () => {
  const synced = join(home, ".claude/skills/synced");

  write(join(synced, "bucket-1/docx/SKILL.md"));
  write(join(synced, "bucket-1/pdf/SKILL.md"));
  write(join(synced, "bucket-2/xlsx/SKILL.md"));
  // Below a skill, nothing more is a skill.
  write(join(synced, "bucket-2/xlsx/examples/inner/SKILL.md"));
  // Not skills: no SKILL.md, hidden, a dependency folder, a Markdown file below the top.
  write(join(synced, "bucket-2/notes/README.md"));
  write(join(synced, ".cache/hidden/SKILL.md"));
  write(join(synced, "node_modules/dep/SKILL.md"));
  write(join(synced, "loose.md"));

  expect(skillsIn(synced)).toEqual([
    { id: "loose", path: join(synced, "loose.md") },
    { id: "docx", path: join(synced, "bucket-1/docx") },
    { id: "pdf", path: join(synced, "bucket-1/pdf") },
    { id: "xlsx", path: join(synced, "bucket-2/xlsx") },
  ]);
});

test("a folder that doesn't exist or holds no SKILL.md has no skills", () => {
  write(join(home, "empty/group/README.md"));

  expect(skillsIn(join(home, "missing"))).toEqual([]);
  expect(skillsIn(join(home, "empty"))).toEqual([]);
});

test("a loaded skill is in a folder by its path as written or resolved, and never a skill:// one or a neighbour", () => {
  const synced = join(home, ".claude/skills/synced");

  write(join(synced, "bucket-1/docx/SKILL.md"));
  write(join(home, ".claude/skills/synced-too/mine/SKILL.md"));
  symlinkSync(join(home, ".claude"), join(home, "linked"));

  expect(inFolders([synced], join(synced, "bucket-1/docx/SKILL.md"))).toBe(true);
  expect(inFolders([synced], join(home, ".claude/skills/synced-too/mine/SKILL.md"))).toBe(false);
  expect(inFolders([synced], join(home, ".claude/skills/other/SKILL.md"))).toBe(false);
  expect(inFolders([synced], "skill://docx/SKILL.md")).toBe(false);
  // The setting names the folder through a link and OpenCode reports the resolved path, or the reverse.
  expect(inFolders([join(home, "linked/skills/synced")], join(synced, "bucket-1/docx/SKILL.md"))).toBe(true);
  expect(inFolders([synced], join(home, "linked/skills/synced/bucket-1/docx/SKILL.md"))).toBe(true);
  expect(inFolders([], join(synced, "bucket-1/docx/SKILL.md"))).toBe(false);
});

test("every skill in the ignored folders is hidden, whatever skill of the office or of a package has its ID", () => {
  const synced = join(home, ".claude/skills/synced");

  write(join(synced, "bucket-1/docx/SKILL.md"));
  write(join(synced, "bucket-1/office/SKILL.md"));
  write(join(home, ".claude/skills/mine/SKILL.md"));
  // No folder of a package is read to guess which IDs to spare.
  write(join(office, ".office/packages/office/skills/office/SKILL.md"));

  const found = ignoredSkills(office, ["~/.claude/skills/synced", "~/missing"], home);

  expect(found).toEqual({
    folders: [synced, join(home, "missing")],
    hidden: [
      { id: "docx", path: join(synced, "bucket-1/docx") },
      { id: "office", path: join(synced, "bucket-1/office") },
    ],
  });

  expect(describeIgnoredSkills(found, home)).toEqual([
    "~/.claude/skills/synced: hides docx, office",
    "~/missing: doesn't exist, so nothing is hidden",
  ]);
});

test("without the setting nothing is hidden", () => {
  write(join(home, ".claude/skills/synced/bucket-1/docx/SKILL.md"));

  expect(ignoredSkills(office, [], home)).toEqual({ folders: [], hidden: [] });
});
