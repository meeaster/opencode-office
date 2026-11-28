import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import * as v from "valibot";
import { redactUrl } from "../../../sdk/redact-url.ts";
import type { Office } from "../../office.ts";
import { sha256 } from "../../lib/hash.ts";
import { check, type Parsed } from "../../parse.ts";
import { builtinFiles } from "../../tool.ts";

/** Where a pulled-in package records where it came from and the hash of each of its files. */
export const sourceFile = ".source.json";

/**
 * What the office declares that any package's plugin and scripts may read, kept apart from its
 * settings (the office's applied settings snapshot, `src/applied-settings.ts`):
 * `{ "opencode": "host" | "container" }`, office.yaml's mode. `office sync` writes it into each
 * package folder, and a local package's copy is committed.
 */
export const officeFile = ".office.json";

/** The office's own records in a package folder, left out of its file hashes. */
export const records = [sourceFile, officeFile];

const files = v.record(v.string(), v.string());

/** A copy from a repository: where it came from, and when it was copied. */
const remoteRecord = v.object({ repo: v.string(), path: v.string(), ref: v.string(), commit: v.string(), files, copied: v.optional(v.string()) });

/** A built-in copy: the `office` version and commit that wrote it. */
const builtinRecord = v.object({ office: v.string(), commit: v.string(), files });

const recordSchema = v.union([remoteRecord, builtinRecord]);

export type PackageRecord = v.InferOutput<typeof recordSchema>;

/** Every file under `dir` as a path relative to it, sorted. */
function filesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

/** The SHA-256 of each package file, leaving out the office's own records. */
export function fileHashes(dir: string): PackageRecord["files"] {
  const hashes: PackageRecord["files"] = {};

  for (const file of filesIn(dir)) {
    if (!records.includes(file)) hashes[file] = sha256(readFileSync(join(dir, file)));
  }

  return hashes;
}

/** A JSON file checked against `schema`; a file that doesn't parse is an error too. */
function readJson<Schema extends v.GenericSchema>(path: string, schema: Schema): Parsed<v.InferOutput<Schema>> {
  let document;

  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }

  return check(v.safeParse(schema, document));
}

/** The record of a pulled-in package, or undefined for a folder without a readable one. */
export function readRecord(dir: string): PackageRecord | undefined {
  const path = join(dir, sourceFile);

  if (!existsSync(path)) return undefined;

  const result = readJson(path, recordSchema);

  return result.ok ? result.value : undefined;
}

/** Package files that differ from the copy the record describes, each with what happened to it. */
export function localEdits(dir: string, record: Pick<PackageRecord, "files">): string[] {
  const now = fileHashes(dir);

  return [
    ...Object.keys(record.files).flatMap((file) => (now[file] === undefined ? [`${file} (removed)`] : now[file] === record.files[file] ? [] : [`${file} (edited)`])),
    ...Object.keys(now).flatMap((file) => (record.files[file] === undefined ? [`${file} (added)`] : [])),
  ];
}

/** What a record says the copy is, for messages. */
export function describeRecord(record: PackageRecord): string {
  return "repo" in record ? `${redactUrl(record.repo)} ${record.path} at ${record.commit.slice(0, 12)} (ref ${record.ref})` : `the built-in copy of office ${record.office} (commit ${record.commit.slice(0, 12)})`;
}

/** How to change a package pulled into the office, which is read-only. */
export const readOnlyNote = "packages in .office/packages/ are read-only: to change one, copy it into packages/<another name>/ and list that instead";

/** Writes one of the office's records in a package folder. */
export function writeJson(path: string, value: PackageRecord): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Fills a new copy of the package folder `dir` with `fill`, beside it, then swaps it in, so a
 * failed copy leaves the installed one as it was. The office's mode record stays: sync reports it
 * only when the mode changes.
 */
export async function replaceFolder<Result>(dir: string, fill: (staging: string) => Result): Promise<Awaited<Result>> {
  mkdirSync(dirname(dir), { recursive: true });
  const staging = mkdtempSync(join(dirname(dir), `.${basename(dir)}.new-`));

  try {
    const result = await fill(staging);

    if (existsSync(join(dir, officeFile))) copyFileSync(join(dir, officeFile), join(staging, officeFile));

    const backup = existsSync(dir) ? mkdtempSync(join(dirname(dir), `.${basename(dir)}.old-`)) : undefined;

    if (backup) renameSync(dir, backup);

    try {
      renameSync(staging, dir);
    } catch (error) {
      if (backup) renameSync(backup, dir);
      throw error;
    }

    if (backup) rmSync(backup, { recursive: true, force: true });

    return result;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export async function embeddedPackage(name: string) {
  const wanted = await builtinFiles(name);
  const hashes = Object.fromEntries([...wanted].map(([file, content]) => [file, sha256(content)]));

  return { wanted, hashes };
}

/** `.office.json`'s content: what the office declares to its packages. */
export function officeText(office: Office): string {
  return `${JSON.stringify({ opencode: office.opencode.mode }, null, 2)}\n`;
}
