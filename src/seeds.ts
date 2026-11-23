// Seed files: the files under a package's `seed/` folder, laid down once in the office and the
// owner's from then on. Each path a package handles gets a receipt in office.lock's `seeds:`
// section, which is committed: the SHA-256 of the bytes office created, or `existing: true` for a
// file that was already there. Sync never creates a file for a path with a receipt again, so a seed
// file the office deletes stays deleted on every clone, and removing a package deletes a file it
// created only while it matches the receipt.
//
// When a package's seed changes, `classifySeed` compares the receipt, the stored seed, the
// package's seed and the office's file: sync replaces only a file whose bytes equal the stored
// seed, and a file with other bytes is pending until `office seeds settle` records the new seed.
// Nothing about pending is stored; it is worked out on each run.
//
// The seed store, `.office/seeds/<sha256>`, keeps the bytes of every seed a receipt's hash names,
// written before the copy and the receipt, and is committed (sync's exclude block leaves it out).
// Office never deletes from it: a merge of two branches can reuse a seed one of them dropped.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { officeRelativePath, type SeedReceipt } from "./schema.ts";
import { atomicWrite } from "./secrets.ts";
import { shellQuote } from "./sfw.ts";
import { editLock, lockFile, readLockSection } from "./versions.ts";

/** A package's folder of seed files. */
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

/** `path` as one shell word in a printed command: as it is when plain, single-quoted otherwise. */
export function shellWord(path: string): string {
  return /^[\w./@%+=:,-]+$/.test(path) ? path : shellQuote(path);
}

/**
 * How to repair stored seed `hash` when it is missing or doesn't hash to its name; sync, check and
 * the `office seeds` commands all give it.
 */
export function restoreAdvice(hash: string): string {
  const stored = `${seedStore}/${hash}`;

  return `restore it from Git (git checkout -- ${stored}) or, if it was never committed, copy the file as office laid it down (for an unchanged file, the office's file) to ${stored}`;
}

/** Where the store's files are staged before their rename: excluded from commits, unlike the store. */
const staging = ".office";

/**
 * Keeps `bytes`, whose SHA-256 is `hash`, in the seed store of the office at `dir`, written whole by
 * rename. A seed already stored is left as it is; when its bytes don't hash to its name it throws,
 * as it does when the store can't be written, naming the seed's place in the store.
 */
export function storeSeed(dir: string, hash: string, bytes: Buffer): void {
  const stored = `${seedStore}/${hash}`;
  let existing: Buffer | undefined;

  try {
    existing = existsSync(join(dir, stored)) ? readFileSync(join(dir, stored)) : undefined;

    if (existing === undefined) atomicWrite(join(dir, stored), bytes, 0o644, join(dir, staging));
  } catch (error) {
    throw new Error(`could not store it as ${stored}, so it isn't copied: ${message(error)}`);
  }

  if (existing !== undefined && sha256(existing) !== hash) throw new Error(`${stored} doesn't hash to its name, so it isn't copied; ${restoreAdvice(hash)}`);
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
 * What to do with a seeded path, from `classifySeed`:
 * - `current`: the package's seed is the one the receipt names; nothing to do, whatever the file holds.
 * - `replace`: the seed changed and the file still has the stored seed's bytes; sync replaces it.
 * - `advance`: the seed changed and the file is deleted or already has the new seed's bytes; sync records the new seed.
 * - `pending`: the seed changed and the file has other bytes; left to the owner (`office seeds diff`, `office seeds settle`).
 * - `dropped`: the package no longer has a seed for the path; sync leaves the file and drops the receipt.
 * - `blocked`: the seed changed and the stored seed is missing or doesn't hash to its name; nothing changes until Git restores it.
 * - `unowned`: the receipt marks a file that was already there, which has no stored seed; never offered.
 */
export type SeedClass = "current" | "replace" | "advance" | "pending" | "dropped" | "blocked" | "unowned";

/** The office's file at a seeded path: its bytes, `missing`, or `other` for anything office won't read as the file (a folder, a link, a path through a link). */
export type OfficeFile = Buffer | "missing" | "other";

/**
 * Classifies a seeded path from its receipt, the stored seed's bytes (undefined when not stored),
 * the package's current seed (undefined when the package has none for the path) and the office's
 * file. Pure: sync, check and the `office seeds` commands all decide through it.
 */
export function classifySeed(receipt: SeedReceipt, stored: Buffer | undefined, seed: Buffer | undefined, file: OfficeFile): SeedClass {
  if (seed === undefined) return "dropped";

  if (!("sha256" in receipt)) return "unowned";
  const wanted = sha256(seed);

  if (wanted === receipt.sha256) return "current";

  // Without the seed office laid down, nothing can show the file is untouched or what changed in it.
  if (stored === undefined || sha256(stored) !== receipt.sha256) return "blocked";

  if (file === "missing") return "advance";

  if (file === "other") return "pending";
  const has = sha256(file);

  if (has === wanted) return "advance";

  return has === receipt.sha256 ? "replace" : "pending";
}

function readStoredSeed(dir: string, hash: string): Buffer | undefined {
  return existsSync(join(dir, seedStore, hash)) ? readFileSync(join(dir, seedStore, hash)) : undefined;
}

function readPackageSeed(folder: string, file: string): Buffer | undefined {
  return lstatSync(join(folder, file), { throwIfNoEntry: false })?.isFile() ? readFileSync(join(folder, file)) : undefined;
}

/** The office's file at seeded path `file` (`OfficeFile`). A path office won't handle (`seedPathProblem`) is `other`. */
function readOfficeFile(dir: string, file: string): OfficeFile {
  if (seedPathProblem(dir, file) !== undefined) return "other";
  const info = lstatSync(join(dir, file), { throwIfNoEntry: false });

  if (info === undefined) return "missing";

  return info.isFile() ? readFileSync(join(dir, file)) : "other";
}

/** A seeded path's class, with the package's seed (undefined when it has none) and the office's file it was decided from. */
export type SeedState = { state: SeedClass; seed: Buffer | undefined; has: OfficeFile };

/** Reads a receipt's inputs in the office at `dir` and classifies it; `folder` is its package's seed folder. */
export function inspectSeed(dir: string, file: string, receipt: SeedReceipt, folder: string): SeedState {
  const stored = "sha256" in receipt ? readStoredSeed(dir, receipt.sha256) : undefined;
  const seed = readPackageSeed(folder, file);
  const has = readOfficeFile(dir, file);

  return { state: classifySeed(receipt, stored, seed, has), seed, has };
}

/** Why a `blocked` path's stored seed can't be used, with how to repair it (`restoreAdvice`). */
export function blockedReason(dir: string, receipt: SeedReceipt): string {
  // Only a receipt with a hash is ever blocked (classifySeed).
  if (!("sha256" in receipt)) return "its stored seed can't be read";
  const stored = `${seedStore}/${receipt.sha256}`;
  const problem = existsSync(join(dir, stored)) ? "doesn't hash to its name" : "is missing";

  return `the seed office laid down, ${stored}, ${problem}; ${restoreAdvice(receipt.sha256)}`;
}

/**
 * Lays down package `name`'s seed `file` from its seed folder `folder` at a path with no receipt in
 * the office at `dir`, unless a file is already there, and records its receipt in `seeds`. The seed
 * is stored first (`storeSeed`), so a receipt never names a seed that isn't stored.
 */
function createSeed(dir: string, name: string, folder: string, file: string, seeds: Map<string, SeedReceipt>): string[] {
  const problem = seedPathProblem(dir, file);

  if (problem !== undefined) return [`FAILED package ${name}'s ${seedFolder}/${file}: ${problem}`];
  const target = join(dir, file);

  if (lstatSync(target, { throwIfNoEntry: false })) {
    seeds.set(file, { package: name, existing: true });

    return [`kept ${file}, which was already there, instead of package ${name}'s copy`];
  }

  // The receipt holds the hash of the bytes stored and written, read once from the package's copy.
  const source = join(folder, file);
  const bytes = readFileSync(source);
  const hash = sha256(bytes);

  storeSeed(dir, hash, bytes);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, bytes, { flag: "wx", mode: statSync(source).mode & 0o777 });
  seeds.set(file, { package: name, sha256: hash });

  return [`created ${file} from package ${name}`];
}

/**
 * Acts on package `name`'s receipt for `file` in the office at `dir`, whose seed folder is
 * `folder`, editing `seeds` (the lock's section, under the lease) as `SeedClass` says. The new
 * seed is stored before the file is replaced and before its receipt is recorded.
 */
function updateSeed(dir: string, name: string, folder: string, file: string, receipt: SeedReceipt, seeds: Map<string, SeedReceipt>): string[] {
  const { state, seed, has } = inspectSeed(dir, file, receipt, folder);

  if (state === "pending") return [`pending ${file}: package ${name} changed its seed, and the file differs from the seed office laid down; office seeds diff ${shellWord(file)}`];

  if (state === "blocked") return [`kept ${file}: package ${name} changed its seed, but ${blockedReason(dir, receipt)}`];

  if ((state !== "replace" && state !== "advance") || seed === undefined) return [];
  const hash = sha256(seed);

  storeSeed(dir, hash, seed);

  if (state === "replace") atomicWrite(join(dir, file), seed, statSync(join(folder, file)).mode & 0o777, join(dir, staging));
  seeds.set(file, { package: name, sha256: hash });

  if (state === "replace") return [`updated ${file} to package ${name}'s new seed, as the file was unchanged`];

  return [`recorded package ${name}'s new seed for ${file}, ${has === "missing" ? "which stays deleted" : "which already has it"}`];
}

/**
 * Applies package `name`'s seed `files` (paths under its seed folder, `folder`) to the office at
 * `dir`. A path with no receipt is created (`createSeed`); a path with the package's receipt is
 * updated as `classifySeed` says (`updateSeed`): an unchanged file is replaced, a deleted one or
 * one already equal to the new seed gets the new receipt, and a pending or blocked one is reported
 * and left. A receipt of the package for a path it no longer seeds is dropped and its file left. A
 * path the section couldn't hold, one in `.office/` and one through a link are refused and get no
 * receipt. A path that fails is reported and the others go ahead, so the receipts of the files
 * handled are saved. Returns one line per change or report; a failure starts with FAILED.
 */
export function applySeeds(dir: string, name: string, folder: string, files: string[]): string[] {
  try {
    return editLock(dir, ({ seeds }) => {
      const lines = files.flatMap((file) => {
        const receipt = seeds.get(file);

        // A path another package seeded stays with it: two packages may not seed one path.
        if (receipt !== undefined && receipt.package !== name) return [];

        try {
          return receipt === undefined ? createSeed(dir, name, folder, file, seeds) : updateSeed(dir, name, folder, file, receipt, seeds);
        } catch (error) {
          return [`FAILED package ${name}'s ${seedFolder}/${file}: ${message(error)}`];
        }
      });
      const shipped = new Set(files);

      for (const file of [...seeds.keys()].sort()) {
        if (seeds.get(file)?.package !== name || shipped.has(file)) continue;
        seeds.delete(file);
        lines.push(`kept ${file}, which package ${name} no longer seeds, and dropped its receipt`);
      }

      return lines;
    });
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
      return [`${file}: its seed ${stored} is missing; ${restoreAdvice(receipt.sha256)}`];
    }

    return sha256(bytes) === receipt.sha256 ? [] : [`${file}: its seed ${stored} doesn't hash to its name; ${restoreAdvice(receipt.sha256)}`];
  });
}
