// The references the last successful sync resolved, for what must not load packages: the office
// plugin's guidance and `office instructions`, the GitHub access planner before the first sync, and
// reference refresh. Sync writes the file after each switch of the package set; it records what was
// resolved, not what each package registered. Shared by the CLI and the installed office plugin.
import { lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as v from "valibot";
import { check, type OfficeConfig, type Parsed, repository } from "./schema.ts";

const referenceFile = ".office/resolved/references.json";

/** A reference and who resolved it: `office.yaml`, or the name of the package that added it. */
export type AppliedReference = v.InferOutput<typeof repository> & { owner: string };

const schema = v.pipe(
  v.strictObject({ references: v.array(v.strictObject({ ...repository.entries, owner: v.pipe(v.string(), v.minLength(1)) })) }),
  v.rawCheck(({ dataset, addIssue }) => {
    if (!dataset.typed) return;
    const names = dataset.value.references.map(reference => reference.name);
    const twice = [...new Set(names.filter((name, index) => names.indexOf(name) !== index))];

    if (twice.length) addIssue({ message: `lists ${twice.map(name => `reference ${name}`).join(", ")} more than once` });
  }),
);

/**
 * The references the last sync applied: the file's rows, or office.yaml's own `references:` when
 * there is no file yet. A file that doesn't read is a problem naming it, never an empty list.
 */
export function appliedReferences(dir: string, config: Pick<OfficeConfig, "references">): Parsed<AppliedReference[]> {
  const path = join(dir, referenceFile);
  let read: Parsed<v.InferOutput<typeof schema>>;

  try {
    read = check(v.safeParse(schema, JSON.parse(readFileSync(path, "utf8"))));
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";

    // Only nothing at the path is no file yet; a link to nothing is an invalid entry.
    if (missing && !lstatSync(path, { throwIfNoEntry: false })) return { ok: true, value: config.references.map(reference => ({ ...reference, owner: "office.yaml" })) };

    read = { ok: false, errors: [missing ? `is a link to ${readlinkSync(path)}, which doesn't exist` : error instanceof Error ? error.message : String(error)] };
  }

  return read.ok ? { ok: true, value: read.value.references } : { ok: false, errors: read.errors.map(message => `${referenceFile}: ${message}`) };
}

/** Writes the applied references whole, by rename: whatever was at the path is replaced, never written through. */
export function writeAppliedReferences(dir: string, references: readonly AppliedReference[]) {
  const path = join(dir, referenceFile);
  const staging = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true });

  try {
    writeFileSync(staging, `${JSON.stringify({ references: references.map(({ name, url, ref, description, owner }) => ({ name, url, ref, description, owner })) }, null, 2)}\n`, { flag: "wx" });
    renameSync(staging, path);
  } finally {
    rmSync(staging, { force: true });
  }
}
