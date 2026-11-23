// Seeded files: files a package declares in its `setup` (handles.ts), laid down once in the office
// and the owner's from then on. Each path a package handles gets a receipt (store.ts): the SHA-256
// of the bytes office created, or `existing: true` for a file that was already there. Sync never
// creates a file for a path with a receipt again, so a seeded file the office deletes stays deleted
// on every clone. Seeds never deletes an owner's file.
//
// When a package's seed changes, `classifySeed` compares the receipt, the stored seed, the
// package's seed and the office's file: sync replaces only a file whose bytes equal the stored
// seed, and a file with other bytes is pending until `office seeds settle` records the new seed.
// Nothing about pending is stored; it is worked out on each run.
import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Entry, Problem } from "@office/sdk";
import type { Seed } from "./handles.ts";
import { atomicWrite, byPath, keepSeedAttributes, message, plainPath, readReceipts, readStoredSeed, type Receipt, type Receipts, receiptsFile, sameReceipts, seedsCommand, seedStore, sha256, storedSeedFault, storeSeed, writeReceipts } from "./store.ts";

/** A seed file as the declarations want it: its office path, its package, its bytes and mode, and the package file it came from (none for text). */
export type Desired = { path: string; owner: string; bytes: Buffer; mode: number; origin?: string };

/** The desired seed files, by office path. */
export type DesiredSeeds = Map<string, Desired>;

/**
 * Why office won't lay a seed at `file` in the office at `dir`: a path that isn't plain, a path in
 * `.office/`, which is office's own, or a folder on the way to it that is a link or not a folder,
 * which could lead outside the office. Folders that don't exist yet are fine: they are made as
 * real folders.
 */
function destinationProblem(dir: string, file: string): string | undefined {
  if (!plainPath(file)) return "not a plain path relative to the office";
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

/** A source's files and folders, by their paths relative to the source; a folder source's own is "". */
type Found = { files: { relative: string; path: string }[]; folders: string[]; problems: string[] };

/** Every file and folder under folder `path` (relative paths below it, sorted), refusing a link or anything but files and folders. */
function filesUnder(path: string, below: string, found: Found): void {
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((left, right) => (left.name < right.name ? -1 : 1))) {
    const relative = below === "" ? entry.name : `${below}/${entry.name}`;
    const full = join(path, entry.name);

    if (entry.isSymbolicLink()) found.problems.push(`${relative} is a link, which seeds don't follow`);
    else if (entry.isDirectory()) {
      found.folders.push(relative);
      filesUnder(full, relative, found);
    }
    else if (entry.isFile()) found.files.push({ relative, path: full });
    else found.problems.push(`${relative} is not a file or a folder`);
  }
}

/**
 * The files `source` names in a package loaded from `folder`: itself when it is a file, every file
 * under it when it is a folder. The package's folder may be a link, and is resolved first; nothing
 * below it may be one, so a source never leads outside the package.
 */
function sourceFiles(folder: string, source: string): Found {
  if (!plainPath(source)) return { files: [], folders: [], problems: [`source ${source} is not a path inside the package`] };
  let root: string;

  try {
    root = realpathSync(folder);
  } catch (error) {
    return { files: [], folders: [], problems: [`its folder ${folder} can't be read: ${message(error)}`] };
  }

  try {
    return filesOf(root, source);
  } catch (error) {
    return { files: [], folders: [], problems: [`source ${source} can't be read: ${message(error)}`] };
  }
}

/** `sourceFiles` below the package's resolved folder `root`; throws when the filesystem does. */
function filesOf(root: string, source: string): Found {
  const parts = source.split("/");

  for (let depth = 1; depth <= parts.length; depth++) {
    const path = join(root, ...parts.slice(0, depth));
    const info = lstatSync(path, { throwIfNoEntry: false });

    if (info === undefined || (depth < parts.length && info.isFile())) return { files: [], folders: [], problems: [`source ${source} does not exist in the package`] };

    if (info.isSymbolicLink()) return { files: [], folders: [], problems: [`source ${source}: ${parts.slice(0, depth).join("/")} is a link, which seeds don't follow`] };

    if (depth < parts.length) continue;

    if (info.isFile()) return { files: [{ relative: "", path }], folders: [], problems: [] };

    if (!info.isDirectory()) return { files: [], folders: [], problems: [`source ${source} is not a file or a folder`] };
    const found: Found = { files: [], folders: [""], problems: [] };

    filesUnder(path, "", found);

    return { ...found, problems: found.problems.map(problem => `source ${source}: ${problem}`) };
  }

  return { files: [], folders: [], problems: [`source ${source} does not exist in the package`] };
}

const owners = (left: string, right: string) => (left === right ? `package ${left} twice` : `both package ${left} and package ${right}`);

/** Why office won't lay a seed at `file` (`destinationProblem`), with a filesystem error as the reason. */
function destinationRefusal(dir: string, file: string): string | undefined {
  try {
    return destinationProblem(dir, file);
  } catch (error) {
    return `can't be checked: ${message(error)}`;
  }
}

/**
 * Every declared seed, resolved in the office at `dir`: sources found in their package and read,
 * folders expanded to their files, text as bytes. Checks everything before anything is written:
 * sources exist and stay inside their package, each declared destination and each file under it is
 * a plain path outside `.office/` with no link or file on the way, whether or not a folder holds
 * any file, no two declarations give one file, and no file is where a declaration has a folder,
 * even a folder holding no file. Clashes are found whatever is wrong with the paths. Throws listing
 * every problem, each naming its package.
 */
export function resolveSeeds(dir: string, declarations: readonly Entry<Seed>[]): DesiredSeeds {
  const desired: DesiredSeeds = new Map();
  // The folders a folder source lays down, empty ones too: only checked against files, never made on their own.
  const folders: { path: string; owner: string }[] = [];
  const problems: string[] = [];

  for (const { value, owner, folder } of declarations) {
    const declared = `package ${owner}'s seed ${value.destination}`;
    const refused = destinationRefusal(dir, value.destination);
    const files: Desired[] = [];

    if (refused !== undefined) problems.push(`${declared}: ${value.destination}: ${refused}`);

    if ("text" in value) files.push({ path: value.destination, owner, bytes: Buffer.from(value.text), mode: 0o644 });
    else {
      const found = sourceFiles(folder, value.source);

      problems.push(...found.problems.map(problem => `${declared}: ${problem}`));
      folders.push(...found.folders.map(relative => ({ path: relative === "" ? value.destination : `${value.destination}/${relative}`, owner })));

      for (const file of found.files) {
        try {
          files.push({ path: file.relative === "" ? value.destination : `${value.destination}/${file.relative}`, owner, bytes: readFileSync(file.path), mode: statSync(file.path).mode & 0o777, origin: file.path });
        } catch (error) {
          problems.push(`${declared}: ${file.path} can't be read: ${message(error)}`);
        }
      }
    }

    for (const file of files) {
      const first = desired.get(file.path);

      if (first !== undefined) {
        problems.push(`${file.path} is seeded by ${owners(first.owner, owner)}`);
        continue;
      }

      desired.set(file.path, file);

      // A file below an accepted destination: its own name and the folders under the destination.
      const below = refused === undefined && file.path !== value.destination ? destinationRefusal(dir, file.path) : undefined;

      if (below !== undefined) problems.push(`${declared}: ${file.path}: ${below}`);
    }
  }

  // A file where another declaration needs a folder: for a file below it, then for a folder at or below it not yet named.
  const named = new Set<string>();

  for (const [path, file] of desired) {
    const parts = path.split("/");

    for (let depth = 1; depth < parts.length; depth++) {
      const above = desired.get(parts.slice(0, depth).join("/"));

      if (above === undefined) continue;
      named.add(`${above.path}\0${file.owner}`);
      problems.push(`${above.path} is a file seeded by package ${above.owner}, but package ${file.owner} seeds ${path} under it`);
    }
  }

  for (const folder of folders) {
    const parts = folder.path.split("/");

    for (let depth = 1; depth <= parts.length; depth++) {
      const above = desired.get(parts.slice(0, depth).join("/"));

      if (above === undefined || named.has(`${above.path}\0${folder.owner}`)) continue;
      named.add(`${above.path}\0${folder.owner}`);
      problems.push(`${above.path} is a file seeded by package ${above.owner}, but package ${folder.owner} seeds the folder ${folder.path}${depth === parts.length ? " there" : " under it"}`);
    }
  }

  if (problems.length) throw new Error(`no seed was written: ${problems.join("; ")}`);

  return desired;
}

/**
 * What to do with a seeded path, from `classifySeed`:
 * - `current`: the package's seed is the one the receipt names; nothing to do, whatever the file holds.
 * - `replace`: the seed changed and the file still has the stored seed's bytes; sync replaces it.
 * - `advance`: the seed changed and the file is deleted or already has the new seed's bytes; sync records the new seed.
 * - `pending`: the seed changed and the file has other bytes; left to the owner (`office seeds diff`, `office seeds settle`).
 * - `dropped`: the receipt's package no longer seeds the path; sync leaves the file and drops the receipt.
 * - `blocked`: the seed changed and the stored seed is missing, isn't a file or doesn't hash to its name; nothing changes until Git restores it.
 * - `unowned`: the receipt marks a file that was already there, which has no stored seed; never offered.
 */
export type SeedClass = "current" | "replace" | "advance" | "pending" | "dropped" | "blocked" | "unowned";

/** The office's file at a seeded path: its bytes, `missing`, or `other` for anything office won't read as the file (a folder, a link, a path through a link). */
export type OfficeFile = Buffer | "missing" | "other";

/**
 * Classifies a seeded path from its receipt, the stored seed's bytes (undefined when not stored),
 * the receipt's package's current seed (undefined when it has none for the path) and the office's
 * file. Pure: sync, check and the seeds commands all decide through it.
 */
export function classifySeed(receipt: Receipt, stored: Buffer | undefined, seed: Buffer | undefined, file: OfficeFile): SeedClass {
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

/** The office's file at seeded path `file` (`OfficeFile`). A path office won't handle is `other`. */
function readOfficeFile(dir: string, file: string): OfficeFile {
  if (destinationProblem(dir, file) !== undefined) return "other";
  const info = lstatSync(join(dir, file), { throwIfNoEntry: false });

  if (info === undefined) return "missing";

  return info.isFile() ? readFileSync(join(dir, file)) : "other";
}

/** A receipted path, classified: the seed its package declares for it now (none when dropped) and the office's file it was decided from. */
export type SeededPath = { file: string; receipt: Receipt; state: SeedClass; seed: Desired | undefined; has: OfficeFile };

/**
 * Reads a receipt's inputs in the office at `dir` and classifies it against what its own package
 * declares: `declared` is the seed declared for `file`, by any package.
 */
export function inspectSeed(dir: string, file: string, receipt: Receipt, declared: Desired | undefined): SeededPath {
  const seed = declared?.owner === receipt.package ? declared : undefined;
  const stored = "sha256" in receipt ? readStoredSeed(dir, receipt.sha256) : undefined;
  const has = readOfficeFile(dir, file);

  return { file, receipt, state: classifySeed(receipt, stored, seed?.bytes, has), seed, has };
}

/** Why a `blocked` path's stored seed can't be used, with how to repair it (`restoreAdvice`). */
export function blockedReason(dir: string, receipt: Receipt): string {
  // Only a receipt with a hash is ever blocked (classifySeed), and only when its stored seed has a fault.
  if (!("sha256" in receipt)) return "its stored seed can't be read";

  return `the seed office laid down, ${seedStore}/${receipt.sha256}, ${storedSeedFault(dir, receipt.sha256) ?? "can't be read"}`;
}

/**
 * Lays down `seed` at a path with no receipt in the office at `dir`, unless something is already
 * there, and records its receipt in `receipts`. The seed is stored first (`storeSeed`), so a
 * receipt never names a seed that isn't stored.
 */
function createSeed(dir: string, seed: Desired, receipts: Receipts): string {
  const target = join(dir, seed.path);

  if (lstatSync(target, { throwIfNoEntry: false })) {
    receipts.set(seed.path, { package: seed.owner, existing: true });

    return `kept ${seed.path}, which was already there, instead of package ${seed.owner}'s seed`;
  }

  const hash = sha256(seed.bytes);

  storeSeed(dir, hash, seed.bytes);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, seed.bytes, { flag: "wx", mode: seed.mode });
  // The file this run just created takes the seed's mode, whatever the umask.
  chmodSync(target, seed.mode);
  receipts.set(seed.path, { package: seed.owner, sha256: hash });

  return `created ${seed.path} from package ${seed.owner}`;
}

/**
 * Acts on the receipt for `seed`'s path, which its own package holds, as `classifySeed` says. The
 * new seed is stored before the file is replaced and before its receipt is recorded.
 */
function updateSeed(dir: string, seed: Desired, receipt: Receipt, receipts: Receipts): string | undefined {
  const { state, has } = inspectSeed(dir, seed.path, receipt, seed);
  const name = seed.owner;

  if (state === "pending") return `pending ${seed.path}: package ${name} changed its seed, and the file differs from the seed office laid down; ${seedsCommand("diff", seed.path)}`;

  if (state === "blocked") return `kept ${seed.path}: package ${name} changed its seed, but ${blockedReason(dir, receipt)}`;

  if (state !== "replace" && state !== "advance") return undefined;
  const hash = sha256(seed.bytes);

  storeSeed(dir, hash, seed.bytes);

  if (state === "replace") atomicWrite(join(dir, seed.path), seed.bytes, seed.mode, join(dir, ".office"));
  receipts.set(seed.path, { package: name, sha256: hash });

  if (state === "replace") return `updated ${seed.path} to package ${name}'s new seed, as the file was unchanged`;

  return `recorded package ${name}'s new seed for ${seed.path}, ${has === "missing" ? "which stays deleted" : "which already has it"}`;
}

/**
 * The seeds package's `sync`: lays down every declared seed in the office at `dir`. It reads the
 * receipts and checks every declaration first (`resolveSeeds`), so a problem writes nothing. Then a
 * receipt whose path no package declares, or that another package now declares, is dropped and its
 * file left, whatever is at the path; each declared path with no receipt is created (or marked as
 * already there), and one with its package's receipt is updated as `classifySeed` says. The store's
 * `.gitattributes` is kept before the receipts are written. When a write fails part-way the
 * receipts of the files already written are saved, then it throws naming the path, and saying
 * whether the receipts could be saved. Returns one line per change or report.
 */
export function applySeeds(dir: string, declarations: readonly Entry<Seed>[]): string[] {
  const receipts = readReceipts(dir);
  const desired = resolveSeeds(dir, declarations);
  const next: Receipts = new Map(receipts);
  const lines: string[] = [];

  for (const [path, receipt] of byPath(receipts)) {
    if (desired.get(path)?.owner === receipt.package) continue;
    next.delete(path);
    lines.push(`left in place: ${path} (package ${receipt.package} no longer seeds it)`);
  }

  let failure: string | undefined;

  for (const [, seed] of byPath(desired)) {
    const receipt = next.get(seed.path);

    try {
      const line = receipt === undefined ? createSeed(dir, seed, next) : updateSeed(dir, seed, receipt, next);

      if (line !== undefined) lines.push(line);
    } catch (error) {
      failure = `package ${seed.owner}'s seed ${seed.path}: ${message(error)}`;
      break;
    }
  }

  const changed = !sameReceipts(receipts, next);
  const failures: string[] = [];
  let saved = true;

  try {
    lines.push(...keepSeedAttributes(dir, changed));
  } catch (error) {
    failures.push(message(error));
  }

  if (changed) {
    try {
      writeReceipts(dir, next);
    } catch (error) {
      saved = false;
      failures.push(`could not save ${receiptsFile}: ${message(error)}`);
    }
  }

  if (failure !== undefined) failures.unshift(saved ? `${failure}; the receipts of the files written before it are saved` : failure);

  if (failures.length) throw new Error(failures.join("; "));

  return lines;
}

/** Receipts whose stored seed is missing, isn't a file or doesn't hash to its name, one line each. Reads only. */
function storedSeedProblems(dir: string, receipts: Receipts): string[] {
  return byPath(receipts).flatMap(([file, receipt]) => {
    if (!("sha256" in receipt)) return [];
    const fault = storedSeedFault(dir, receipt.sha256);

    return fault === undefined ? [] : [`${file}: its seed ${seedStore}/${receipt.sha256} ${fault}`];
  });
}

/**
 * The seeds package's `check`, which reads only: a failure for a receipts file or declarations sync
 * would stop on; a warning for each stored seed that is missing, not a file or corrupt, for each receipt sync
 * will drop, and one with the count of pending paths.
 */
export function seedProblems(dir: string, declarations: readonly Entry<Seed>[]): Problem[] {
  let receipts: Receipts;

  try {
    receipts = readReceipts(dir);
  } catch (error) {
    return [{ level: "failed", message: message(error) }];
  }

  const problems: Problem[] = storedSeedProblems(dir, receipts).map(line => ({ level: "warning", message: line }));
  let desired: DesiredSeeds;

  try {
    desired = resolveSeeds(dir, declarations);
  } catch (error) {
    return [...problems, { level: "failed", message: `office sync stops on the seed declarations: ${message(error)}` }];
  }

  let pending = 0;

  for (const [file, receipt] of byPath(receipts)) {
    const { state } = inspectSeed(dir, file, receipt, desired.get(file));

    if (state === "dropped") problems.push({ level: "warning", message: `${file}: package ${receipt.package} no longer seeds it; office sync drops its receipt and leaves the file` });

    if (state === "pending") pending++;
  }

  if (pending > 0) problems.push({ level: "warning", message: `${pending} ${pending === 1 ? "seed" : "seeds"} pending; office seeds diff` });

  return problems;
}
