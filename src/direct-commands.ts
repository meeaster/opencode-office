// Package commands and their help: every run loads each package office.yaml selects, runs its
// setup, and works from what it registered in this process. Nothing is read from the saved
// references file. Runs only in a reader bound to the office's published package set.
import { existsSync } from "node:fs";
import * as v from "valibot";
import type { Collection, CollectionEntry, CommandInputs } from "../packages/office/package-context.ts";
import { repositories } from "../packages/references/repositories.ts";
import { commandNames, nameProblems, type NameProblem, type RegisteredCommand } from "./command-table.ts";
import { loadOffice, type Office, OfficeError } from "./office.ts";
import { readPackage, type ResolvedPackage, resolvePackages } from "./packages.ts";
import { type Registered, registerPackage } from "./package-setup.ts";
import { namedEntry } from "./reference-snapshot.ts";

/** A reader process: the office it is bound to and the packages that set's last sync rejected. */
export type Reader = { dir: string; unavailable: ReadonlySet<string> };

type Entry = { id: string; value: CollectionEntry; owner: string };

export type CommandLoad = {
  /** Commands of the packages that loaded, with their owners. */
  commands: { owner: string; command: RegisteredCommand }[];
  /** One line per package that failed to load, naming it. */
  failures: string[];
  /** Names that break the naming rule. */
  names: NameProblem[];
  /** Entries claimed twice. */
  conflicts: string[];
  read: CommandInputs["read"];
};

/**
 * Load one resolved package as the "What loads" rules say and run its setup. Undefined for a
 * package with no setup; throws, naming what failed, when it can't load.
 */
export async function loadPackage(office: Office, item: ResolvedPackage, unavailable: ReadonlySet<string>): Promise<Registered | undefined> {
  if (item.kind !== "local") {
    if (unavailable.has(item.entry.name)) throw new Error("rejected by the last sync; run office sync");

    if (!existsSync(item.dir)) throw new Error("not synced yet; run office sync");
  }

  // Checks a pulled-in copy against its record before importing any of its code.
  const read = readPackage(office, item);

  if (!read.ok) throw new Error(read.errors.join("; "));
  const { manifest, settings } = read.value;

  if (!manifest.setup) return undefined;
  const registered = await registerPackage({ dir: office.dir, name: item.entry.name, manifest, overrides: item.entry.settings ?? {}, settings });

  if (registered.invalid.length) throw new Error(registered.invalid.join("; "));

  return registered;
}

/** Load every package office.yaml selects and combine what they registered. */
async function loadForCommands({ dir, unavailable }: Reader): Promise<CommandLoad> {
  const office = loadOffice(dir);
  const resolved = resolvePackages(office, undefined, true);
  const failures = resolved.problems.map(problem => `package ${problem.packages.join(", ")}: ${problem.message}`);
  const loaded: { name: string; registered: Registered }[] = [];

  for (const item of resolved.packages) {
    try {
      const registered = await loadPackage(office, item, unavailable);

      if (registered) loaded.push({ name: item.entry.name, registered });
    } catch (error) {
      failures.push(`package ${item.entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return combine(office.references, loaded, failures);
}

/**
 * Parse each package's additions with their provider and gather the commands. The office's own
 * references come first, owned by office.yaml. A package whose additions fail is a failure too.
 */
export function combine(references: readonly CollectionEntry[], loaded: { name: string; registered: Registered }[], failures: string[] = []): CommandLoad {
  const providers = new Map<string, Collection<CollectionEntry>>();

  for (const { registered } of loaded) for (const [id, handle] of registered.collections) providers.set(id, handle);
  const entries: Entry[] = references.map(value => ({ id: repositories.id, value: structuredClone(value), owner: "office.yaml" }));
  const commands: CommandLoad["commands"] = [];

  for (const { name, registered } of loaded) {
    try {
      const parsed = registered.additions.map(({ id, value }) => {
        const provider = providers.get(id);

        if (!provider) throw new Error(`no provider registered ${id}`);
        const entry = provider.parse(value);

        if (!v.is(namedEntry, entry)) throw new Error(`${id}: expected a named JSON record`);

        return { id, value: structuredClone(entry), owner: `package ${name}` };
      });

      entries.push(...parsed);
      commands.push(...registered.commands.map(command => ({ owner: name, command })));
    } catch (error) {
      failures.push(`package ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const conflicts: string[] = [];
  const claimed = new Map<string, string>();

  for (const { id, value, owner } of entries) {
    const key = JSON.stringify([id, providers.get(id)?.identity === "package" ? owner : null, value.name]);
    const first = claimed.get(key);

    if (first === undefined) claimed.set(key, owner);
    else conflicts.push(id === repositories.id ? `reference ${value.name} claimed by both ${first} and ${owner}; select one claimant` : `${id} ${value.name} claimed by both ${first} and ${owner}`);
  }

  return {
    commands, failures, conflicts,
    names: nameProblems(commands),
    // SAFETY: the caller's handle has the ID its provider registered; the entry is that provider's parser output.
    read: <T extends CollectionEntry>(collection: Collection<T>) => entries.flatMap(({ id, value, owner }) => id === collection.id ? [{ value: structuredClone(value) as T, owner, stale: false }] : []),
  };
}

/** Help's lines for package commands: one per command, per failed package and per problem. */
export async function commandHelp(reader: Reader): Promise<string[]> {
  const load = await loadForCommands(reader);

  return [
    ...load.commands.map(({ command }) => `  ${commandNames(command).join(" | ")}    ${command.summary}`),
    ...load.failures.map(failure => `  ${failure}`),
    ...[...new Set(load.names.map(problem => problem.message))].map(message => `  ${message}`),
    ...load.conflicts.map(conflict => `  ${conflict}`),
  ];
}

export type Dispatch =
  | { found: true }
  /** No loaded package provides the command; `failures` name the packages that failed to load. */
  | { found: false; failures: string[] };

export async function dispatchCommand(reader: Reader, words: string[]): Promise<Dispatch> {
  if (words.some(word => /\s/.test(word))) return { found: false, failures: [] };
  const requested = words.join(" ");
  const load = await loadForCommands(reader);
  const matches = load.commands.filter(({ command }) => commandNames(command).includes(requested));

  if (!matches.length) return { found: false, failures: load.failures };

  if (load.failures.length || load.conflicts.length) throw new OfficeError(`${requested}: ${[...load.failures, ...load.conflicts].join("; ")}`);
  const claimed = new Set(matches.flatMap(({ command }) => commandNames(command)));
  const problems = new Set(load.names.filter(problem => claimed.has(problem.name)).map(problem => problem.message));

  if (problems.size) throw new OfficeError(`${requested}: ${[...problems].join("; ")}`);

  await matches[0].command.run({ read: load.read });

  return { found: true };
}
