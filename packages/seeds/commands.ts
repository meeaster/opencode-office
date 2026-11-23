// `office seeds diff [<path>]` and `office seeds settle <path>`: what a package changed in a seed
// and what the owner changed in their file, and the record that the owner has dealt with an update.
// Both decide through `classifySeed` (seeds.ts), as sync and check do.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

import type { CommandInputs, Entry } from "@office/sdk";
import { type Seed, seeds } from "./handles.ts";
import { blockedReason, type DesiredSeeds, inspectSeed, resolveSeeds, type SeededPath } from "./seeds.ts";
import { byPath, keepSeedAttributes, message, readReceipts, receiptsFile, seedsCommand, seedStore, sha256, storeSeed, writeReceipts } from "./store.ts";

/** The guidance `seeds diff` prints after both diffs, where the owner's agent decides. */
export const guidance = ["Keep owner deletions deleted, including package rewrites of deleted rules or sections.", "If nothing else applies, leave the file unchanged and settle."];

/** Every receipt in the office at `dir`, classified against the declarations. Reads only. */
function seededPaths(dir: string, desired: DesiredSeeds): SeededPath[] {
  return byPath(readReceipts(dir)).map(([file, receipt]) => inspectSeed(dir, file, receipt, desired.get(file)));
}

/** Seeded path `path`, classified from the receipts as they are now, or an Error saying why it can't be. */
function seededPath(dir: string, desired: DesiredSeeds, path: string): SeededPath {
  const receipt = readReceipts(dir).get(path);

  if (receipt === undefined) throw new Error(`no package seeded ${path}: ${receiptsFile} has no receipt for it (give the path relative to the office's folder)`);

  return inspectSeed(dir, path, receipt, desired.get(path));
}

/** `git diff --no-index` of two files, run in the office's folder; `/dev/null` stands for a missing one. */
function gitDiff(dir: string, from: string, to: string): string {
  const name = (path: string) => (path === "/dev/null" ? path : relative(dir, path));
  const args = ["-c", "core.quotePath=false", "diff", "--no-index", "--no-color", "--no-ext-diff", "--no-textconv", "--", name(from), name(to)];
  const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const stderr = (result.stderr ?? "").trim();

  // Status 1 means the files differ, not a failure, unless git also complained.
  if (result.error !== undefined || stderr !== "" || (result.status !== 0 && result.status !== 1)) throw new Error(`git diff --no-index failed: ${stderr || result.error?.message || `status ${result.status}`}`);

  if (result.status === 0) return "(no differences)";

  return result.stdout.trimEnd();
}

/** Where the office's file is for a diff: its path, `/dev/null` when deleted, or undefined when office won't read it. */
function officeSide(dir: string, item: SeededPath): string | undefined {
  if (item.has === "other") return undefined;

  return item.has === "missing" ? "/dev/null" : join(dir, item.file);
}

/**
 * Runs `use` with a file holding the package's seed: its file in the package, or, for a text seed,
 * a temporary file outside the office, removed afterwards.
 */
function withSeedFile<T>(item: SeededPath, use: (path: string) => T): T {
  if (item.seed?.origin !== undefined) return use(item.seed.origin);
  const folder = mkdtempSync(join(tmpdir(), "office-seed-"));

  try {
    const path = join(folder, basename(item.file));

    writeFileSync(path, item.seed?.bytes ?? Buffer.alloc(0));

    return use(path);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

const failedFor = (path: SeededPath, reason: string) => new Error(`${path.file}: ${reason}`);

/**
 * `office seeds diff [path]`'s output. Without a path, the pending paths with their packages; with
 * one, for a pending path, what the package changed and what the owner changed, the guidance and
 * the settle command; for a file that was already there, a plain comparison for manual review.
 * Writes nothing in the office. Throws for a path without a receipt, a dropped seed or a missing
 * stored seed.
 */
export function seedsDiff(dir: string, declarations: readonly Entry<Seed>[], path?: string): string {
  const desired = resolveSeeds(dir, declarations);

  if (path === undefined) {
    const pending = seededPaths(dir, desired).filter(item => item.state === "pending");

    if (pending.length === 0) return "No seeds are pending.";

    return ["Pending seeds (the package changed its seed, and the file differs from the seed office laid down):", ...pending.map(item => `  ${item.file} (package ${item.receipt.package})`), "", "Show one with office seeds diff <path>."].join("\n");
  }

  const item = seededPath(dir, desired, path);
  const name = item.receipt.package;
  const settle = ["When you have dealt with it:", `  ${seedsCommand("settle", path)}`];

  switch (item.state) {
    case "dropped":
      throw failedFor(item, `package ${name} no longer seeds it (office sync drops its receipt and leaves the file)`);
    case "blocked":
      throw failedFor(item, `package ${name} changed its seed, but ${blockedReason(dir, item.receipt)}`);
    case "current":
      return `${path} is current: package ${name}'s seed is the one office laid down.`;
    case "replace":
      return `${path} is current: the file is unchanged, so office sync replaces it with package ${name}'s new seed.`;
    case "advance":
      return `${path} is current: the file is deleted or already has package ${name}'s new seed, so office sync records it.`;
    case "unowned": {
      const mine = officeSide(dir, item);

      return [
        `${path} was already there when package ${name} was installed, so office has no seed it laid down to compare with.`,
        "This comparison cannot tell a package addition from an owner deletion; it needs manual review.",
        "",
        `Your file → package ${name}'s seed now:`,
        mine === undefined ? `  ${path} isn't a file office reads.` : withSeedFile(item, seed => gitDiff(dir, mine, seed)),
        "",
        ...settle,
      ].join("\n");
    }

    case "pending": {
      // Only a receipt with a hash is ever pending (classifySeed).
      if (!("sha256" in item.receipt)) throw failedFor(item, "its receipt has no seed to compare with");
      const stored = join(dir, seedStore, item.receipt.sha256);
      const mine = officeSide(dir, item);

      return [
        `What package ${name} changed (the seed office laid down → package ${name}'s seed now):`,
        withSeedFile(item, seed => gitDiff(dir, stored, seed)),
        "",
        "What you changed (the seed office laid down → your file):",
        mine === undefined ? `  ${path} isn't a file office reads.` : gitDiff(dir, stored, mine),
        "",
        ...guidance,
        "",
        ...settle,
      ].join("\n");
    }
  }
}

/**
 * `office seeds settle <path>`: stores the package's current seed, ensures the store's
 * `.gitattributes`, then records its SHA-256 in the path's receipt, without touching the office's
 * file. Settling an unchanged file declines sync's replacement. A path already current is left as
 * it is. Throws, changing no receipt, for a path without a receipt, a dropped seed or a missing
 * stored seed. Returns what it did.
 */
export function settleSeed(dir: string, declarations: readonly Entry<Seed>[], path: string): string {
  const item = seededPath(dir, resolveSeeds(dir, declarations), path);
  const name = item.receipt.package;

  if (item.state === "dropped" || item.seed === undefined) throw failedFor(item, `package ${name} no longer has a seed for it, so there is nothing to settle (office sync drops its receipt and leaves the file)`);

  if (item.state === "blocked") throw failedFor(item, `not settled: ${blockedReason(dir, item.receipt)}`);

  if (item.state === "current") return `${path} is current: package ${name}'s seed is the one its receipt names; nothing to settle.`;
  const hash = sha256(item.seed.bytes);

  try {
    storeSeed(dir, hash, item.seed.bytes);
    // The first seed an office stores, as when settling a file that was already there, needs the store's guard.
    keepSeedAttributes(dir);
  } catch (error) {
    throw failedFor(item, `not settled: ${message(error)}`);
  }

  // Read again just before writing, so a receipt another run changed meanwhile is kept.
  const receipts = readReceipts(dir);

  receipts.set(path, { package: name, sha256: hash });
  writeReceipts(dir, receipts);
  const recorded = `settled ${path}: recorded package ${name}'s seed ${hash.slice(0, 12)}, stored as ${seedStore}/${hash}`;
  const commit = `Commit ${seedStore}/.`;

  if (item.state === "replace") return `${recorded}, declining the automatic replacement: the file stays as it is, and office sync won't replace it with this seed. ${commit}`;

  return `${recorded}; the file is unchanged. ${commit}`;
}

/** Prints a seeds command's output, or its error on stderr with exit status 1. */
function report(work: () => string): void {
  try {
    console.log(work());
  } catch (error) {
    fail(message(error));
  }
}

function fail(text: string): void {
  console.error(`office: ${text}`);
  process.exitCode = 1;
}

/** A seeds command's words, without the `--` a printed command puts before a path that starts with a dash (`seedsCommand`). */
const pathWords = (args: readonly string[]) => (args[0] === "--" ? args.slice(1) : args);

/** `office seeds diff [<path>]`. */
export function diffCommand({ office, entries, args }: CommandInputs): void {
  const words = pathWords(args);

  if (words.length > 1) return fail(`usage: office seeds diff [<path>]: one path at most, not ${words.length}`);

  report(() => seedsDiff(office.dir, entries(seeds), words[0]));
}

/** `office seeds settle <path>`. */
export function settleCommand({ office, entries, args }: CommandInputs): void {
  const words = pathWords(args);

  if (words.length !== 1) return fail(`usage: office seeds settle <path>: exactly one path, not ${words.length}`);

  report(() => settleSeed(office.dir, entries(seeds), words[0]));
}
