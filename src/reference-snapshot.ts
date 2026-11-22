// Shared by the CLI and the installed office plugin. Reading desired data never loads package code.
import { createHash } from "node:crypto";
import { snapshotPath } from "./bound-paths.ts";
import { lstatSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import * as v from "valibot";
import { check, type OfficeConfig, type Parsed, repository, settingValue } from "./schema.ts";
import { isRepository, repositories } from "../packages/references/repositories.ts";
import type { Collection, CollectionEntry } from "../packages/office/package-context.ts";

export const referenceFile = ".office/resolved/references.json";

const binding = {
  name: v.string(), source: v.pipe(v.string(), v.regex(/^(?:local|unverified built-in|(?:git|built-in):[0-9a-f]{64})$/)),
  commit: v.optional(v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/))), stale: v.boolean(),
};

export const namedEntry = v.objectWithRest({ name: v.string() }, settingValue);

const entry = v.pipe(v.strictObject({ id: v.string(), value: namedEntry, contract: v.optional(v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/))) }),
  v.check(row => row.id !== repositories.id || isRepository(row.value), "invalid published reference"));

// Earlier releases saved each command owner's routes and settings under `commands`. Package
// commands now load the packages on every run, so the key is accepted with any content and
// dropped unread; it goes when this file does.
const contributor = v.pipe(v.strictObject({ ...binding, commands: v.optional(v.unknown()), entries: v.array(entry) }),
  v.check(group => !group.source.startsWith("git:") || group.commit !== undefined || (group.stale && !group.entries.length), "a Git contribution needs its resolved commit"),
  v.transform(({ commands, ...group }) => group));

const schema = v.strictObject({
  version: v.literal(4, "unsupported references snapshot version (expected 4)"),
  inputs: v.string(), owner: v.array(repository),
  contributors: v.pipe(v.array(contributor), v.check(groups => new Set(groups.map(group => group.name)).size === groups.length, "ambiguous contributor identity")),
});

export type ReferenceSnapshot = v.InferOutput<typeof schema>;

type Inputs = Pick<OfficeConfig, "references" | "packages">;

export function gitSelection(source: NonNullable<OfficeConfig["packages"][number]["source"]>) {
  return `git:${createHash("sha256").update(JSON.stringify([source.repo, source.path, source.ref])).digest("hex")}`;
}

/** A changed YAML pin is not authority to apply its predecessor's data. Preserve the
 * publication itself: restoring the matching selection immediately restores its rows. */
export function selectedContributions(snapshot: ReferenceSnapshot, config?: Inputs) {
  if (!config || snapshot.inputs === inputHash(config)) return snapshot;

  return { ...snapshot, contributors: snapshot.contributors.map(group => {
    if (!group.source.startsWith("git:")) return group;
    const selected = config.packages.find(entry => entry.name === group.name);

    if (selected?.source && gitSelection(selected.source) === group.source) return group;

    return { ...group, stale: true, entries: [] };
  }) };
}

export function inputHash(config: Inputs): string {
  const packages = config.packages.toSorted((a, b) => a.name.localeCompare(b.name));

  return createHash("sha256").update(JSON.stringify([config.references, packages])).digest("hex");
}

export function readSnapshot(dir: string): Parsed<ReferenceSnapshot | undefined> {
  const path = snapshotPath(dir);

  try {
    const result = check(v.safeParse(schema, JSON.parse(readFileSync(path, "utf8"))));

    if (result.ok) return result;

    return { ok: false, errors: result.errors.map(message => `${referenceFile}: ${message}`) };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      for (const part of [path, dirname(path), join(dir, ".office")]) {
        if (lstatSync(part, { throwIfNoEntry: false })?.isSymbolicLink() && !statSync(part, { throwIfNoEntry: false })) {
          if (part === path && readlinkSync(path) === "../current/references.json" && statSync(join(dir, ".office/current"), { throwIfNoEntry: false })?.isDirectory()) continue;

          return { ok: false, errors: [`${referenceFile}: dangling link at ${part}`] };
        }
      }

      return { ok: true, value: undefined };
    }

    return { ok: false, errors: [`${referenceFile}: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

export type ClaimedReference = v.InferOutput<typeof repository> & { owner: string; stale: boolean };

export function publishedCollection<T extends CollectionEntry>(snapshot: Pick<ReferenceSnapshot, "owner" | "contributors">, collection: Collection<T>, verify?: (contract?: string) => void) {
  const entries = [];

  if (collection.id === repositories.id) {
    if (snapshot.owner.length) verify?.();

    for (const reference of snapshot.owner) entries.push({ value: canonical<T>(reference), owner: "office.yaml", stale: false });
  }

  for (const group of snapshot.contributors) {
    for (const { id, value, contract } of group.entries) {
      if (id !== collection.id) continue;
      verify?.(contract);
      entries.push({ value: canonical<T>(value), owner: `package ${group.name}`, stale: group.stale });
    }
  }

  return entries;
}

// The provider's parser ran on admission. The stable public handle identifies that type
// across separate imports; readers receive their own copy, never a second normalization.
function canonical<T extends CollectionEntry>(value: CollectionEntry): T {
  // SAFETY: callers matched the published row's collection ID to its typed public handle.
  // The snapshot stores the registered parser's output (and checks YAML repository rows).
  return structuredClone(value) as T;
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

export function resolvedReferences(dir: string, config: Inputs): Parsed<{ entries: ClaimedReference[]; notes: string[]; fromYaml: boolean }> {
  const read = readSnapshot(dir);

  if (!read.ok) return read;

  return referenceInputs(read.value, config);
}

/** The desired references: from the saved file, or from office.yaml alone (`fromYaml`) when there is none yet. */
export function referenceInputs(snapshot: ReferenceSnapshot | undefined, config: Inputs): Parsed<{ entries: ClaimedReference[]; notes: string[]; fromYaml: boolean }> {
  if (snapshot) return publishedInputs(snapshot, config);

  const entries = claims({ owner: config.references, contributors: [] });

  return entries.ok ? { ok: true, value: { entries: entries.value, notes: [], fromYaml: true } } : entries;
}

export function publishedInputs(snapshot: ReferenceSnapshot, current?: Inputs): Parsed<{ entries: ClaimedReference[]; notes: string[]; fromYaml: boolean }> {
  snapshot = selectedContributions(snapshot, current);
  const entries = claims(snapshot);

  if (!entries.ok) return entries;
  const notes: string[] = [];

  for (const item of snapshot.contributors) {
    if (item.stale) notes.push(`package ${item.name}: reference collection failed; using last-good references, if any`);
  }

  if (!current) notes.push("current reference/package inputs cannot be compared; using last-synced inputs. Repair office.yaml and run office sync --packages");
  else if (snapshot.inputs !== inputHash(current)) notes.push("reference inputs changed since collection; run office sync --packages");

  return { ok: true, value: { entries: entries.value, notes, fromYaml: false } };
}
