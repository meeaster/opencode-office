import { join } from "node:path";
import type { PackageLock } from "../../lock-schema.ts";
import { readRecord, sourceDifferences, verifiedCommit } from "../sources/copies.ts";
import type { ResolvedPackage } from "../sources/selection.ts";

/**
 * office.lock's `packages:` section for a candidate: each selected Git package at the commit its
 * staged copy records. A package that failed keeps its previous entry with its previous copy;
 * deselected packages drop out.
 */
export function candidatePackageLock(selected: ResolvedPackage[], staged: string, rejected: string[], previous: PackageLock): PackageLock {
  const lock: PackageLock = new Map();

  for (const { entry, kind } of selected) {
    if (kind !== "remote" || !entry.source) continue;
    const record = rejected.includes(entry.name) ? undefined : readRecord(join(staged, entry.name));
    const { repo, path, ref } = entry.source;

    if (record && "repo" in record && !sourceDifferences(record, entry.source).length && verifiedCommit(ref, record.commit)) {
      lock.set(entry.name, { repo, path, ref, commit: record.commit.toLowerCase() });

      continue;
    }

    const kept = previous.get(entry.name);

    if (kept) lock.set(entry.name, kept);
  }

  return lock;
}
