import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { failure, isFailure, type Change } from "../../lib/change.ts";
import { renameNoReplace } from "../../lib/no-replace.ts";
import { type Office, OfficeError, type PackageEntry } from "../../office.ts";
import type { PackageLock } from "../../lock-schema.ts";
import { materializePackage, readRecord, sourceDifferences, verifiedCommit } from "../sources/copies.ts";
import type { resolvePackages } from "../sources/selection.ts";
import { applicationLease } from "./lease.ts";

/**
 * The commit to install a Git package at: its office.lock entry's while that entry has the
 * selected repo, path and ref (and, for a full-SHA ref, names that commit). Without one, a matching
 * installed copy is kept from its source record, else the ref is resolved (`fetchPackage`).
 */
function boundCommit(lock: PackageLock, entry: PackageEntry): string | undefined {
  const locked = lock.get(entry.name);

  if (locked && entry.source && !sourceDifferences(locked, entry.source).length && verifiedCommit(locked.ref, locked.commit)) return locked.commit;
}

export async function prepareSources(office: Office, selection: ReturnType<typeof resolvePackages>, folder: string, previous: string, lock: PackageLock, commits: ReadonlyMap<string, string>, lines: Change[]) {
  const packages = join(folder, "packages");
  mkdirSync(packages);
  const validate: string[] = [];
  const rejected: string[] = [];

  using deliveries = applicationLease(office.dir);

  for (const item of selection.packages) {
    if (item.kind === "local") continue;
    const old = join(previous, "packages", item.entry.name);
    const dir = join(packages, item.entry.name);

    if (lstatSync(old, { throwIfNoEntry: false })?.isSymbolicLink()) throw new OfficeError(`cannot materialize redirected package ${old}`);

    const locked = boundCommit(lock, item.entry);
    const bound = commits.get(item.entry.name) ?? locked;
    let copiedPrevious = false;

    try {
      if (existsSync(old)) {
        cpSync(old, dir, { recursive: true, verbatimSymlinks: true });
        copiedPrevious = true;
      }

      const materialized = await materializePackage(office, item, packages, bound);

      lines.push(...materialized.changes);

      if (materialized.changes.some(isFailure)) {
        rejected.push(item.entry.name);
      } else if (materialized.changes.length) {
        validate.push(item.entry.name);

        if (locked && locked === bound && !existsSync(old)) {
          // Exact repair of a lost copy at its locked commit, independently of whether new
          // registrations are admitted. Never at an update's override or a floating tag.
          const record = readRecord(dir);

          if (record && "repo" in record && record.commit === bound) {
            const repair = join(folder, `repair-${item.entry.name}`);
            cpSync(dir, repair, { recursive: true, verbatimSymlinks: true });
            renameNoReplace(repair, old);
          }
        }
      }
    } catch (error) {
      rejected.push(item.entry.name);
      lines.push(failure(`FAILED package ${item.entry.name}: ${String(error)}`));

      if (!copiedPrevious) rmSync(dir, { force: true, recursive: true });
    }

    item.dir = dir;
  }

  // Keep outstanding withdrawals with the candidate. After a crash or a deferred apply, the
  // previous generation need not stay pinned just to finish removing a package's panel.
  const withdrawals = join(folder, "withdrawals");
  mkdirSync(withdrawals);
  const selected = new Set(selection.packages.map(pkg => pkg.entry.name));

  for (const source of ["withdrawals", "packages"]) {
    const parent = join(previous, source);

    if (!existsSync(parent)) continue;

    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || selected.has(entry.name)) continue;
      cpSync(join(parent, entry.name), join(withdrawals, entry.name), { recursive: true, verbatimSymlinks: true });
    }
  }

  return { validate, rejected };
}
