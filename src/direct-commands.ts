// Package commands and their help: every run loads each package office.yaml selects, and works
// from what the definitions declare and what their setups registered in this process. Nothing is
// read from the saved references file. Runs only in a reader bound to the office's published package set.
//
// Two phases: every definition is read and every package's settings checked first; only when no
// settings are invalid does any setup run. Then every setup finishes before an entry is parsed.
import * as v from "valibot";
import type { CommandInputs, Registry, RegistryEntry, SettingValue } from "../sdk/index.ts";
import { repositories } from "../packages/references/repositories.ts";
import { definitionRoot } from "./bound-paths.ts";
import { commandNames, declaredCommands, nameProblems, type NameProblem, type RegisteredCommand } from "./command-table.ts";
import { loadOffice, OfficeError } from "./office.ts";
import { definitionGate, problemLine, readPackage, resolvePackages } from "./packages.ts";
import { type Registered, registerPackage } from "./package-setup.ts";
import { namedEntry } from "./reference-snapshot.ts";

/** A reader process: the office it is bound to (`bindReader` recorded the set's rejected packages). */
export type Reader = { dir: string };

type Entry = { id: string; value: RegistryEntry; owner: string; folder: string };

/** A command a definition declares, with its package and that package's settings in this run (undefined when they are invalid). */
export type DeclaredCommand = { owner: string; command: RegisteredCommand; settings?: Record<string, SettingValue> };

/** A package whose setup ran: its name, the folder its definition loaded from, and what it registered. */
export type SetUp = { name: string; folder: string; registered: Registered };

export type CommandLoad = {
  /** The commands the loaded definitions declare, with their owners. */
  commands: DeclaredCommand[];
  /** One line per package that failed to load or set up, naming it. */
  failures: string[];
  /** Names that break the naming rule. */
  names: NameProblem[];
  /** Entries claimed twice. */
  conflicts: string[];
  /** Problems the check before loading found; with any, nothing loaded. */
  blocked?: string[];
  read: CommandInputs["read"];
};

/** Load every package office.yaml selects: read and check each, then, when every package's settings are valid, set each up. */
async function loadForCommands({ dir }: Reader): Promise<CommandLoad> {
  const office = loadOffice(dir);
  const resolved = resolvePackages(office, undefined, true);
  const failures = resolved.problems.map(problemLine);

  // A package the last sync rejected, and every copy, package.json, declared dependency and link,
  // is checked before the first import.
  const problems = definitionGate(office, resolved.packages).map(problemLine);

  if (problems.length) return { ...combine(office, [], [...new Set([...failures, ...problems])]), blocked: problems };

  const commands: DeclaredCommand[] = [];
  const ready = [];
  let invalidSettings = false;

  for (const item of resolved.packages) {
    const read = readPackage(office, item);
    const manifest = read.ok ? read.value.manifest : read.manifest;

    if (manifest) commands.push(...declaredCommands(manifest).map(command => ({ owner: item.entry.name, command, settings: read.ok ? read.value.settings : undefined })));

    if (read.ok) ready.push({ item, installed: read.value });
    else {
      failures.push(`package ${item.entry.name}: ${read.errors.join("; ")}`);

      if (read.settings?.length) invalidSettings = true;
    }
  }

  // With any invalid settings, no setup runs: commands and help still see what definitions declare.
  if (invalidSettings) return combine(office, [], failures, commands);

  const setUp: SetUp[] = [];

  for (const { item, installed } of ready) {
    try {
      setUp.push({ name: item.entry.name, folder: definitionRoot(office.dir, item), registered: await registerPackage({ name: item.entry.name, manifest: installed.manifest, settings: installed.settings }) });
    } catch (error) {
      failures.push(`package ${item.entry.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return combine(office, setUp, failures, commands);
}

/**
 * Parse each package's additions with their provider, once every setup has run. The office's own
 * references come first, owned by office.yaml. A package whose additions fail is a failure too.
 */
export function combine(office: { dir: string; references: readonly RegistryEntry[] }, setUp: SetUp[], failures: string[] = [], commands: DeclaredCommand[] = []): CommandLoad {
  const providers = new Map<string, Registry<RegistryEntry>>();

  for (const { registered } of setUp) for (const [id, handle] of registered.registries) providers.set(id, handle);
  const entries: Entry[] = office.references.map(value => ({ id: repositories.id, value: structuredClone(value), owner: "office.yaml", folder: office.dir }));

  for (const { name, folder, registered } of setUp) {
    try {
      const parsed = registered.additions.map(({ id, value }) => {
        const provider = providers.get(id);

        if (!provider) throw new Error(`no provider registered ${id}`);
        const entry = provider.parse(value);

        if (!v.is(namedEntry, entry)) throw new Error(`${id}: expected a named JSON record`);

        return { id, value: structuredClone(entry), owner: name, folder };
      });

      entries.push(...parsed);
    } catch (error) {
      failures.push(`package ${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const conflicts: string[] = [];
  const claimed = new Map<string, string>();
  const claimant = (owner: string) => owner === "office.yaml" ? owner : `package ${owner}`;

  for (const { id, value, owner } of entries) {
    const key = JSON.stringify([id, providers.get(id)?.identity === "package" ? owner : null, value.name]);
    const first = claimed.get(key);

    if (first === undefined) claimed.set(key, owner);
    else conflicts.push(id === repositories.id ? `reference ${value.name} claimed by both ${claimant(first)} and ${claimant(owner)}; select one claimant` : `${id} ${value.name} claimed by both ${claimant(first)} and ${claimant(owner)}`);
  }

  return {
    commands, failures, conflicts,
    names: nameProblems(commands),
    // SAFETY: the caller's handle has the ID its provider registered; the entry is that provider's parser output.
    read: <T extends RegistryEntry>(registry: Registry<T>) => entries.flatMap(({ id, value, owner, folder }) => id === registry.id ? [{ value: structuredClone(value) as T, owner, folder }] : []),
  };
}

/** Help's lines for package commands: one per declared command, per failed package and per problem. */
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

  // With the gate's problems, ownership conflicts too: no package loaded, so the command may be a typo.
  if (load.blocked) throw new OfficeError(`${requested}: unknown command, or a package command that can't run: no package loaded: ${load.failures.join("; ")}`);
  const matches = load.commands.filter(({ command }) => commandNames(command).includes(requested));

  if (!matches.length) return { found: false, failures: load.failures };
  const claimed = new Set(matches.flatMap(({ command }) => commandNames(command)));
  const names = new Set(load.names.filter(problem => claimed.has(problem.name)).map(problem => problem.message));
  const problems = [...load.failures, ...load.conflicts, ...names];

  if (problems.length) throw new OfficeError(`${requested}: ${problems.join("; ")}`);
  const [{ command, settings = {} }] = matches;

  await command.run({ read: load.read, settings: structuredClone(settings) });

  return { found: true };
}
