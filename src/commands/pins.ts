// `office skills update` and `office packages update`: move the pins of copied skill groups and of
// packages from other repositories along their `track` (a branch, or the highest stable SemVer tag
// matching a pattern), record each as a full commit SHA in office.yaml and apply it. Each command
// touches only its own category: no clones, references, desks or the other category, and no sync.
// A group or package whose track can't be resolved, or whose copy can't be applied, keeps its pin.
import { editConfig, type Office, skillGroups, withScalar } from "../office.ts";
import { fetchPackage } from "../packages.ts";
import { describeGroup, stageGroup } from "../skill-copies.ts";
import { resolveTrack, type Resolved, short } from "../track.ts";
import { syncPackages } from "./sync.ts";

type Resolution = ({ ok: true } & Resolved) | { ok: false; reason: string };

function resolve(repo: string, track: string): Resolution {
  try {
    return { ok: true, ...resolveTrack(repo, track) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message.trim() : String(error) };
  }
}

/**
 * Resolves each tracked skill group once, stages all of its copies at the commit found, then
 * records that commit as the group's ref and swaps the copies in. Returns one line per group; a
 * line starting with FAILED left that group's pin and copies as they were.
 */
export function updateSkills(loaded: Office): string[] {
  let office = loaded;
  const lines: string[] = [];
  const groups = skillGroups(office).filter((group) => group.grouped);

  for (const group of groups) {
    const what = describeGroup(group);

    if (group.track === undefined || group.ref === undefined) {
      lines.push(`${what}: pinned at ${short(group.ref ?? "")} with no track, so left there`);

      continue;
    }

    const found = resolve(group.repo, group.track);

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

    lines.push(`${what}: ${pin}`, ...copies);
  }

  return groups.length === 0 ? ["skills.copied has no skill groups to update"] : lines;
}

/**
 * Resolves each tracked package from another repository, copies it at the commit found and records
 * that commit as its ref, then applies the packages as sync does, when any pin moved. Returns one
 * line per package and change; a line starting with FAILED left that package's pin as it was.
 */
export async function updatePackages(loaded: Office): Promise<string[]> {
  let office = loaded;
  const lines: string[] = [];
  const tracked = office.packages.flatMap((entry, index) => (entry.source === undefined ? [] : [{ entry, index, source: entry.source }]));
  let moved = false;

  for (const { entry, index, source } of tracked) {
    if (source.track === undefined) {
      lines.push(`package ${entry.name}: pinned at ${short(source.ref)} with no track, so left there`);

      continue;
    }

    const found = resolve(source.repo, source.track);

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

    moved = true;
    lines.push(`package ${entry.name}: pinned ${short(source.ref)} → ${found.commit} (${found.via})`, ...copied);
  }

  if (moved) await syncPackages(office, { push: (...changes) => lines.push(...changes) });

  return tracked.length === 0 ? ["office.yaml lists no packages from other repositories to update"] : lines;
}
