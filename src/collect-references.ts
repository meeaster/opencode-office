import * as v from "valibot";
import type { Collection, CollectionEntry } from "../packages/office/package-context.ts";
import { collectJobs } from "../standard/cron/jobs.ts";
import { setupContext } from "./package-definition.ts";
import { commandConflicts, commandRegistration, type CommandMetadata } from "./command-table.ts";
import type { InstalledPackages } from "./layout.ts";
import type { Office, PackageEntry } from "./office.ts";
import { fileHashes, filesDigest, gitSelection, readRecord, type ResolvedPackage } from "./packages.ts";
import { claims, inputHash, namedEntry, referenceFile, type ReferenceSnapshot } from "./reference-snapshot.ts";
import type { ReferencePublication } from "./reference-publication.ts";

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
  const candidate: ReferenceSnapshot = { version: 4, inputs: inputHash(office), owner: office.references, contributors: [] };
  const available = new Map(installed.installed.map(item => [item.entry.name, item]));
  const errors: string[] = [];
  const definitions = new Map<string, Collection<CollectionEntry>>();
  const pending = new Map<string, { id: string; value: CollectionEntry }[]>();

  function fail(group: ReferenceSnapshot["contributors"][number], message?: string) {
    if (message) changes.push(`FAILED package ${group.name}: collecting references (${group.source}): ${message}`);
    const last = previous?.contributors.find(item => item.name === group.name && item.source === group.source && item.commit === group.commit);
    group.stale = true;
    delete group.commands;
    group.entries = last?.entries ?? [];
  }

  for (const item of selected.toSorted((a, b) => a.entry.name.localeCompare(b.entry.name))) {
    const name = item.entry.name;
    const pkg = available.get(name);

    if (pkg && !pkg.manifest.setup && !pkg.manifest.registerCron && !pkg.manifest.opencode) continue;

    const source = provenance(item, previous, rejected.has(name), embedded);
    const values: { id: string; value: CollectionEntry }[] = [];

    if (pkg && !pkg.manifest.setup && !pkg.manifest.registerCron) {
      // Bind an OpenCode-only Git contributor's immutable revision for repair too.
      candidate.contributors.push({ name, ...source, stale: false, entries: [] });
      continue;
    }

    if (pkg) {
      try {
        if (pkg.manifest.registerCron) {
          const cron = collectJobs({ ...office, cron: {} }, { installed: [pkg], problems: [] });

          if (!cron.ok) throw new Error(cron.errors.join("; "));
        }

        const routes: CommandMetadata[] = [];
        const invalid: string[] = [];
        const provided = new Map<string, Collection<CollectionEntry>>();
        const settings = item.entry.settings ?? {};
        const booleans: Record<string, boolean> = {};
        const declared = new Set(Object.keys(pkg.manifest.settings));
        await pkg.manifest.setup?.(setupContext({
          settings: structuredClone(pkg.settings),
          collection(handle) {
            if (!handle.id.startsWith(`${name}.`) || !/^[a-z0-9-]+\.[a-z0-9-]+$/.test(handle.id) || !v.is(v.function(), handle.parse) || provided.has(handle.id)) throw new Error(`invalid or duplicate collection ${handle.id}`);
            provided.set(handle.id, handle);
          },
          command(input) {
            const read = commandRegistration(input);

            if (!read.ok) invalid.push(`package ${name}: command: ${read.errors.join("; ")}`);
            else {
              const { name, aliases, summary } = read.value;
              routes.push({ name, aliases, summary });
            }
          },
          add(handle, value) {
            // Accept shipped one-argument registrations from existing package definitions.
            if (arguments.length === 1 && "registry" in handle && v.is(v.string(), handle.registry) && "value" in handle) {
              if (!v.is(namedEntry, handle.value)) throw new Error("expected a named collection entry");
              values.push({ id: handle.registry, value: structuredClone(handle.value) });
            } else {
              if (!v.is(namedEntry, value)) throw new Error("expected a named collection entry");
              values.push({ id: handle.id, value: structuredClone(value) });
            }
          },
        }, settings, declared, booleans));

        if (pkg.manifest.settings_schema === undefined) {
          for (const key of Object.keys(settings)) if (!declared.has(key)) throw new Error(`settings.${key}: ${name} has no such setting`);
        }

        const commands = routes.length ? {
          routes: [...routes], settings: pkg.settings, booleans: Object.keys(booleans).length ? booleans : undefined,
          files: item.kind === "remote" ? filesDigest(fileHashes(item.dir)) : undefined,
        } : undefined;

        for (const [id, handle] of provided) definitions.set(id, handle);
        pending.set(name, [...values]);
        candidate.contributors.push({ name, ...source, stale: false, entries: [], commands });
        errors.push(...invalid);
        continue;
      } catch (error) {
        changes.push(`FAILED package ${name}: collecting references (${source.source}${source.commit ? ` @ ${source.commit}` : ""}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const group = { name, ...source, stale: true, entries: [] };
    fail(group);
    candidate.contributors.push(group);
  }

  const keys = new Map<string, string>();

  for (const group of candidate.contributors) {
    try {
      for (const { id, value } of pending.get(group.name) ?? []) {
        const handle = definitions.get(id);

        if (!handle) throw new Error(`no provider registered ${id}`);
        const entry = handle.parse(value);

        if (!v.is(namedEntry, entry)) throw new Error(`${id}: expected a named JSON record`);
        group.entries.push({ id, value: entry });
      }
    } catch (error) {
      fail(group, String(error));
    }

    for (const { id, value } of group.entries) {
      const key = JSON.stringify([id, value.name]);
      const first = keys.get(key);

      if (first) errors.push(`${id} ${value.name} claimed by both package ${first} and package ${group.name}`);
      keys.set(key, group.name);
    }
  }

  const combined = claims(candidate);

  errors.push(...commandConflicts(candidate.contributors, "publish"));

  if (!combined.ok) errors.push(...combined.errors);

  if (errors.length) {
    changes.push(...errors.map(error => `FAILED ${error}; ${previous ? "previous reference generation retained" : "no reference generation published"}`));

    return false;
  }

  if (publish(candidate)) changes.push(`wrote ${referenceFile}`);

  return true;
}
