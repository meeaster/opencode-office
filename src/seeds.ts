// Seed files: the files under a package's `seed/` folder, copied once into the office. Each path a
// package handles gets a receipt in office.lock's `seeds:` section, which is committed: the
// SHA-256 of the bytes office created, or `existing: true` for a file that was already there. Sync
// never copies a path with a receipt again, so a seed file the office deletes stays deleted on
// every clone, and removing a package deletes a file it created only while it matches the receipt.
//
// The seed store, `.office/seeds/<sha256>`, keeps the bytes of every seed a receipt's hash names,
// written before the copy and the receipt, and is committed (sync's exclude block leaves it out).
// Office never deletes from it: a merge of two branches can reuse a seed one of them dropped.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { officeRelativePath, type SeedReceipt } from "./schema.ts";
import { atomicWrite } from "./secrets.ts";
import { editLock, lockFile, readLockSection } from "./versions.ts";

/** A package's folder of seed files. An earlier release read `template/`, which is no longer read. */
export const seedFolder = "seed";
/** The seed store, office-relative. */
export const seedStore = ".office/seeds";
/** Stops Git converting the store's files at add and at checkout, so each keeps the bytes its name hashes. */
const seedAttributes = "* -text -filter -ident -working-tree-encoding\n";

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Where the store's files are staged before their rename: excluded from commits, unlike the store. */
const staging = ".office";

/**
 * Keeps `bytes`, whose SHA-256 is `hash`, in the seed store of the office at `dir`, written whole by
 * rename. A seed already stored is left as it is; when its bytes don't hash to its name it throws,
 * as it does when the store can't be written, naming the seed's place in the store.
 */
function storeSeed(dir: string, hash: string, bytes: Buffer): void {
  const stored = `${seedStore}/${hash}`;
  let existing: Buffer | undefined;

  try {
    existing = existsSync(join(dir, stored)) ? readFileSync(join(dir, stored)) : undefined;

    if (existing === undefined) atomicWrite(join(dir, stored), bytes, 0o644, join(dir, staging));
  } catch (error) {
    throw new Error(`could not store it as ${stored}, so it isn't copied: ${message(error)}`);
  }

  if (existing !== undefined && sha256(existing) !== hash) throw new Error(`${stored} doesn't hash to its name, so it isn't copied; restore it from Git (git checkout -- ${stored})`);
}

/**
 * Keeps the store's `.gitattributes`, rewriting it when it is missing or differs, once the store of
 * the office at `dir` holds any seed. Sync runs it once, after copying seed files. Returns one line
 * per change; a failure starts with FAILED.
 */
export function keepSeedAttributes(dir: string): string[] {
  const attributes = `${seedStore}/.gitattributes`;

  try {
    if (!existsSync(join(dir, seedStore)) || !readdirSync(join(dir, seedStore)).some((name) => name !== ".gitattributes")) return [];

    if (existsSync(join(dir, attributes)) && readFileSync(join(dir, attributes), "utf8") === seedAttributes) return [];
    atomicWrite(join(dir, attributes), seedAttributes, 0o644, join(dir, staging));
  } catch (error) {
    return [`FAILED ${attributes}, which stops Git converting stored seeds: ${message(error)}`];
  }

  return [`wrote ${attributes}`];
}

/**
 * Why office won't handle the seed file at `file` in the office at `dir`: a path the `seeds:`
 * section couldn't hold, a path in `.office/`, which is office's own, or a folder on the way to it
 * that is a link or not a folder, which could lead outside the office. Folders that don't exist
 * yet are fine: they are made as real folders.
 */
function seedPathProblem(dir: string, file: string): string | undefined {
  if (!officeRelativePath(file)) return "not a plain office-relative path";
  const parts = file.split("/");

  // Compared without case, as a case-insensitive filesystem would.
  if (parts[0].toLowerCase() === ".office") return "in .office/, which office manages";

  for (let depth = 1; depth < parts.length; depth++) {
    const folder = parts.slice(0, depth).join("/");
    const info = lstatSync(join(dir, folder), { throwIfNoEntry: false });

    if (info === undefined) return undefined;

    if (!info.isDirectory()) return `${folder} is ${info.isSymbolicLink() ? "a link" : "not a folder"}, which office doesn't follow`;
  }

  return undefined;
}

/**
 * Copies each of package `name`'s seed `files` (paths under its seed folder, `folder`) that has no
 * receipt to the same path in the office at `dir`, unless a file is already there, and records a
 * receipt for each. Each copied seed is stored first (`storeSeed`), so a receipt never names a seed
 * that isn't stored, or one stored with other bytes. A path the section couldn't hold, one in `.office/` and one through a link
 * are refused and get no receipt. A store write, stored seed or copy that fails is reported and the other files
 * go ahead, so the receipts of the files copied are saved. Returns one line per change; a failure
 * starts with FAILED.
 */
export function copySeeds(dir: string, name: string, folder: string, files: string[]): string[] {
  try {
    return editLock(dir, ({ seeds }) => files.flatMap((file) => {
      if (seeds.has(file)) return [];
      const problem = seedPathProblem(dir, file);

      if (problem !== undefined) return [`FAILED package ${name}'s ${seedFolder}/${file}: ${problem}`];
      const target = join(dir, file);

      if (lstatSync(target, { throwIfNoEntry: false })) {
        seeds.set(file, { package: name, existing: true });

        return [`kept ${file}, which was already there, instead of package ${name}'s copy`];
      }

      try {
        // The receipt holds the hash of the bytes stored and written, read once from the package's copy.
        const source = join(folder, file);
        const bytes = readFileSync(source);
        const hash = sha256(bytes);

        storeSeed(dir, hash, bytes);
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes, { flag: "wx", mode: statSync(source).mode & 0o777 });
        seeds.set(file, { package: name, sha256: hash });
      } catch (error) {
        return [`FAILED package ${name}'s ${seedFolder}/${file}: ${message(error)}`];
      }

      return [`created ${file} from package ${name}`];
    }));
  } catch (error) {
    return [`FAILED package ${name}'s seed files: ${message(error)}`];
  }
}

/**
 * Settles package `name`'s receipt for `file` as the package goes: deletes a file it created while
 * the file still matches the receipt, with the folders that leaves empty. Keeps every other file.
 */
function settleReceipt(dir: string, name: string, file: string, receipt: SeedReceipt): string[] {
  if (!("sha256" in receipt)) return [];
  const problem = seedPathProblem(dir, file);

  if (problem !== undefined) return [`kept ${file}, because ${problem}`];
  const target = join(dir, file);

  if (!lstatSync(target, { throwIfNoEntry: false })?.isFile()) return [];

  if (sha256(readFileSync(target)) !== receipt.sha256) return [`kept ${file}, which changed since package ${name} wrote it`];

  rmSync(target);

  for (let folder = dirname(target); relative(dir, folder) !== "" && readdirSync(folder).length === 0; folder = dirname(folder)) rmdirSync(folder);

  return [`deleted ${file}, which package ${name} created`];
}

/**
 * Settles the receipts of every package `gone` names, in the office at `dir`: a file it created
 * goes while it matches its receipt's SHA-256, others stay, and the receipts go. It needs no copy
 * of the package, so it also serves a pulled-in package removed before a fresh clone installed it.
 * Throws when office.lock can't be read or written. Returns one line per change.
 */
export function settleReceipts(dir: string, gone: (name: string) => boolean): string[] {
  // Read without the lease first: most syncs have nothing to settle.
  if (![...readLockSection(dir, "seeds").values()].some((receipt) => gone(receipt.package))) return [];

  return editLock(dir, ({ seeds }) => [...seeds.keys()].sort().flatMap((file) => {
    const receipt = seeds.get(file);

    if (receipt === undefined || !gone(receipt.package)) return [];
    seeds.delete(file);

    return settleReceipt(dir, receipt.package, file, receipt);
  }));
}

/**
 * Problems with office.lock's `seeds:` section: that it can't be read, or receipts of a package
 * not `selected` that sync settles. A local package's receipts stay with its folder in
 * `packages/`, as its seed files do.
 */
export function seedReceiptProblems(dir: string, selected: Set<string>): string[] {
  let seeds;

  try {
    seeds = readLockSection(dir, "seeds");
  } catch (error) {
    return [`office sync copies and removes no seed file until this is fixed: ${message(error)}`];
  }

  const gone = new Set([...seeds.values()].flatMap(({ package: name }) => (selected.has(name) || existsSync(join(dir, "packages", name)) ? [] : [name])));

  return [...gone].sort().map((name) => `${lockFile} holds seed receipts of package ${name}, which office.yaml no longer lists (office sync deletes the files it created that are unchanged, and drops the receipts)`);
}

/**
 * Receipts in the office at `dir` whose seed isn't in the store, or whose stored bytes don't hash
 * to its name, one line each. Reads only. An unreadable `seeds:` section gives none here:
 * `seedReceiptProblems` reports it.
 */
export function storedSeedProblems(dir: string): string[] {
  let seeds;

  try {
    seeds = readLockSection(dir, "seeds");
  } catch {
    return [];
  }

  return [...seeds.keys()].sort().flatMap((file) => {
    const receipt = seeds.get(file);

    if (receipt === undefined || !("sha256" in receipt)) return [];
    const stored = `${seedStore}/${receipt.sha256}`;
    let bytes: Buffer;

    try {
      bytes = readFileSync(join(dir, stored));
    } catch {
      return [`${file}: its seed ${stored} is missing; restore it from Git (commit ${seedStore}/ with ${lockFile})`];
    }

    return sha256(bytes) === receipt.sha256 ? [] : [`${file}: its seed ${stored} doesn't hash to its name; restore it from Git`];
  });
}
