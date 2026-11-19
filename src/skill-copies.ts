// Copies of skills.copied in the library, `skills/<name>/`, each recording where it came from in
// `.source.json`. A group of skills is copied from one checkout of its repository, all or nothing:
// every copy it needs is staged first, and none replaces the library's until all are ready. A copy
// that would be replaced must still be the copy its record describes, so edits are never lost.
// `office sync` applies a group's pin; `office skills update` applies a pin it has just resolved.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as v from "valibot";

import { checkoutCommit, copyFolder, withCheckout } from "./git.ts";
import type { CopiedSkill, Office, SkillGroup } from "./office.ts";
import { fileHashes, localEdits, sourceFile } from "./packages.ts";
import { short } from "./track.ts";

const skillRecord = v.object({
  repo: v.string(),
  ref: v.nullable(v.string()),
  path: v.string(),
  commit: v.string(),
  // Copies made before groups lack the hashes; their edits are found against the recorded commit.
  files: v.optional(v.record(v.string(), v.string())),
});

type SkillRecord = v.InferOutput<typeof skillRecord>;

/** The record of a copied skill, or undefined when it has none that reads. */
export function readSkillRecord(dir: string): SkillRecord | undefined {
  const path = join(dir, sourceFile);

  if (!existsSync(path)) return undefined;

  try {
    const parsed = v.safeParse(skillRecord, JSON.parse(readFileSync(path, "utf8")));

    return parsed.success ? parsed.output : undefined;
  } catch {
    return undefined;
  }
}

/** Whether a copy's record says it is `skill` at `ref`: the same ref, or the commit a SHA pin names. */
export function isCurrent(record: SkillRecord | undefined, skill: CopiedSkill, ref: string | undefined): boolean {
  return record !== undefined && record.repo === skill.repo && record.path === skill.path && (record.ref === (ref ?? null) || record.commit === ref);
}

/** The library folder of a copied skill. */
export function skillDir(office: Office, name: string): string {
  return join(office.dir, "skills", name);
}

/**
 * The edits to the copy at `dir` against what its record says was copied, read from the commit
 * the record names when the record has no file hashes. Throws when that can't be told.
 */
function editsOf(dir: string, name: string): string[] {
  const record = readSkillRecord(dir);

  if (record === undefined) throw new Error(`skills/${name} has no readable ${sourceFile}, so office can't tell whether it was edited; move it aside, then run the update again`);

  if (record.files !== undefined) return localEdits(dir, { files: record.files });

  const label = `${record.repo}@${record.commit}`;

  try {
    return withCheckout(record.repo, record.commit, (checkout) => {
      const original = mkdtempSync(join(tmpdir(), "office-skill-original-"));

      try {
        copyFolder(checkout, record.path, join(original, name), "SKILL.md", label);

        return localEdits(dir, { files: fileHashes(join(original, name)) });
      } finally {
        rmSync(original, { recursive: true, force: true });
      }
    });
  } catch (error) {
    throw new Error(`can't tell whether skills/${name} was edited, as its copy of ${label} can't be read: ${error instanceof Error ? error.message.trim() : String(error)}`, { cause: error });
  }
}

/** A group's copies, staged: `apply` swaps them into the library, `discard` drops them. */
export type StagedGroup = { ok: true; commit: string | undefined; apply: () => string[]; discard: () => void } | { ok: false; reason: string };

const nothing: StagedGroup = { ok: true, commit: undefined, apply: () => [], discard: () => {} };

/**
 * Stages every copy `group` needs at `ref`: a missing one, and for a group (not a skill listed
 * alone) one whose record names another source or ref. Fails, changing nothing, when the
 * repository can't be read at `ref`, a skill is missing from it, or a copy to be replaced was
 * edited. Copies already at `ref` stay as they are, edited or not.
 */
export function stageGroup(office: Office, group: SkillGroup, ref: string | undefined): StagedGroup {
  const targets = group.skills.filter((skill) => {
    const dir = skillDir(office, skill.name);

    return !existsSync(dir) || (group.grouped && !isCurrent(readSkillRecord(dir), skill, ref));
  });

  if (targets.length === 0) return nothing;

  const replaced = targets.filter((skill) => existsSync(skillDir(office, skill.name)));

  mkdirSync(join(office.dir, ".office"), { recursive: true });

  const staging = mkdtempSync(join(office.dir, ".office", "skills-staging-"));
  const discard = () => rmSync(staging, { recursive: true, force: true });

  try {
    for (const skill of replaced) {
      const edits = editsOf(skillDir(office, skill.name), skill.name);

      if (edits.length > 0) throw new Error(`skills/${skill.name} has local edits that replacing it would lose: ${edits.join(", ")}; move them into a skill of your own or undo them, then run it again`);
    }

    const commit = withCheckout(group.repo, ref, (checkout) => {
      for (const skill of targets) {
        const to = join(staging, skill.name);

        copyFolder(checkout, skill.path, to, "SKILL.md", `${group.repo}${ref === undefined ? "" : `@${ref}`}`);
        writeFileSync(join(to, sourceFile), `${JSON.stringify({ repo: skill.repo, ref: ref ?? null, path: skill.path, commit: checkoutCommit(checkout), files: fileHashes(to), copied: new Date().toISOString() }, null, 2)}\n`);
      }

      return checkoutCommit(checkout);
    });

    const apply = () => {
      mkdirSync(join(office.dir, "skills"), { recursive: true });

      const lines = targets.map((skill) => {
        const dir = skillDir(office, skill.name);
        const before = readSkillRecord(dir);

        rmSync(dir, { recursive: true, force: true });
        renameSync(join(staging, skill.name), dir);

        if (!replaced.includes(skill)) return `copied skills/${skill.name} from ${skill.repo} at ${commit}`;

        return `updated skills/${skill.name} from ${before === undefined ? "an unrecorded copy" : short(before.commit)} to ${short(commit)}`;
      });

      discard();

      return lines;
    };

    return { ok: true, commit, apply, discard };
  } catch (error) {
    discard();

    return { ok: false, reason: error instanceof Error ? error.message.trim() : String(error) };
  }
}

/** A group for messages: its skills and repository. */
export function describeGroup(group: SkillGroup): string {
  return `skills ${group.skills.map((skill) => skill.name).join(", ")} from ${group.repo}`;
}
