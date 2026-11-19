// `office skills update` and `office packages update`: move the pins of copied skill groups and of
// packages from other repositories along their `track` (a branch, or the highest stable SemVer tag
// matching a pattern), record each as a full commit SHA in office.yaml and apply it. Each command
// touches only its own category: no clones, references, desks or the other category, and no sync.
// A group or package whose track can't be resolved, or whose copy can't be applied, keeps its pin.
import { editConfig, type Office, OfficeError, skillGroups, withScalar } from "../office.ts";
import { fetchPackage } from "../packages.ts";
import type { Stage } from "../report/index.ts";
import { describeGroup, stageGroup } from "../skill-copies.ts";
import { resolveTrack, type Resolved, short } from "../track.ts";
import { syncPackages } from "./sync.ts";

type Resolution = ({ ok: true } & Resolved) | { ok: false; reason: string };

async function resolve(repo: string, track: string): Promise<Resolution> {
  try {
    return { ok: true, ...await resolveTrack(repo, track) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message.trim() : String(error) };
  }
}

/** Report each result as it arrives, including failures that don't stop the remaining updates. */
class UpdateProgress {
  updated = 0;
  private failed = 0;

  constructor(private readonly stage: Stage) {}

  push(...lines: string[]): void {
    for (const line of lines) {
      if (line.startsWith("FAILED")) {
        this.failed++;
        this.stage.error(line);
      } else this.stage.note(line);
    }
  }

  finish(): void {
    if (this.failed > 0) {
      this.stage.fail(`${this.updated} updated, ${this.failed} failed`);

      throw new OfficeError("Fix the failures above and run the update again");
    }

    this.stage.done(this.updated === 0 ? "nothing to update" : `${this.updated} updated`);
  }
}

/**
 * Resolves each tracked skill group once, stages all of its copies at the commit found, then
 * records that commit as the group's ref and swaps the copies in.
 */
export async function updateSkills(loaded: Office, stage: Stage): Promise<void> {
  let office = loaded;
  const lines = new UpdateProgress(stage);
  const groups = skillGroups(office).filter((group) => group.grouped);

  for (const group of groups) {
    const what = describeGroup(group);

    if (group.track === undefined || group.ref === undefined) {
      lines.push(`${what}: pinned at ${short(group.ref ?? "")} with no track, so left there`);

      continue;
    }

    stage.detail(`checking ${group.skills.map((skill) => skill.name).join(", ")} (${group.track})`);

    const found = await resolve(group.repo, group.track);

    if (!found.ok) {
      lines.push(`FAILED ${what}: ${found.reason}; pin left at ${short(group.ref)}`);

      continue;
    }

    const staged = stageGroup(office, group, found.commit);

    if (!staged.ok) {
      lines.push(`FAILED ${what}: found ${short(found.commit)} (${found.via}), but ${staged.reason}; pin left at ${short(group.ref)}`);

      continue;
    }

    try {
      if (group.ref !== found.commit) office = editConfig(office, (text) => withScalar(text, ["skills", "copied", group.index, "ref"], found.commit));
    } catch (error) {
      staged.discard();
      lines.push(`FAILED ${what}: ${error instanceof Error ? error.message : String(error)}; pin left at ${short(group.ref)}`);

      continue;
    }

    const copies = staged.apply();
    const pin = group.ref === found.commit ? `already at ${short(found.commit)} (${found.via})` : `pinned ${short(group.ref)} → ${found.commit} (${found.via})`;

    if (group.ref !== found.commit || copies.length > 0) lines.updated++;
    lines.push(`${what}: ${pin}`, ...copies);
  }

  if (groups.length === 0) lines.push("skills.copied has no skill groups to update");
  lines.finish();
}

/**
 * Resolves each tracked package from another repository, copies it at the commit found and records
 * that commit as its ref, then applies the packages as sync does, when any pin moved.
 */
export async function updatePackages(loaded: Office, stage: Stage): Promise<void> {
  let office = loaded;
  const lines = new UpdateProgress(stage);
  const tracked = office.packages.flatMap((entry, index) => (entry.source === undefined ? [] : [{ entry, index, source: entry.source }]));

  for (const { entry, index, source } of tracked) {
    if (source.track === undefined) {
      lines.push(`package ${entry.name}: pinned at ${short(source.ref)} with no track, so left there`);

      continue;
    }

    stage.detail(`checking ${entry.name} (${source.track})`);

    const found = await resolve(source.repo, source.track);

    if (!found.ok) {
      lines.push(`FAILED package ${entry.name}: ${found.reason}; pin left at ${short(source.ref)}`);

      continue;
    }

    if (source.ref === found.commit) {
      lines.push(`package ${entry.name}: already at ${short(found.commit)} (${found.via})`);

      continue;
    }

    const copied = fetchPackage(office, entry.name, { ...source, ref: found.commit });
    const failed = copied.find((line) => line.startsWith("FAILED"));

    if (failed !== undefined) {
      lines.push(`FAILED package ${entry.name}: found ${short(found.commit)} (${found.via}), but ${failed.replace(/^FAILED\s*/, "")}; pin left at ${short(source.ref)}`);

      continue;
    }

    try {
      office = editConfig(office, (text) => withScalar(text, ["packages", index, "ref"], found.commit));
    } catch (error) {
      lines.push(`FAILED package ${entry.name}: ${error instanceof Error ? error.message : String(error)}; pin left at ${short(source.ref)}, and office sync puts its copy back there`);

      continue;
    }

    lines.updated++;
    lines.push(`package ${entry.name}: pinned ${short(source.ref)} → ${found.commit} (${found.via})`, ...copied);
  }

  if (lines.updated > 0) {
    stage.detail("applying packages");
    await syncPackages(office, lines, stage);
  }

  if (tracked.length === 0) lines.push("office.yaml lists no packages from other repositories to update");
  lines.finish();
}
