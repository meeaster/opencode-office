import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import * as v from "valibot";
import type { InstalledPackages } from "./layout.ts";
import type { Office, Repository } from "./office.ts";
import { readRecord, type ResolvedPackage } from "./packages.ts";
import { claims, inputHash, readSnapshot, referenceFile, type ReferenceSnapshot } from "./reference-snapshot.ts";
import { check, referenceContribution } from "./schema.ts";

// The package name is the key. A different kind, selection or installed Git revision
// under that name cannot inherit this contributor's last-good registrations.
function sourceKey(item: ResolvedPackage): string {
  if (item.kind !== "remote") return item.kind;
  const record = readRecord(item.dir);
  const source = item.entry.source;

  return createHash("sha256").update(JSON.stringify([source?.repo, source?.path, source?.ref, record && "repo" in record ? record.commit : null])).digest("hex");
}

/** A throwing collector can publish a degraded generation. Conflicting claims cannot publish at all. */
export async function collectReferences(office: Office, selected: ResolvedPackage[], installed: InstalledPackages, changes: { push(...lines: string[]): void }): Promise<boolean> {
  const previous = readSnapshot(office.dir);

  if (!previous.ok) {
    changes.push(...previous.errors.map(error => `FAILED ${error}; move the unreadable snapshot aside and run office sync --packages`));

    return false;
  }

  const candidate: ReferenceSnapshot = { version: 1, inputs: inputHash(office), owner: office.references, contributors: [] };
  const available = new Map(installed.installed.map(item => [item.entry.name, item]));

  for (const item of selected.toSorted((a, b) => a.entry.name.localeCompare(b.entry.name))) {
    const name = item.entry.name;
    const pkg = available.get(name);

    if (pkg && !pkg.manifest.setup) continue;

    const source = sourceKey(item);
    const values: Repository[] = [];

    if (pkg?.manifest.setup) {
      try {
        await pkg.manifest.setup({ settings: structuredClone(pkg.settings), add(input) {
          const read = check(v.safeParse(referenceContribution, input));

          if (!read.ok) throw new Error(read.errors.join("; "));
          values.push(read.value.value);
        } });
        candidate.contributors.push({ name, source, stale: false, references: [...values] });
        continue;
      } catch (error) {
        changes.push(`FAILED package ${name}: collecting references: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const last = previous.value?.contributors.find(group => group.name === name && group.source === source);
    candidate.contributors.push({ name, source, stale: true, references: last?.references ?? [] });
  }

  const combined = claims(candidate);

  if (!combined.ok) {
    changes.push(...combined.errors.map(error => `FAILED ${error}`));

    return false;
  }

  if (Bun.deepEquals(previous.value, candidate)) return true;

  const path = join(office.dir, referenceFile);
  const staging = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true });

  try {
    writeFileSync(staging, `${JSON.stringify(candidate, null, 2)}\n`);
    renameSync(staging, path);
  } finally {
    rmSync(staging, { force: true });
  }

  // Editing an unrelated package setting only renews the input fingerprint, not the reference list.
  if (!previous.value || !Bun.deepEquals(previous.value.owner, candidate.owner) || !Bun.deepEquals(previous.value.contributors, candidate.contributors)) {
    changes.push(`wrote ${referenceFile}`);
  }

  return true;
}
