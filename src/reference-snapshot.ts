// Shared by the CLI and the installed office plugin. Reading desired data never loads package code.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import * as v from "valibot";
import { check, type OfficeConfig, type Parsed, repository, settingValue } from "./schema.ts";
import { isRepository, repositories } from "../packages/references/repositories.ts";
import type { Collection, CollectionEntry } from "../packages/office/package-context.ts";
import { commandConflicts, commandTable } from "./command-table.ts";

export const referenceFile = ".office/resolved/references.json";

const binding = {
  name: v.string(), source: v.pipe(v.string(), v.regex(/^(?:local|unverified built-in|(?:git|built-in):[0-9a-f]{64})$/)),
  commit: v.optional(v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/))), stale: v.boolean(),
  commands: v.optional(commandTable),
};

export const namedEntry = v.objectWithRest({ name: v.string() }, settingValue);

const entry = v.pipe(v.strictObject({ id: v.string(), value: namedEntry }),
  v.check(row => row.id !== repositories.id || isRepository(row.value), "invalid published reference"));

const contributor = v.pipe(v.strictObject({ ...binding, entries: v.array(entry) }),
v.check(group => !group.source.startsWith("git:") || group.commit !== undefined || (group.stale && !group.entries.length), "a Git contribution needs its resolved commit"),
v.check(group => !group.commands || !group.source.startsWith("git:") || group.commands.files !== undefined, issue => `Git command owner ${issue.input.name} is missing its commands.files digest`),
v.check(group => !group.commands || !group.stale, "a failed collector cannot own commands"));

const legacy = v.pipe(v.strictObject({
  version: v.union([v.literal(2), v.literal(3)]),
  inputs: v.string(), owner: v.array(repository),
  contributors: v.array(v.strictObject({ ...binding, references: v.array(repository) })),
}), v.transform(snapshot => ({ ...snapshot, contributors: snapshot.contributors.map(({ references, ...group }) =>
  ({ ...group, entries: references.map(value => ({ id: repositories.id, value })) })) })));

const schema = v.pipe(v.strictObject({
  version: v.union([v.literal(2), v.literal(3), v.literal(4)], "unsupported references snapshot version (expected 2, 3 or 4)"),
  inputs: v.string(), owner: v.array(repository),
  contributors: v.pipe(v.array(contributor), v.check(groups => new Set(groups.map(group => group.name)).size === groups.length, "ambiguous contributor identity")),
}), v.check(s => s.version !== 2 || !s.contributors.some(group => group.commands), "legacy references snapshot cannot contain commands"));

export type ReferenceSnapshot = v.InferOutput<typeof schema>;

type Inputs = Pick<OfficeConfig, "references" | "packages">;

export function inputHash(config: Inputs): string {
  const packages = config.packages.toSorted((a, b) => a.name.localeCompare(b.name));

  return createHash("sha256").update(JSON.stringify([config.references, packages])).digest("hex");
}

export function readSnapshot(dir: string): Parsed<ReferenceSnapshot | undefined> {
  const path = join(dir, referenceFile);

  try {
    let document = JSON.parse(readFileSync(path, "utf8"));

    if (document?.version === 2 || document?.version === 3) {
      const migrated = check(v.safeParse(legacy, document));

      if (!migrated.ok) return { ok: false, errors: migrated.errors.map(message => `${referenceFile}: ${message}`) };
      document = migrated.value;
    }

    const result = check(v.safeParse(schema, document));

    if (result.ok) {
      const errors = commandConflicts(result.value.contributors, "v3");

      return errors.length ? { ok: false, errors } : result;
    }

    return { ok: false, errors: result.errors.map(message => `${referenceFile}: ${message}`) };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      for (const part of [path, dirname(path), join(dir, ".office")]) {
        if (lstatSync(part, { throwIfNoEntry: false })?.isSymbolicLink() && !statSync(part, { throwIfNoEntry: false })) {
          return { ok: false, errors: [`${referenceFile}: dangling link at ${part}`] };
        }
      }

      return { ok: true, value: undefined };
    }

    return { ok: false, errors: [`${referenceFile}: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

export type ClaimedReference = v.InferOutput<typeof repository> & { owner: string; stale: boolean };

export function publishedCollection<T extends CollectionEntry>(snapshot: Pick<ReferenceSnapshot, "owner" | "contributors">, collection: Collection<T>) {
  const entries = [];

  if (collection.id === repositories.id) {
    for (const reference of snapshot.owner) entries.push({ value: collection.parse(reference), owner: "office.yaml", stale: false });
  }

  for (const group of snapshot.contributors) {
    for (const { id, value } of group.entries) {
      if (id === collection.id) entries.push({ value: collection.parse(value), owner: `package ${group.name}`, stale: group.stale });
    }
  }

  return entries;
}

export function claims(snapshot: Pick<ReferenceSnapshot, "owner" | "contributors">): Parsed<ClaimedReference[]> {
  const entries: ClaimedReference[] = [];
  const names = new Map<string, string>();
  const errors: string[] = [];

  try {
    for (const { value: reference, owner, stale } of publishedCollection(snapshot, repositories)) {
      const first = names.get(reference.name);

      if (first !== undefined) errors.push(`reference ${reference.name} claimed by both ${first} and ${owner}; select one claimant and run office sync --packages`);
      else names.set(reference.name, owner);
      entries.push({ ...reference, owner, stale });
    }
  } catch (error) {
    errors.push(String(error));
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: entries };
}

export function resolvedReferences(dir: string, config: Inputs): Parsed<{ entries: ClaimedReference[]; notes: string[]; legacy: boolean }> {
  const read = readSnapshot(dir);

  if (!read.ok) return read;

  return referenceInputs(read.value, config);
}

/** Dispatch takes both its route and its data from the same atomic read. */
export function referenceInputs(snapshot: ReferenceSnapshot | undefined, config: Inputs): Parsed<{ entries: ClaimedReference[]; notes: string[]; legacy: boolean }> {
  if (snapshot) return publishedInputs(snapshot, config);

  const entries = claims({ owner: config.references, contributors: [] });

  return entries.ok ? { ok: true, value: { entries: entries.value, notes: [], legacy: true } } : entries;
}

export function publishedInputs(snapshot: ReferenceSnapshot, current?: Inputs): Parsed<{ entries: ClaimedReference[]; notes: string[]; legacy: boolean }> {
  const entries = claims(snapshot);

  if (!entries.ok) return entries;
  const notes: string[] = [];

  for (const item of snapshot.contributors) {
    if (item.stale) notes.push(`package ${item.name}: reference collection failed; using last-good references, if any`);
  }

  if (!current) notes.push("current reference/package inputs cannot be compared; using last-synced inputs. Repair office.yaml and run office sync --packages");
  else if (snapshot.inputs !== inputHash(current)) notes.push("reference inputs changed since collection; run office sync --packages");

  return { ok: true, value: { entries: entries.value, notes, legacy: false } };
}
