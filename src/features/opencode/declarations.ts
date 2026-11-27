// The last successful collection of each package's typed OpenCode registration, so check, inspect
// and gui dev can report it without running package code. It confers no ownership: which links are
// Office's is decided by their target (ownership.ts).
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { OfficeError, type Office } from "../../office.ts";
import { check } from "../../schema.ts";
import { atomicWrite } from "../../lib/atomic-write.ts";
import { assetPaths } from "./assets.ts";

const file = ".office/resolved/opencode-assets.json";

const declaration = v.union([
  v.strictObject({ state: v.literal("unavailable") }),
  v.strictObject({ state: v.literal("declared"), binding: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)), paths: assetPaths }),
]);

const declarations = v.record(v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]*$/)), declaration);

export type Declaration = v.InferOutput<typeof declaration>;

function storePath(office: Office) {
  for (const parent of [".office", ".office/resolved"]) {
    const info = lstatSync(join(office.dir, parent), { throwIfNoEntry: false });

    if (info && !info.isDirectory()) throw new OfficeError("cannot read OpenCode registrations through a redirected .office directory");
  }

  const path = join(office.dir, file);
  const info = lstatSync(path, { throwIfNoEntry: false });

  if (info && !info.isFile()) throw new OfficeError(`${file} is not a regular file`);

  return { path, present: info !== undefined };
}

/** Last collection, for observation only. */
export function readDeclarations(office: Office): Map<string, Declaration> {
  const { path, present } = storePath(office);

  if (!present) return new Map();
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    parsed = undefined;
  }

  const read = check(v.safeParse(declarations, parsed));

  if (!read.ok) throw new OfficeError("invalid recorded OpenCode registration; run office sync --packages");

  return new Map(Object.entries(read.value));
}

/** Records this collection, replacing the last one. */
export function writeDeclarations(office: Office, collected: Map<string, Declaration>): void {
  const { path, present } = storePath(office);
  const text = `${JSON.stringify(Object.fromEntries([...collected].sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`;

  const current = present ? readFileSync(path, "utf8") : undefined;

  if (current !== text && (present || collected.size > 0)) atomicWrite(path, text, 0o644);
}
