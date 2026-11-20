import { listing } from "../packages/references/commands/list.ts";
import { setupContext } from "./package-definition.ts";
import * as v from "valibot";
import { claimsInspect, commandRegistration, type RegisteredCommand } from "./command-table.ts";
import { findOffice, loadOffice, type Office, OfficeError, readOfficeFields } from "./office.ts";
import { builtinSource, collectionContract, embeddedPackage, filesDigest, gitSelection, installedDefinition, type PackageRecord, providerFiles, resolvePackages, type ResolvedPackage, verifyInstalledCopy } from "./packages.ts";
import { publishedCollection, publishedInputs, readSnapshot, referenceInputs, type ReferenceSnapshot } from "./reference-snapshot.ts";
import type { CommandInputs } from "../packages/office/package-context.ts";
import { check, commandBootstrapSchema, packageEntry, referenceInputSchema } from "./schema.ts";
import { shippedReferences } from "./v3-reference-owner.ts";

type Owner = ReferenceSnapshot["contributors"][number];

type Selections = Pick<Office, "dir" | "packages">;

function named(route: { name: string; aliases: string[] }, requested: string) {
  return route.name === requested || route.aliases.includes(requested);
}

function indexedCommand(snapshot: ReferenceSnapshot | undefined, requested: string) {
  for (const owner of snapshot?.contributors ?? []) {
    const route = owner.commands?.routes.find(route => named(route, requested));

    if (route) return { owner, canonical: route.name };
  }
}

function directory(start: string) {
  try {
    return findOffice(start);
  } catch (error) {
    if (!(error instanceof OfficeError)) throw error;

    return undefined;
  }
}

export function commandHelp(start: string): string[] {
  const dir = directory(start);
  const read = dir && readSnapshot(dir);

  if (read && !read.ok) return [`Package commands unavailable: ${read.errors.join("; ")}; run office sync --packages after repair`];

  const snapshot = read ? read.value : undefined;

  if (!snapshot || snapshot.version === 2) return [`  ${listing.name}    ${listing.summary} (bootstrap)`];

  const lines: string[] = [];

  for (const owner of snapshot.contributors) {
    if (owner.stale) lines.push(`  package ${owner.name}: collection failed; run office sync --packages`);

    if (claimsInspect(owner)) lines.push(`  opencode inspect unavailable: indexed route of package ${owner.name}; rename its claim or deselect it and sync`);

    for (const route of owner.commands?.routes ?? []) lines.push(`  ${[route.name, ...route.aliases].join(" | ")}    ${route.summary}`);
  }

  return lines;
}

function selectedOwner(office: Selections, name: string) {
  const { packages: [item], problems } = resolvePackages(office, name);

  if (problems.length) throw new OfficeError(problems.map(p => p.message).join("; "));

  if (!item) throw new OfficeError(`package ${name} is no longer selected`);

  return item;
}

function verifyBinding(item: ResolvedPackage, owner: Owner, record: PackageRecord | undefined, embedded?: string) {
  if (item.kind === "local" && owner.source === "local" && (!owner.commands?.files || owner.commands.files === providerFiles(item))) return;

  if (item.kind === "remote" && item.entry.source && gitSelection(item.entry.source) === owner.source && record && "repo" in record && record.commit === owner.commit && filesDigest(record.files) === owner.commands?.files) return;

  if (item.kind === "built-in" && record && !("repo" in record) && builtinSource(record.files) === owner.source && embedded === owner.source) return;

  throw new OfficeError(`missing owner or changed source/revision of package ${owner.name}`);
}

/** Resolve functions anew, but never collect new data or validate unsynced package settings here. */
async function handler(office: Selections, owner: Owner, canonical: string, requested: string, version: ReferenceSnapshot["version"]) {
  const matches: RegisteredCommand[] = [];

  try {
    const item = selectedOwner(office, owner.name);
    const legacy = version === 3 && owner.name === "references" && owner.source === shippedReferences && canonical === listing.name;
    const embedded = item.kind === "built-in" ? (legacy ? shippedReferences : (await embeddedPackage(owner.name)).source) : undefined;
    const read = installedDefinition(office, item, record => verifyBinding(item, owner, record, embedded));

    if (!read.ok) throw new OfficeError(read.errors.join("; "));

    const { manifest } = read.value;

    if (manifest.name !== owner.name || !owner.commands) throw new OfficeError("command owner changed");

    await manifest.setup?.(setupContext({
      settings: structuredClone(owner.commands.settings), add() {}, collection() {},
      command(input) {
        const read = commandRegistration(input);

        if (!read.ok) throw new OfficeError(read.errors.join("; "));
        const command = read.value;

        if (command.name === canonical || named(command, requested)) matches.push(command);
      },
    }, owner.commands.booleans ?? {}, new Set(Object.keys(manifest.settings))));

    if (matches.length !== 1 || matches[0].name !== canonical || !named(matches[0], requested)) throw new OfficeError("owner no longer provides this registration unambiguously");

    return matches[0].run;
  } catch (error) {
    throw new OfficeError(`${requested} (package ${owner.name}): ${error instanceof Error ? error.message : String(error)}; run office sync --packages`);
  }
}

function selection(dir: string, name: string, withSettings = false) {
  try {
    const document = readOfficeFields(dir, commandBootstrapSchema);
    const matches = document.packages.filter(entry => entry.name === name);

    if (matches.length > 1) throw new OfficeError("ambiguous owner selection");
    const packages: Office["packages"] = [];

    if (matches.length) {
      // Validate the exact source with the sync-time schema, independent of unsynced
      // settings and job overrides. A partial Git selection must never look local.
      const entry = check(v.safeParse(packageEntry, { ...matches[0], settings: withSettings ? matches[0].settings : {}, cron: {} }));

      if (!entry.ok) throw new OfficeError(entry.errors.join("; "));
      packages.push(entry.value);
    }

    return { office: { dir, packages }, document };
  } catch (error) {
    throw new OfficeError(`package ${name}: ${error instanceof Error ? error.message : String(error)}; repair office.yaml and run office sync --packages`);
  }
}

/** Compare only the provider of a requested collection. Inspect bytes and selection, never
 * import its definition. A provider reading its own rows already passed handler's binding
 * check and runs with the settings saved alongside that same publication. */
function readerBinding(dir: string, snapshot: ReferenceSnapshot, commandOwner: string, id: string) {
  const name = id.split(".")[0];

  if (name === commandOwner) return;

  const provider = snapshot.contributors.find(group => group.name === name);
  const mismatch = `provider ${name} no longer matches the published contract`;

  try {
    const { office } = selection(dir, name, true);
    const item = selectedOwner(office, name);
    const record = verifyInstalledCopy(item);
    const files = record ? filesDigest(record.files) : providerFiles(item);
    const source = item.kind === "built-in" ? `built-in:${files}` : item.entry.source ? gitSelection(item.entry.source) : "local";
    const commit = record && "repo" in record ? record.commit : undefined;

    if (provider?.source !== source || provider.commit !== commit) throw new Error(mismatch);
    const expected = collectionContract(provider, files, item.entry);

    return (contract?: string) => {
      // office.yaml repositories have the independently checked built-in repository shape.
      if (contract !== expected && !(contract === undefined && id === "references.repository" && item.kind === "built-in")) throw new OfficeError(`${id}: ${mismatch}; repair and run office sync --packages`);
    };
  } catch (error) {
    throw new OfficeError(`${id}: ${String(error)}; run office sync --packages`);
  }
}

function indexedInputs(dir: string, snapshot: ReferenceSnapshot, name: string) {
  const { office, document } = selection(dir, name);
  const current = v.safeParse(referenceInputSchema, document);

  return { office, inputs: publishedInputs(snapshot, current.success ? current.output : undefined) };
}

function bootstrapInputs(dir: string, snapshot: ReferenceSnapshot | undefined) {
  const office = loadOffice(dir);

  return { office, inputs: referenceInputs(snapshot, office) };
}

export async function dispatchCommand(start: string, words: string[]): Promise<boolean> {
  const dir = directory(start);

  if (!dir || words.some(word => /\s/.test(word))) return false;
  const read = readSnapshot(dir);

  if (!read.ok) throw new OfficeError(read.errors.join("; "));
  const snapshot = read.value;
  const requested = words.join(" ");
  const indexed = indexedCommand(snapshot, requested);
  const bootstrap = (!snapshot || snapshot.version === 2) && requested === listing.name;

  if (!bootstrap && !indexed) return false;
  const { office, inputs } = indexed && snapshot ? indexedInputs(dir, snapshot, indexed.owner.name) : bootstrapInputs(dir, snapshot);

  if (!inputs.ok) throw new OfficeError(inputs.errors.join("; "));
  const { entries, notes } = inputs.value;

  for (const note of notes) console.error(note);

  const publication = snapshot ?? { owner: entries.map(({ owner, stale, ...value }) => value), contributors: [] };

  // Keep the runtime input of already-indexed pre-collection commands through the upgrade.
  const commandInputs = { references: entries, read: (collection) => publishedCollection(publication, collection,
    indexed && snapshot ? readerBinding(dir, snapshot, indexed.owner.name, collection.id) : undefined) } satisfies CommandInputs & { references: typeof entries };

  if (indexed && snapshot) {
    const run = await handler(office, indexed.owner, indexed.canonical, requested, snapshot.version);
    await run(commandInputs);
  } else {
    selectedOwner(office, "references"); // No implicit takeover of a legacy package's name.
    console.error(snapshot ? "Legacy reference generation; run office sync --packages to index commands." : "No reference generation yet; listing office.yaml only. Run office sync --packages to collect contributors.");
    listing.run(commandInputs);
  }

  return true;
}
