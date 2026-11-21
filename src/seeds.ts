// Seed files: the files under a package's `template/` folder, copied once into the office. Each
// path a package handles gets a receipt in office.lock's `seeds:` section, which is committed: the
// SHA-256 of the bytes office created, or `existing: true` for a file that was already there. Sync
// never copies a path with a receipt again, so a seed file the office deletes stays deleted on
// every clone, and removing a package deletes a file it created only while it matches the receipt.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { officeRelativePath, type SeedReceipt } from "./schema.ts";
import { editLock, lockFile, readLockSection } from "./versions.ts";

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Why office won't handle the seed file at `file` in the office at `dir`: a path the `seeds:`
 * section couldn't hold, or a folder on the way to it that is a link or not a folder, which could
 * lead outside the office. Folders that don't exist yet are fine: they are made as real folders.
 */
function seedPathProblem(dir: string, file: string): string | undefined {
  if (!officeRelativePath(file)) return "not a plain office-relative path";
  const parts = file.split("/");

  for (let depth = 1; depth < parts.length; depth++) {
    const folder = parts.slice(0, depth).join("/");
    const info = lstatSync(join(dir, folder), { throwIfNoEntry: false });

    if (info === undefined) return undefined;

    if (!info.isDirectory()) return `${folder} is ${info.isSymbolicLink() ? "a link" : "not a folder"}, which office doesn't follow`;
  }

  return undefined;
}

/**
 * Copies each of package `name`'s seed `files` (paths under its `template` folder) that has no
 * receipt to the same path in the office at `dir`, unless a file is already there, and records a
 * receipt for each. A path the section couldn't hold, or one through a link, is refused and gets
 * no receipt. A copy that fails is reported and the other files go ahead, so the receipts of the
 * files copied are saved. Returns one line per change; a failure starts with FAILED.
 */
export function copySeeds(dir: string, name: string, template: string, files: string[]): string[] {
  try {
    return editLock(dir, ({ seeds }) => files.flatMap((file) => {
      if (seeds.has(file)) return [];
      const problem = seedPathProblem(dir, file);

      if (problem !== undefined) return [`FAILED package ${name}'s template/${file}: ${problem}`];
      const target = join(dir, file);

      if (lstatSync(target, { throwIfNoEntry: false })) {
        seeds.set(file, { package: name, existing: true });

        return [`kept ${file}, which was already there, instead of package ${name}'s copy`];
      }

      try {
        // The receipt holds the hash of the bytes written, read once from the package's copy.
        const source = join(template, file);
        const bytes = readFileSync(source);

        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, bytes, { flag: "wx", mode: statSync(source).mode & 0o777 });
        seeds.set(file, { package: name, sha256: sha256(bytes) });
      } catch (error) {
        return [`FAILED package ${name}'s template/${file}: ${message(error)}`];
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
