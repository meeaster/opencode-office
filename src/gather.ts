// The one gathering of what packages register: every selected package's definition is read and its
// settings checked; when every package's settings are valid, every setup runs; then every entry is
// parsed by its registry's parser and checked against the registry's key, and each package's machine
// entries become its claims. Commands, help, sync's admission and `office check` all gather this way,
// once per evaluated package set, and each decides what a problem means. Nothing is read from an
// earlier run, and nothing is saved for a later one.
import * as v from "valibot";
import type { CommandInputs, Registry, RegistryEntry, SettingValue } from "../sdk/index.ts";
import { isRepository, repositories } from "../packages/references/repositories.ts";
import { machineCollection, project, type Projection, recipeSystem } from "../standard/mise-integration/projection.ts";
import type { AppliedReference } from "./applied-references.ts";
import { definitionRoot } from "./bound-paths.ts";
import { declaredCommands, nameProblems, type NameProblem, type RegisteredCommand } from "./command-table.ts";
import { installedPackages, type InstalledPackages } from "./layout.ts";
import type { Office } from "./office.ts";
import { type InstalledPackage, type PackageProblem, problemLine } from "./packages.ts";
import { jsonObject, type Registered, registerPackage } from "./package-setup.ts";

/** A package whose setup ran in this run: what it read as, with the claims its entries made and its effective system block. */
export type GatheredPackage = InstalledPackage & Projection;

/** A command a definition declares, with its package and that package's settings in this run (undefined when they are invalid). */
export type DeclaredCommand = { owner: string; command: RegisteredCommand; settings?: Record<string, SettingValue> };

/** A problem of the gathering: the packages it belongs to, and what it is. `named` messages already name their owners. */
export type GatherProblem = PackageProblem & { named?: true };

/** A parsed entry: its registry, the provider's parser output, who added it and the folder that package loaded from. */
export type Entry = { id: string; value: RegistryEntry; owner: string; folder: string };

/** A package whose setup ran: its name, the folder its definition loaded from, and what it registered. */
export type SetUp = { name: string; folder: string; registered: Registered };

export type Gathered = {
  /** Every package office.yaml selects, the required built-ins included, loaded or not. */
  selected: Set<string>;
  /** Selected and not read: what each of them registers is unknown. */
  unread: Set<string>;
  /** Every package that read, with its settings, whether or not its setup ran: for what needs definitions only. */
  inventory: InstalledPackages;
  /** The packages whose setup ran and whose entries parsed, each with its claims. */
  packages: GatheredPackage[];
  /** The commands the definitions declare, whether or not setup ran. */
  commands: DeclaredCommand[];
  /** Names that break the command naming rule; each consumer decides which matter. */
  names: NameProblem[];
  /** What failed to load, set up or parse, and keys claimed twice, each with its owners. */
  problems: GatherProblem[];
  /** The problems the check before loading found; with any, nothing loaded. */
  blocked?: PackageProblem[];
  /** The references, office.yaml's first, then each package's in the order they were set up. */
  references: AppliedReference[];
  /** No problem and nothing unread: only then do registries say what every package registered. */
  complete: boolean;
  /** Reads a registry; throws when the gathering is incomplete. */
  read: CommandInputs["read"];
};

/** One line for a gathering problem. */
export function problemText(problem: GatherProblem) {
  return problem.named ? problem.message : problemLine(problem);
}

/** One line per distinct problem, in order. */
export function problemLines(problems: readonly GatherProblem[]) {
  return [...new Set(problems.map(problemText))];
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/**
 * Gathers every package office.yaml selects. `skip` is for sync's admission only: the packages this
 * sync failed to fetch, which stay selected and unread and are not reported here. `machine` is for
 * what applies or checks the machine: a contributed recipe's bootstrap file is read for its
 * effective system block, and a recipe whose file doesn't read is its package's problem.
 */
export async function gatherPackages(office: Office, { skip = new Set<string>(), machine = false }: { skip?: ReadonlySet<string>; machine?: boolean } = {}): Promise<Gathered> {
  const inventory = installedPackages(office, skip, true);
  const problems: GatherProblem[] = inventory.problems.map(({ packages, message }) => ({ packages, message }));
  const settings = new Map(inventory.installed.map(item => [item.entry.name, item.settings]));
  const commands = [...inventory.definitions].flatMap(([owner, manifest]) => declaredCommands(manifest).map(command => ({ owner, command, settings: settings.get(owner) })));
  const setUp: SetUp[] = [];

  // With any invalid settings, or nothing loaded, no setup runs: commands and help still see what definitions declare.
  if (!inventory.blocked && !inventory.invalidSettings.length) {
    for (const item of inventory.installed) {
      try {
        setUp.push({ name: item.entry.name, folder: definitionRoot(office.dir, item), registered: await registerPackage({ name: item.entry.name, manifest: item.manifest, settings: item.settings }) });
      } catch (error) {
        problems.push({ packages: [item.entry.name], message: message(error) });
      }
    }
  }

  const parsed = parseEntries(office, setUp);
  const packages: GatheredPackage[] = [];

  problems.push(...parsed.problems);

  // Each package whose additions parsed gets its machine claims.
  for (const item of inventory.installed) {
    const rows = parsed.rows.get(item.entry.name);

    if (!rows) continue;

    try {
      const projection = project(item, rows.filter(row => machineCollection(row.id)));

      if (machine && projection.claims.recipe) projection.system = recipeSystem(item, projection.claims.recipe);
      packages.push({ ...item, ...projection });
    } catch (error) {
      problems.push({ packages: [item.entry.name], message: message(error) });
    }
  }

  const { entries } = parsed;
  const complete = !inventory.blocked && !problems.length && !inventory.unread.size;
  const incomplete = () => problems.map(problemText).join("; ") || `not loaded: ${[...inventory.unread].join(", ")}`;

  return {
    selected: inventory.selected, unread: inventory.unread, inventory, packages, commands, problems, complete,
    blocked: inventory.blocked,
    names: nameProblems(commands),
    references: entries.flatMap(({ id, value, owner }) => id === repositories.id && isRepository(value) ? [{ ...structuredClone(value), owner }] : []),
    read: <T extends RegistryEntry>(registry: Registry<T>) => {
      if (!complete) throw new Error(`cannot read ${registry.id}: the packages' registrations are incomplete: ${incomplete()}`);

      return readEntries(entries, registry);
    },
  };
}

/** A registry's entries, each a copy of its provider's parser output. */
export function readEntries<T extends RegistryEntry>(entries: readonly Entry[], registry: Registry<T>) {
  // SAFETY: the caller's handle has the id its provider registered; the entry is that provider's parser output.
  return entries.flatMap(({ id, value, owner, folder }) => id === registry.id ? [{ value: structuredClone(value) as T, owner, folder }] : []);
}

/**
 * Parses each package's additions with their provider, once every setup has run, then checks each
 * registry's key. The office's own references come first, owned by office.yaml. A problem names the
 * package it belongs to; `rows` holds the entries of each package whose additions all parsed.
 */
export function parseEntries(office: Pick<Office, "dir" | "references">, setUp: SetUp[]) {
  const providers = new Map<string, Registry<RegistryEntry>>();
  const problems: GatherProblem[] = [];
  const rows = new Map<string, Entry[]>();

  for (const { registered } of setUp) for (const [id, handle] of registered.registries) providers.set(id, handle);
  const entries: Entry[] = office.references.map(value => ({ id: repositories.id, value: structuredClone(value), owner: "office.yaml", folder: office.dir }));

  for (const { name, folder, registered } of setUp) {
    try {
      const own = registered.additions.map(({ id, value }) => {
        const provider = providers.get(id);

        if (!provider) throw new Error(`no provider registered ${id}`);
        const entry = provider.parse(structuredClone(value));

        if (!v.is(jsonObject, entry)) throw new Error(`${id}: its parser returned something other than a JSON object`);

        return { id, value: structuredClone(entry), owner: name, folder };
      });

      entries.push(...own);
      rows.set(name, own);
    } catch (error) {
      problems.push({ packages: [name], message: message(error) });
    }
  }

  problems.push(...keyProblems(entries, providers));

  return { entries, problems, rows };
}

/** Two entries of one registry with the same key, each registry's `key` and `keyScope` deciding. */
function keyProblems(entries: Entry[], providers: Map<string, Registry<RegistryEntry>>): GatherProblem[] {
  const problems: GatherProblem[] = [];
  const claimed = new Map<string, string>();
  const claimant = (owner: string) => owner === "office.yaml" ? owner : `package ${owner}`;

  for (const { id, value, owner } of entries) {
    const provider: Registry<RegistryEntry> | undefined = providers.get(id) ?? (id === repositories.id ? repositories : undefined);

    if (!provider?.key) continue;
    let key: unknown;

    // On a copy, so a key can't change the entry; a result that isn't text is refused unread.
    try {
      key = provider.key(structuredClone(value));
    } catch (error) {
      problems.push({ packages: [owner], message: `${id}: its key failed: ${message(error)}` });
      continue;
    }

    if (!v.is(v.string(), key)) {
      problems.push({ packages: [owner], message: `${id}: its key returned something other than text` });
      continue;
    }

    const at = JSON.stringify([id, provider.keyScope === "package" ? owner : null, key]);
    const first = claimed.get(at);
    const packages = [...new Set([first, owner])].filter((name): name is string => name !== undefined && name !== "office.yaml");

    if (first === undefined) claimed.set(at, owner);
    else if (first === owner) problems.push({ packages, named: true, message: `${id} ${key} added twice by ${claimant(owner)}` });
    else problems.push({ packages, named: true, message: `${id} ${key} claimed by both ${claimant(first)} and ${claimant(owner)}` });
  }

  return problems;
}
