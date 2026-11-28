import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { openCheckoutLease, publicationLease } from "../../checkout-lease.ts";
import { gitMarkerAbove } from "../../exclude-plumbing.ts";
import { atomicWrite } from "../../lib/atomic-write.ts";
import { OfficeError } from "../../office.ts";
import type { PackageLock, ToolLock } from "../../lock-schema.ts";
import { editLock, lockFile, lockSections, packageSectionKey, publicationBusy, readLockText } from "../../versions.ts";
import { checkInstalled, checkPath, installedRoot, installedSelection } from "../installed/paths.ts";
import { readRecord } from "../sources/copies.ts";

export type Candidate = { dir: string; folder: string; original: string; lock: string | null; installed?: string };

const layout = [
  ["installed-links/node_modules/@office", "node_modules/@office", "folder"],
  ["withdrawals", "withdrawals", "folder"],
  ["unavailable.json", "unavailable.json", "file"],
  ["selection.json", "selection.json", "file"],
] as const;

/** Checks destinations before staging or installing, without following links at owned paths. */
export function checkDestinations(dir: string) {
  checkInstalled(dir);
  const root = installedRoot(dir);

  checkPath(join(root, "tmp"), "folder");
  checkPath(join(root, "resolved/checkout-leases"), "folder");
  checkPath(join(dir, "office.yaml"), "file");
  checkPath(join(dir, lockFile), "file");

  for (const child of ["packages", "withdrawals"]) {
    const parent = join(root, child);

    if (checkPath(parent, "folder")) {
      for (const name of readdirSync(parent)) checkPath(join(parent, name), "folder");
    }
  }
}

function refuseTrackedCopies(dir: string) {
  const paths = [".office/packages", ...layout.map(([, target]) => `.office/${target}`)];
  const read = spawnSync("git", ["ls-files", "-z", "--", ...paths], { cwd: dir, encoding: "utf8" });
  const marker = read.status === 0 ? undefined : gitMarkerAbove(dir);

  if (marker !== undefined) {
    throw new OfficeError(`cannot inspect Git's index for installed package files at ${marker}: ${read.error?.message ?? read.stderr.trim()}`);
  }

  if (read.status === 0 && read.stdout) {
    throw new OfficeError(`cannot replace Office's installed package files: ${read.stdout.split("\0")[0]} is tracked in Git; remove the installed files from the index and run office sync again`);
  }
}

export function installPackages({ dir, folder, original, lock, installed: prior }: Candidate, updated: string, packages: PackageLock, editTools?: (previous: ToolLock) => ToolLock) {
  const root = installedRoot(dir);
  const yaml = join(dir, "office.yaml");

  checkDestinations(dir);
  using lease = openCheckoutLease(dir, publicationLease);
  lease.acquire(publicationBusy);
  checkDestinations(dir);
  refuseTrackedCopies(dir);

  const before = lockSections(lock).packages;
  const now = lockSections(readLockText(dir));

  if (now.unknown) throw now.unknown;

  if (!before.ok) throw before.error;
  const key = packageSectionKey(before.value);

  if (readFileSync(yaml, "utf8") !== original || !now.packages.ok || packageSectionKey(now.packages.value) !== key || installedSelection(dir) !== prior) {
    throw new OfficeError(`package publication superseded; retry with the current office.yaml and ${lockFile}`);
  }

  const pinsChanged = packageSectionKey(packages) !== key;

  if (pinsChanged || editTools) {
    for (const section of [now.runtime, now.tools]) if (!section.ok) throw section.error;
  }

  const installed = join(root, "packages");
  const staged = join(folder, "packages");
  const retired = join(folder, "retired");

  mkdirSync(installed, { recursive: true });
  mkdirSync(join(root, "node_modules"), { recursive: true });
  mkdirSync(join(retired, "packages"), { recursive: true });

  const old = new Set(readdirSync(installed));
  const incoming = new Set(readdirSync(staged));
  const names = new Set(incoming);

  for (const name of old) {
    if (!names.has(name) && readRecord(join(installed, name))) names.add(name);
  }

  for (const name of names) {
    const destination = join(installed, name);

    if (old.has(name)) renameSync(destination, join(retired, "packages", name));

    if (incoming.has(name)) renameSync(join(staged, name), destination);
  }

  // Hooks keep their admitted module paths during application, including any lazy imports.
  for (const name of incoming) symlinkSync(relative(staged, join(installed, name)), join(staged, name));

  for (const [source, target, type] of layout) {
    const destination = join(root, target);

    if (type === "folder" && checkPath(destination, type)) {
      const aside = join(retired, "layout", target);

      mkdirSync(dirname(aside), { recursive: true });
      renameSync(destination, aside);
    }

    renameSync(join(folder, source), destination);
  }

  if (updated !== original) atomicWrite(yaml, updated, checkPath(yaml, "file")?.mode);

  if (pinsChanged || editTools) editLock(dir, sections => {
    sections.packages = packages;

    if (editTools) sections.tools = editTools(sections.tools);
  }, { leased: true });
}
