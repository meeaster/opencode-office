import * as v from "valibot";
import type { Registry, RegistryEntry } from "../sdk/index.ts";
import { project, destinationProblems, machineCollection } from "../standard/mise-integration/projection.ts";
import { collectJobs } from "../standard/cron/jobs.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { changesSetup, fragmentPath } from "./package-tools.ts";
import { registerPackage } from "./package-setup.ts";
import { declaredCommands, nameProblems, type RegisteredCommand } from "./command-table.ts";
import { installedPackages, type InstalledPackages } from "./layout.ts";
import type { Office, PackageEntry } from "./office.ts";
import { builtinSource, collectionContract, gitSelection, providerFiles, readRecord, resolvePackages, type InstalledPackage, type ResolvedPackage } from "./packages.ts";
import { claims, inputHash, namedEntry, readSnapshot, referenceFile, type ReferenceSnapshot } from "./reference-snapshot.ts";
import type { ReferencePublication } from "./reference-publication.ts";

// The package name is the key. A different kind, selection or installed Git revision
// under that name cannot inherit this contributor's last-good registrations.
export function boundRevision(previous: ReferenceSnapshot | undefined, entry: PackageEntry): string | undefined {
  if (!entry.source) return undefined;
  const source = gitSelection(entry.source);

  return previous?.contributors.find(group => group.name === entry.name && group.source === source)?.commit;
}

/** A failed collector cannot withdraw an earlier machine claim, or authorize a
 * different package to replace its still-delivered setup. */
export function unresolvedMachineOwner(office: Office, installed: InstalledPackages, previous?: ReferenceSnapshot) {
  return [...installed.unread].find(name =>
    previous?.contributors.find(group => group.name === name)?.entries.some(row => machineCollection(row.id)) ||
    (existsSync(fragmentPath(office, name)) && installed.installed.some(item => item.machine?.install || changesSetup(office, item))));
}

/** Before swapping a tracked tree, collect the staged revision alongside the
 * current peers (including earlier updates in this batch), without publishing. */
export async function admitReplacement(office: Office, item: InstalledPackage, expectedBuiltins?: ReadonlyMap<string, string>) {
  const name = item.entry.name;
  const snapshot = readSnapshot(office.dir);

  if (!snapshot.ok) throw new Error(snapshot.errors.join("; "));
  const effective = { ...office, packages: office.packages.map(entry => entry.name === name ? item.entry : entry) };
  const selected = resolvePackages(effective).packages.map(peer => peer.entry.name === name ? item : peer);
  const peers = installedPackages(effective, new Set([name]), false);
  peers.installed.push(item);
  peers.unread.delete(name);
  const sources = new Map<string, string>();

  if (peers.problems.length) throw new Error(`${peers.problems.map(problem => problem.message).join("; ")}; sync the selected peers before updating`);

  for (const peer of selected) {
    if (peer.kind !== "built-in") continue;
    const record = readRecord(peer.dir);

    if (!record) throw new Error(`cannot validate with missing ${peer.entry.name} package; sync the selected peers first`);
    const source = builtinSource(record.files);
    const expected = expectedBuiltins?.get(peer.entry.name);

    if (expected && expected !== source) throw new Error(`sync the current ${peer.entry.name} package before updating`);
    sources.set(peer.entry.name, source);
  }

  const failures: string[] = [];
  let staleCandidate = false;

  const accepted = await collectReferences(effective, selected, peers, { push(...lines) { failures.push(...lines.filter(line => line.startsWith("FAILED"))); } }, {
    previous: snapshot.value,
    publish(candidate) {
      staleCandidate = candidate.contributors.some(group => group.name === name && group.stale);

      return false;
    },
  }, new Set(), sources);

  if (!accepted || peers.unread.has(name) || staleCandidate) throw new Error(failures.join("; ") || "could not validate package claims");

  const unresolved = unresolvedMachineOwner(effective, peers, snapshot.value);

  if (unresolved) throw new Error(`unresolved machine claims of ${unresolved}; repair that package before replacing the installed tree`);
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
export async function collectReferences(office: Office, selected: ResolvedPackage[], installed: InstalledPackages, changes: { push(...lines: string[]): void }, { previous, publish }: ReferencePublication, rejected: ReadonlySet<string>, embedded: ReadonlyMap<string, string>, conflict?: (...owners: string[]) => void): Promise<boolean> {
  const candidate: ReferenceSnapshot = { version: 4, inputs: inputHash(office), owner: office.references, contributors: [] };
  const available = new Map(installed.installed.map(item => [item.entry.name, item]));
  const errors: string[] = [];
  const definitions = new Map<string, { handle: Registry<RegistryEntry>; owner: string; contract: string }>();
  const pending = new Map<string, { id: string; value: RegistryEntry }[]>();
  const commands = new Map<string, RegisteredCommand[]>();

  function fail(group: ReferenceSnapshot["contributors"][number], message?: string) {
    if (message) changes.push(`FAILED package ${group.name}: collecting references (${group.source}): ${message}`);
    const last = previous?.contributors.find(item => item.name === group.name && item.source === group.source && item.commit === group.commit);
    group.stale = true;
    group.entries = last?.entries ?? [];
  }

  for (const item of selected.toSorted((a, b) => a.entry.name.localeCompare(b.entry.name))) {
    const name = item.entry.name;
    const pkg = available.get(name);
    const definition = pkg?.manifest ?? installed.definitions.get(name);

    // Commands come from the definition, whether or not it has a setup, read or set up.
    if (definition) commands.set(name, declaredCommands(definition));

    if (pkg && !pkg.manifest.setup && !pkg.manifest.registerCron && !pkg.manifest.opencode) continue;

    const source = provenance(item, previous, rejected.has(name), embedded);

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

        const { registries: provided, additions } = await registerPackage({ name, manifest: pkg.manifest, settings: pkg.settings });

        if (provided.size) {
          const files = providerFiles(item);

          // A local provider has no immutable revision: bind its package bytes too. Setup
          // settings can change the meaning of an otherwise identical parser.
          const contract = collectionContract(source, files, item.entry);

          for (const [id, handle] of provided) definitions.set(id, { owner: name, handle, contract });
        }

        pending.set(name, additions);
        candidate.contributors.push({ name, ...source, stale: false, entries: [] });
        continue;
      } catch (error) {
        changes.push(`FAILED package ${name}: collecting references (${source.source}${source.commit ? ` @ ${source.commit}` : ""}): ${error instanceof Error ? error.message : String(error)}`);
        // Setup failed: keep last-good package deliveries.
        installed.installed = installed.installed.filter(current => current !== pkg);
        installed.unread.add(name);
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
        const provider = definitions.get(id);

        if (!provider) throw new Error(`no provider registered ${id}`);
        const entry = provider.handle.parse(value);

        if (!v.is(namedEntry, entry)) throw new Error(`${id}: expected a named JSON record`);
        group.entries.push({ id, value: structuredClone(entry), contract: provider.contract });
      }
    } catch (error) {
      fail(group, String(error));
    }
  }

  // A registration and all of its owner's additions succeed as one batch. Propagate
  // failure even across multiple levels or a cycle, independent of the package order.
  const failed = new Set(candidate.contributors.flatMap(group => group.stale ? [group.name] : []));
  let count;

  do {
    count = failed.size;

    for (const group of candidate.contributors) {
      if (group.stale) continue;
      const dependency = group.entries.find(row => failed.has(definitions.get(row.id)!.owner));

      if (dependency) {
        fail(group, `provider of ${dependency.id} failed collection`);
        failed.add(group.name);
      }
    }
  } while (count !== failed.size);

  for (const group of candidate.contributors) {
    if (group.stale) group.entries = group.entries.flatMap(row => {
      const provider = definitions.get(row.id);

      if (provider && provider.contract === row.contract) return [row];

      changes.push(`package ${group.name}: omitting last-good ${row.id}/${row.value.name}: provider contract changed or unavailable; repair the contributor and sync`);

      return [];
    });

    for (const { id, value } of group.entries) {
      const scoped = definitions.get(id)?.handle.identity === "package";
      const key = JSON.stringify([id, scoped ? group.name : null, value.name]);
      const first = keys.get(key);

      if (first) {
        conflict?.(first, group.name);
        errors.push(`${id} ${value.name} claimed by both package ${first} and package ${group.name}`);
      }

      keys.set(key, group.name);
    }
  }

  for (const group of candidate.contributors) {
    const item = available.get(group.name);

    if (!item) continue;

    if (group.stale) {
      const old = previous?.contributors.find(owner => owner.name === group.name);

      if (old?.entries.some(row => machineCollection(row.id)) || pending.get(group.name)?.some(row => machineCollection(row.id))) {
        installed.installed = installed.installed.filter(pkg => pkg !== item);
        installed.unread.add(group.name);
      }

      continue;
    }

    try {
      project(item, group.entries, true);
    } catch (error) {
      conflict?.(group.name);
      errors.push(`package ${group.name}: ${String(error)}`);
    }
  }

  errors.push(...destinationProblems(office, installed.installed, conflict));

  const combined = claims(candidate);

  for (const problem of nameProblems([...commands].flatMap(([owner, registered]) => registered.map(command => ({ owner, command }))))) {
    conflict?.(...problem.owners);
    errors.push(problem.message);
  }

  if (!combined.ok) errors.push(...combined.errors);

  if (errors.length) {
    changes.push(...errors.map(error => `FAILED ${error}; ${previous ? "previous reference generation retained" : "no reference generation published"}`));

    return false;
  }

  if (publish(candidate)) changes.push(`wrote ${referenceFile}`);

  return true;
}
