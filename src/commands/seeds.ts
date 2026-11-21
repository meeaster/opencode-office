// `office seeds diff [path]` and `office seeds settle <path>`: what a package changed in a seed and
// what the owner changed in their file, and the record that the owner has dealt with an update.
// Both decide through `classifySeed` (src/seeds.ts), as sync and check do.
import { spawnSync } from "node:child_process";
import { join, relative } from "node:path";

import { installedPackages } from "../layout.ts";
import { type Office, OfficeError } from "../office.ts";
import type { SeedReceipt } from "../schema.ts";
import { blockedReason, inspectSeed, keepSeedAttributes, type SeedState, seedFolder, seedStore, sha256, shellWord, storeSeed } from "../seeds.ts";
import { editLock, lockFile, readLockSection } from "../versions.ts";

export type SeededPath = SeedState & { file: string; receipt: SeedReceipt; folder: string };

/** The guidance `seeds diff` prints after both diffs, where the owner's agent decides. */
export const guidance = ["Keep owner deletions deleted, including package rewrites of deleted rules or sections.", "If nothing else applies, leave the file unchanged and settle."];

const settleCommand = (file: string) => `office seeds settle ${shellWord(file)}`;

/** Each installed package's seed folder, by name. A package that can't be read has none, so none of its paths is classified. */
function seedFolders(office: Office): Map<string, string> {
  return new Map(installedPackages(office).installed.map((item) => [item.entry.name, join(item.dir, seedFolder)]));
}

function inspect(office: Office, file: string, receipt: SeedReceipt, folder: string): SeededPath {
  return { file, receipt, folder, ...inspectSeed(office.dir, file, receipt, folder) };
}

/** Every receipt in the office whose package is installed, classified. Reads only. */
export function seededPaths(office: Office): SeededPath[] {
  const seeds = readLockSection(office.dir, "seeds");
  const folders = seedFolders(office);

  return [...seeds.keys()].sort().flatMap((file) => {
    const receipt = seeds.get(file);
    const folder = receipt && folders.get(receipt.package);

    return receipt === undefined || folder === undefined ? [] : [inspect(office, file, receipt, folder)];
  });
}

/** Seeded path `path` with its receipt, classified, or an OfficeError saying why it can't be. */
function inspectPath(office: Office, path: string, receipt: SeedReceipt | undefined): SeededPath {
  if (receipt === undefined) throw new OfficeError(`no package seeded ${path}: ${lockFile} has no seed receipt for it (give the path relative to the office's folder)`);
  const folder = seedFolders(office).get(receipt.package);

  if (folder === undefined) throw new OfficeError(`package ${receipt.package}, which seeded ${path}, isn't installed or couldn't be read; run office sync`);

  return inspect(office, path, receipt, folder);
}

/** The one path `path` names, classified from the lock as it is now. */
function seededPath(office: Office, path: string): SeededPath {
  return inspectPath(office, path, readLockSection(office.dir, "seeds").get(path));
}

/** `git diff --no-index` of two files, run in the office's folder; `/dev/null` stands for a missing one. */
function gitDiff(dir: string, from: string, to: string): string {
  const name = (path: string) => (path === "/dev/null" ? path : relative(dir, path));
  const args = ["-c", "core.quotePath=false", "diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--", name(from), name(to)];
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const stderr = (result.stderr ?? "").trim();

  // Status 1 means the files differ, not a failure, unless git also complained.
  if (result.error !== undefined || stderr !== "" || (result.status !== 0 && result.status !== 1)) throw new OfficeError(`git diff --no-index failed: ${stderr || result.error?.message || `status ${result.status}`}`);

  if (result.status === 0) return "(no differences)";

  return result.stdout.trimEnd();
}

/** Where the office's file is for a diff: its path, `/dev/null` when deleted, or undefined when office won't read it. */
function officeSide(dir: string, item: SeededPath): string | undefined {
  if (item.has === "other") return undefined;

  return item.has === "missing" ? "/dev/null" : join(dir, item.file);
}

const failedFor = (path: SeededPath, reason: string) => new OfficeError(`${path.file}: ${reason}`);

/**
 * `office seeds diff [path]`'s output. Without a path, the pending paths with their packages; with
 * one, for a pending path, what the package changed and what the owner changed, the guidance and
 * the settle command; for a file that was already there, a plain comparison for manual review.
 * Changes nothing. Throws an OfficeError for a path without a receipt, a dropped seed or a missing
 * stored seed.
 */
export function seedsDiff(office: Office, path?: string): string {
  if (path === undefined) {
    const pending = seededPaths(office).filter((item) => item.state === "pending");

    if (pending.length === 0) return "No seeds are pending.";

    return ["Pending seeds (the package changed its seed, and the file differs from the seed office laid down):", ...pending.map((item) => `  ${item.file} (package ${item.receipt.package})`), "", "Show one with office seeds diff <path>."].join("\n");
  }

  const item = seededPath(office, path);
  const name = item.receipt.package;
  const seed = join(item.folder, path);
  const settle = ["When you have dealt with it:", `  ${settleCommand(path)}`];

  switch (item.state) {
    case "dropped":
      throw failedFor(item, `package ${name} no longer seeds it (office sync drops its receipt and leaves the file)`);
    case "blocked":
      throw failedFor(item, `package ${name} changed its seed, but ${blockedReason(office.dir, item.receipt)}`);
    case "current":
      return `${path} is current: package ${name}'s seed is the one office laid down.`;
    case "replace":
      return `${path} is current: the file is unchanged, so office sync replaces it with package ${name}'s new seed.`;
    case "advance":
      return `${path} is current: the file is deleted or already has package ${name}'s new seed, so office sync records it.`;
    case "unowned": {
      const mine = officeSide(office.dir, item);

      return [
        `${path} was already there when package ${name} was installed, so office has no seed it laid down to compare with.`,
        "This comparison cannot tell a package addition from an owner deletion; it needs manual review.",
        "",
        `Your file → package ${name}'s seed now:`,
        mine === undefined ? `  ${path} isn't a file office reads.` : gitDiff(office.dir, mine, seed),
        "",
        ...settle,
      ].join("\n");
    }

    case "pending": {
      // Only a receipt with a hash is ever pending (classifySeed).
      if (!("sha256" in item.receipt)) throw failedFor(item, "its receipt has no seed to compare with");
      const stored = join(office.dir, seedStore, item.receipt.sha256);
      const mine = officeSide(office.dir, item);

      return [
        `What package ${name} changed (the seed office laid down → package ${name}'s seed now):`,
        gitDiff(office.dir, stored, seed),
        "",
        "What you changed (the seed office laid down → your file):",
        mine === undefined ? `  ${path} isn't a file office reads.` : gitDiff(office.dir, stored, mine),
        "",
        ...guidance,
        "",
        ...settle,
      ].join("\n");
    }
  }
}

/** Throws the OfficeError for a path settle refuses: a dropped seed or a blocked one. */
function refuseSettle(office: Office, item: SeededPath): void {
  const name = item.receipt.package;

  if (item.state === "dropped" || item.seed === undefined) throw failedFor(item, `package ${name} no longer has a seed for it, so there is nothing to settle (office sync drops its receipt and leaves the file)`);

  if (item.state === "blocked") throw failedFor(item, `not settled: ${blockedReason(office.dir, item.receipt)}`);
}

const currentMessage = (item: SeededPath) => `${item.file} is current: package ${item.receipt.package}'s seed is the one its receipt names; nothing to settle.`;

/**
 * `office seeds settle <path>`: stores the package's current seed, ensures the store's
 * `.gitattributes`, then records its SHA-256 in the path's receipt, under the publication lease,
 * without touching the office's file. Settling an unchanged file declines sync's replacement. A
 * path already current is left as it is, without the lease. Throws an OfficeError, changing no
 * receipt, for a path without a receipt, a dropped seed or a missing stored seed. Returns what it did.
 */
export function settleSeed(office: Office, path: string): string {
  // Fail, or find nothing to do, before taking the lease.
  const early = seededPath(office, path);

  refuseSettle(office, early);

  if (early.state === "current") return currentMessage(early);

  return editLock(office.dir, ({ seeds }) => {
    // The receipt, and so its package's folder, may have changed before the lease was taken.
    const item = inspectPath(office, path, seeds.get(path));
    const name = item.receipt.package;

    refuseSettle(office, item);

    if (item.state === "current" || item.seed === undefined) return currentMessage(item);
    const hash = sha256(item.seed);

    try {
      storeSeed(office.dir, hash, item.seed);
    } catch (error) {
      throw failedFor(item, `not settled: ${error instanceof Error ? error.message : String(error)}`);
    }

    // The first seed an office stores, as when settling a file that was already there, needs the store's guard.
    const guard = keepSeedAttributes(office.dir).find((line) => line.startsWith("FAILED"));

    if (guard !== undefined) throw failedFor(item, `not settled: ${guard}`);
    seeds.set(path, { package: name, sha256: hash });
    const recorded = `settled ${path}: recorded package ${name}'s seed ${hash.slice(0, 12)}, stored as ${seedStore}/${hash}`;
    const commit = `Commit ${lockFile} and ${seedStore}/.`;

    if (item.state === "replace") return `${recorded}, declining the automatic replacement: the file stays as it is, and office sync won't replace it with this seed. ${commit}`;

    return `${recorded}; the file is unchanged. ${commit}`;
  });
}
