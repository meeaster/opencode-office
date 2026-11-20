import { createHash } from "node:crypto";
import * as v from "valibot";
import type { InstalledPackages } from "./layout.ts";
import type { Office, PackageEntry, Repository } from "./office.ts";
import { readRecord, type ResolvedPackage } from "./packages.ts";
import { claims, inputHash, referenceFile, type ReferenceSnapshot } from "./reference-snapshot.ts";
import type { ReferencePublication } from "./reference-publication.ts";
import { check, referenceContribution } from "./schema.ts";

// The package name is the key. A different kind, selection or installed Git revision
// under that name cannot inherit this contributor's last-good registrations.
function gitSelection(source: NonNullable<PackageEntry["source"]>): string {
  return `git:${createHash("sha256").update(JSON.stringify([source.repo, source.path, source.ref])).digest("hex")}`;
}

export function boundRevision(previous: ReferenceSnapshot | undefined, entry: PackageEntry): string | undefined {
  if (!entry.source) return undefined;
  const source = gitSelection(entry.source);

  return previous?.contributors.find(group => group.name === entry.name && group.source === source)?.commit;
}

function provenance(item: ResolvedPackage, previous: ReferenceSnapshot | undefined, rejected: boolean) {
  if (item.kind === "local") return { source: "local" };
  const record = rejected ? undefined : readRecord(item.dir);
  const selection = item.entry.source;

  if (item.kind === "remote" && selection) {
    const commit = record && "repo" in record && record.repo === selection.repo && record.ref === selection.ref && record.path === selection.path ? record.commit : boundRevision(previous, item.entry);

    return { source: gitSelection(selection), commit: /^[0-9a-f]{40}$/i.test(selection.ref) ? selection.ref.toLowerCase() : commit };
  }

  if (!record || "repo" in record) return { source: "unverified built-in" };
  const digest = createHash("sha256").update(JSON.stringify(Object.keys(record.files).sort().map(path => [path, record.files[path]]))).digest("hex");

  return { source: `built-in:${digest}` };
}

/** A throwing collector can publish a degraded generation. Conflicting claims cannot publish at all. */
export async function collectReferences(office: Office, selected: ResolvedPackage[], installed: InstalledPackages, changes: { push(...lines: string[]): void }, { previous, publish }: ReferencePublication, rejected: ReadonlySet<string>): Promise<boolean> {
  const candidate: ReferenceSnapshot = { version: 2, inputs: inputHash(office), owner: office.references, contributors: [] };
  const available = new Map(installed.installed.map(item => [item.entry.name, item]));

  for (const item of selected.toSorted((a, b) => a.entry.name.localeCompare(b.entry.name))) {
    const name = item.entry.name;
    const pkg = available.get(name);

    if (pkg && !pkg.manifest.setup) continue;

    const source = provenance(item, previous, rejected.has(name));
    const values: Repository[] = [];

    if (pkg?.manifest.setup) {
      try {
        await pkg.manifest.setup({ settings: structuredClone(pkg.settings), add(input) {
          const read = check(v.safeParse(referenceContribution, input));

          if (!read.ok) throw new Error(read.errors.join("; "));
          values.push(read.value.value);
        } });
        candidate.contributors.push({ name, ...source, stale: false, references: [...values] });
        continue;
      } catch (error) {
        changes.push(`FAILED package ${name}: collecting references (${source.source}${source.commit ? ` @ ${source.commit}` : ""}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const last = previous?.contributors.find(group => group.name === name && group.source === source.source && group.commit === source.commit);
    candidate.contributors.push({ name, ...source, stale: true, references: last?.references ?? [] });
  }

  const combined = claims(candidate);

  if (!combined.ok) {
    changes.push(...combined.errors.map(error => `FAILED ${error}; ${previous ? "previous reference generation retained" : "no reference generation published"}`));

    return false;
  }

  if (publish(candidate)) changes.push(`wrote ${referenceFile}`);

  return true;
}
