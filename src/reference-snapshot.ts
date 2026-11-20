// Shared by the CLI and the installed office plugin. Reading desired data never loads package code.
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import * as v from "valibot";
import { check, type OfficeConfig, type Parsed, repository } from "./schema.ts";
import { commandConflicts, commandTable } from "./command-table.ts";

export const referenceFile = ".office/resolved/references.json";

const contributor = v.pipe(v.strictObject({
  name: v.string(), source: v.pipe(v.string(), v.regex(/^(?:local|unverified built-in|(?:git|built-in):[0-9a-f]{64})$/)),
  commit: v.optional(v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/))), stale: v.boolean(), references: v.array(repository),
  commands: v.optional(commandTable),
}), v.check(group => !group.source.startsWith("git:") || group.commit !== undefined || (group.stale && !group.references.length), "a Git contribution needs its resolved commit"),
v.check(group => !group.commands || !group.stale, "a failed collector cannot own commands"));

const schema = v.pipe(v.strictObject({
  version: v.union([v.literal(2), v.literal(3)], "unsupported references snapshot version (expected 2 or 3)"),
  inputs: v.string(), owner: v.array(repository),
  contributors: v.pipe(v.array(contributor), v.check(groups => new Set(groups.map(group => group.name)).size === groups.length, "ambiguous contributor identity")),
}), v.check(s => s.version === 3 || !s.contributors.some(group => group.commands), "legacy references snapshot cannot contain commands"));

export type ReferenceSnapshot = v.InferOutput<typeof schema>;

type Inputs = Pick<OfficeConfig, "references" | "packages">;

export function inputHash(config: Inputs): string {
  const packages = config.packages.toSorted((a, b) => a.name.localeCompare(b.name));

  return createHash("sha256").update(JSON.stringify([config.references, packages])).digest("hex");
}

export function readSnapshot(dir: string): Parsed<ReferenceSnapshot | undefined> {
  const path = join(dir, referenceFile);

  try {
    const result = check(v.safeParse(schema, JSON.parse(readFileSync(path, "utf8"))));

    if (result.ok) {
      const errors = commandConflicts(result.value.contributors);

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

export function claims(snapshot: Pick<ReferenceSnapshot, "owner" | "contributors">): Parsed<ClaimedReference[]> {
  const entries: ClaimedReference[] = [];
  const names = new Map<string, string>();
  const errors: string[] = [];

  const add = (references: OfficeConfig["references"], owner: string, stale: boolean) => {
    for (const reference of references) {
      const first = names.get(reference.name);

      if (first !== undefined) errors.push(`reference ${reference.name} claimed by both ${first} and ${owner}; select one claimant and run office sync --packages`);
      else names.set(reference.name, owner);
      entries.push({ ...reference, owner, stale });
    }
  };

  add(snapshot.owner, "office.yaml", false);

  for (const item of snapshot.contributors) add(item.references, `package ${item.name}`, item.stale);

  return errors.length ? { ok: false, errors } : { ok: true, value: entries };
}

export function resolvedReferences(dir: string, config: Inputs): Parsed<{ entries: ClaimedReference[]; notes: string[]; legacy: boolean }> {
  const read = readSnapshot(dir);

  if (!read.ok) return read;

  return referenceInputs(read.value, config);
}

/** Dispatch takes both its route and its data from the same atomic read. */
export function referenceInputs(snapshot: ReferenceSnapshot | undefined, config: Inputs): Parsed<{ entries: ClaimedReference[]; notes: string[]; legacy: boolean }> {
  const entries = claims(snapshot ?? { owner: config.references, contributors: [] });

  if (!entries.ok) return entries;
  const notes: string[] = [];

  if (snapshot) {
    for (const item of snapshot.contributors) {
      if (item.stale) notes.push(`package ${item.name}: reference collection failed; using last-good references, if any`);
    }

    if (snapshot.inputs !== inputHash(config)) notes.push("reference inputs changed since collection; run office sync --packages");
  }

  return { ok: true, value: { entries: entries.value, notes, legacy: !snapshot } };
}
