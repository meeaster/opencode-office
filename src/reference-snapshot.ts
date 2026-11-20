// Shared by the CLI and the installed office plugin. Reading desired data never loads package code.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { check, type OfficeConfig, type Parsed, repository } from "./schema.ts";

export const referenceFile = ".office/resolved/references.json";

const contributor = v.strictObject({
  name: v.string(), source: v.string(), stale: v.boolean(), references: v.array(repository),
});

const schema = v.strictObject({
  version: v.literal(1, "unsupported references snapshot version (expected 1)"),
  inputs: v.string(), owner: v.array(repository), contributors: v.array(contributor),
});

export type ReferenceSnapshot = v.InferOutput<typeof schema>;

type Inputs = Pick<OfficeConfig, "references" | "packages">;

export function inputHash(config: Inputs): string {
  const packages = config.packages.toSorted((a, b) => a.name.localeCompare(b.name));

  return createHash("sha256").update(JSON.stringify([config.references, packages])).digest("hex");
}

export function readSnapshot(dir: string): Parsed<ReferenceSnapshot | undefined> {
  const path = join(dir, referenceFile);

  if (!existsSync(path)) return { ok: true, value: undefined };

  try {
    const result = check(v.safeParse(schema, JSON.parse(readFileSync(path, "utf8"))));

    if (result.ok) return result;

    return { ok: false, errors: result.errors.map(message => `${referenceFile}: ${message}`) };
  } catch (error) {
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

export function resolvedReferences(dir: string, config: Inputs): Parsed<{ entries: ClaimedReference[]; notes: string[] }> {
  const read = readSnapshot(dir);

  if (!read.ok) return read;
  const snapshot = read.value;
  const entries = claims(snapshot ?? { owner: config.references, contributors: [] });

  if (!entries.ok) return entries;
  const notes: string[] = [];

  if (snapshot) {
    for (const item of snapshot.contributors) {
      if (item.stale) notes.push(`package ${item.name}: reference collection failed; using last-good references, if any`);
    }

    if (snapshot.inputs !== inputHash(config)) notes.push("reference inputs changed since collection; run office sync --packages");
  }

  return { ok: true, value: { entries: entries.value, notes } };
}
