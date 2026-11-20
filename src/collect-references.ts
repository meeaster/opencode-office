import * as v from "valibot";
import { collectJobs } from "../standard/cron/jobs.ts";
import { setupContext } from "./package-definition.ts";
import { commandConflicts, commandRegistration, type CommandMetadata } from "./command-table.ts";
import type { InstalledPackages } from "./layout.ts";
import type { Office, PackageEntry, Repository } from "./office.ts";
import { fileHashes, filesDigest, gitSelection, readRecord, type ResolvedPackage } from "./packages.ts";
import { claims, inputHash, referenceFile, type ReferenceSnapshot } from "./reference-snapshot.ts";
import type { ReferencePublication } from "./reference-publication.ts";
import { check, referenceContribution } from "./schema.ts";

// The package name is the key. A different kind, selection or installed Git revision
// under that name cannot inherit this contributor's last-good registrations.
export function boundRevision(previous: ReferenceSnapshot | undefined, entry: PackageEntry): string | undefined {
  if (!entry.source) return undefined;
  const source = gitSelection(entry.source);

  return previous?.contributors.find(group => group.name === entry.name && group.source === source)?.commit;
}

function provenance(item: ResolvedPackage, previous: ReferenceSnapshot | undefined, rejected: boolean, embedded: ReadonlyMap<string, string>) {
  if (item.kind === "local") return { source: "local" };

  if (item.kind === "built-in") {
    const source = embedded.get(item.entry.name);

    if (!source) throw new Error(`missing embedded source identity for ${item.entry.name}`);

    return { source };
  }

  const record = rejected ? undefined : readRecord(item.dir);
  const selection = item.entry.source;

  if (item.kind === "remote" && selection) {
    const commit = record && "repo" in record && record.repo === selection.repo && record.ref === selection.ref && record.path === selection.path ? record.commit : boundRevision(previous, item.entry);

    return { source: gitSelection(selection), commit: /^[0-9a-f]{40}$/i.test(selection.ref) ? selection.ref.toLowerCase() : commit };
  }

  throw new Error(`missing selected Git source for ${item.entry.name}`);
}

/** A throwing collector can publish a degraded generation. Conflicting claims cannot publish at all. */
export async function collectReferences(office: Office, selected: ResolvedPackage[], installed: InstalledPackages, changes: { push(...lines: string[]): void }, { previous, publish }: ReferencePublication, rejected: ReadonlySet<string>, embedded: ReadonlyMap<string, string>): Promise<boolean> {
  const candidate: ReferenceSnapshot = { version: 3, inputs: inputHash(office), owner: office.references, contributors: [] };
  const available = new Map(installed.installed.map(item => [item.entry.name, item]));
  const errors: string[] = [];

  for (const item of selected.toSorted((a, b) => a.entry.name.localeCompare(b.entry.name))) {
    const name = item.entry.name;
    const pkg = available.get(name);

    if (pkg && !pkg.manifest.setup && !pkg.manifest.registerCron) continue;

    const source = provenance(item, previous, rejected.has(name), embedded);
    const values: Repository[] = [];

    if (pkg) {
      try {
        if (pkg.manifest.registerCron) {
          const cron = collectJobs({ ...office, cron: {} }, { installed: [pkg], problems: [] });

          if (!cron.ok) throw new Error(cron.errors.join("; "));
        }

        const routes: CommandMetadata[] = [];
        const invalid: string[] = [];
        await pkg.manifest.setup?.(setupContext({
          settings: structuredClone(pkg.settings),
          command(input) {
            const read = commandRegistration(input);

            if (!read.ok) invalid.push(`package ${name}: command: ${read.errors.join("; ")}`);
            else {
              const { name, aliases, summary } = read.value;
              routes.push({ name, aliases, summary });
            }
          },
          add(input) {
            const read = check(v.safeParse(referenceContribution, input));

            if (!read.ok) throw new Error(read.errors.join("; "));
            values.push(read.value.value);
          },
        }));

        const commands = routes.length ? {
          routes: [...routes], settings: pkg.settings,
          files: item.kind === "remote" ? filesDigest(fileHashes(item.dir)) : undefined,
        } : undefined;

        candidate.contributors.push({ name, ...source, stale: false, references: [...values], commands });
        errors.push(...invalid);
        continue;
      } catch (error) {
        changes.push(`FAILED package ${name}: collecting references (${source.source}${source.commit ? ` @ ${source.commit}` : ""}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const last = previous?.contributors.find(group => group.name === name && group.source === source.source && group.commit === source.commit);
    candidate.contributors.push({ name, ...source, stale: true, references: last?.references ?? [] });
  }

  const combined = claims(candidate);

  errors.push(...commandConflicts(candidate.contributors));

  if (!combined.ok) errors.push(...combined.errors);

  if (errors.length) {
    changes.push(...errors.map(error => `FAILED ${error}; ${previous ? "previous reference generation retained" : "no reference generation published"}`));

    return false;
  }

  if (publish(candidate)) changes.push(`wrote ${referenceFile}`);

  return true;
}
