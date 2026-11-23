import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import * as v from "valibot";
import { openCheckoutLease, publicationLease } from "./checkout-lease.ts";
import { tryFileLock } from "./file-lock.ts";
import { atomicWrite } from "./secrets.ts";
import { OfficeError } from "./office.ts";
import { type PackageLock, parsePackageLock } from "./schema.ts";
import { editLock, lockFile, lockSections, packageSectionKey, publicationBusy, readLockText } from "./versions.ts";

const id = v.pipe(v.string(), v.regex(/^g-[a-f0-9-]{36}$/));

// office.yaml's digests before and after the switch, and those of office.lock's `packages:` section
// with the section it switches to. Only that section belongs to the publication: other writers may
// rewrite the rest of office.lock meanwhile.
const journal = v.strictObject({
  previous: v.nullable(id),
  candidate: id,
  before: v.string(),
  after: v.string(),
  lock: v.strictObject({ before: v.string(), after: v.string(), packages: v.unknown() }),
});

// The discovery links: each path under .office/ and what it leads to in the active generation.
const bridges = [
  ["packages", "packages"],
  ["resolved/references.json", "references.json"],
] as const;

function digest(text: string) {
  return createHash("sha256").update(text).digest("hex");
}

function sectionDigest(packages: PackageLock) {
  return digest(packageSectionKey(packages));
}

/** The digest of office.lock's `packages:` section in `text`, or null when it can't be read. */
function lockedDigest(text: string | null) {
  const packages = lockSections(text).packages;

  return packages.ok ? sectionDigest(packages.value) : null;
}

/** Replaces office.lock's `packages:` section, under the lease the caller holds. */
function writePackages(dir: string, packages: PackageLock) {
  editLock(dir, (sections) => {
    sections.packages = packages;
  }, { leased: true });
}

/** Every pointer is relative: the same office can be mounted at another root. */
export function managedDirectory(dir: string, generation: string) {
  return join(dir, ".office/generations", v.parse(id, generation));
}

export function activeGeneration(dir: string) {
  const pointer = join(dir, ".office/current");

  if (!lstatSync(pointer, { throwIfNoEntry: false })) return null;
  const target = readlinkSync(pointer);
  const generation = target.split("/")[1];

  if (target !== `generations/${generation}` || !v.is(id, generation) || !statSync(managedDirectory(dir, generation)).isDirectory()) throw new Error(`invalid managed package pointer ${pointer}: ${target}`);

  return generation;
}

/** Whether the office has a published package set: an active generation holding its selection. */
export function hasPublishedSet(dir: string) {
  const name = activeGeneration(dir);

  return name !== null && existsSync(join(managedDirectory(dir, name), "selection.json"));
}

function point(dir: string, generation: string) {
  const current = join(dir, ".office/current");
  const temp = `${current}.${randomUUID()}`;
  symlinkSync(`generations/${generation}`, temp);
  renameSync(temp, current);
}

function writeAtomic(path: string, text: string) {
  atomicWrite(path, text, statSync(path, { throwIfNoEntry: false })?.mode ?? 0o600);
}

function createGeneration(dir: string) {
  const name = `g-${randomUUID()}`;
  mkdirSync(managedDirectory(dir, name), { recursive: true });

  return name;
}

/** flock the directory itself. No per-generation lockfiles survive pruning. */
function holdGeneration(dir: string, name: string, shared = true) {
  const fd = openSync(managedDirectory(dir, name), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);

  if (tryFileLock(fd, shared)) return { fd, [Symbol.dispose]: () => closeSync(fd) };
  closeSync(fd);

  if (shared) throw new OfficeError(`generation ${name} is being retired; retry`);
}

export function pinActive(dir: string) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const name = activeGeneration(dir);

    if (!name) return;

    try {
      const lease = holdGeneration(dir, name);

      if (lease) {
        if (activeGeneration(dir) === name) return { name, ...lease };
        lease[Symbol.dispose]();
      }
    } catch (error) {
      if (activeGeneration(dir) === name) throw error;
    }
  }

  throw new OfficeError("managed package selection is changing; retry");
}

function prune(dir: string, current: string) {
  const parent = join(dir, ".office/generations");
  const record = join(managedDirectory(dir, current), "previous");
  const previous = existsSync(record) && readFileSync(record, "utf8");

  for (const item of readdirSync(parent, { withFileTypes: true })) {
    if (!item.isDirectory() || !v.is(id, item.name) || item.name === current || item.name === previous) continue;
    using retired = holdGeneration(dir, item.name, false);

    if (retired) rmSync(join(parent, item.name), { recursive: true });
  }
}

function checkDirectories(dir: string) {
  for (const member of [".office", ".office/generations", ".office/resolved"]) {
    const file = join(dir, member);
    const entry = lstatSync(file, { throwIfNoEntry: false });

    if (entry && !entry.isDirectory()) throw new OfficeError(`cannot use redirected or non-directory ${file}; move it aside and run office sync --packages`);
  }
}

/** Check all destinations before creating any missing link. Never follow or
 * replace an entry left by a checkout or the owner. */
function inspectBridges(dir: string) {
  const root = join(dir, ".office");
  const missing: { path: string; link: string }[] = [];

  for (const [at, member] of bridges) {
    const path = join(root, at);
    const link = relative(dirname(path), join(root, "current", member));
    const entry = lstatSync(path, { throwIfNoEntry: false });

    if (!entry) missing.push({ path, link });
    else if (!entry.isSymbolicLink() || readlinkSync(path) !== link) {
      return { conflict: `expected ${path} to link to ${link}; move the conflicting entry aside and run office sync --packages`, missing };
    }
  }

  return { missing };
}

/**
 * The active generation with every discovery link in place. A fresh office gets its first, empty
 * generation here. Refuses before changing anything when an entry other than its link is where a
 * link belongs.
 */
function establish(dir: string) {
  const { conflict, missing } = inspectBridges(dir);

  if (conflict) throw new OfficeError(conflict);
  let current = activeGeneration(dir);

  if (!current) {
    current = createGeneration(dir);
    mkdirSync(join(managedDirectory(dir, current), "packages"));
    point(dir, current);
  }

  for (const { path, link } of missing) {
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(link, path);
  }

  return current;
}

/** `original` and `lock` are office.yaml's and office.lock's text (null: none) when the candidate was reserved. */
export type Candidate = { dir: string; previous: string; name: string; original: string; lock: string | null };

/** A process death after the journal is written rolls forward to the already admitted candidate:
 * office.yaml is written first, then office.lock's `packages:` section, then the pointer, so
 * office.yaml at "after" finishes the section from the journal. Otherwise the old set remains
 * authoritative. Never overwrite manual edits: office.yaml or a section matching neither recorded
 * state refuses. The rest of office.lock isn't part of the publication and is kept. */
export function recover(dir: string) {
  const path = join(dir, ".office/publishing.json");

  if (!existsSync(path)) return;
  const intent = v.parse(journal, JSON.parse(readFileSync(path, "utf8")));
  const current = activeGeneration(dir);
  const pins = digest(readFileSync(join(dir, "office.yaml"), "utf8"));
  const section = lockedDigest(readLockText(dir));
  const lockAt = (state: "before" | "after") => section === intent.lock[state];

  if (current === intent.previous && pins === intent.after && (lockAt("after") || lockAt("before"))) {
    if (!lockAt("after")) {
      const packages = parsePackageLock(intent.lock.packages);

      if (!packages.ok) throw new Error(`interrupted package publication: ${path} is not valid: ${packages.errors.join("; ")}`);
      writePackages(dir, packages.value);
    }

    point(dir, intent.candidate);
  } else if (!(current === intent.candidate && pins === intent.after && lockAt("after")) && !(current === intent.previous && pins === intent.before && lockAt("before"))) {
    throw new Error(`interrupted package publication: active ${current}, proposed ${intent.candidate}; office.yaml or ${lockFile}'s packages: section changed independently; restore the recorded pins before retrying`);
  }

  rmSync(path);
}

function locked<T>(dir: string, action: () => T) {
  checkDirectories(dir);
  using lease = openCheckoutLease(dir, publicationLease);
  lease.acquire(publicationBusy);
  checkDirectories(dir);

  return action();
}

/** Healthy readers only inspect links and need no write access. Repair uses
 * the same preflight and lease as writers. */
export function ensureDiscovery(dir: string) {
  checkDirectories(dir);

  if (!activeGeneration(dir)) return;
  const { conflict, missing } = inspectBridges(dir);

  if (!conflict && !missing.length) return;

  locked(dir, () => establish(dir));
}

/** Reserve the final path and protect both the source and candidate during materialization. */
export function beginGeneration(dir: string) {
  return locked(dir, () => {
    establish(dir);
    recover(dir);
    const previous = activeGeneration(dir);

    if (!previous) throw new OfficeError("no active package generation");
    prune(dir, previous);
    const name = createGeneration(dir);
    const original = readFileSync(join(dir, "office.yaml"), "utf8");
    const lock = readLockText(dir);
    const ticket = join(dir, ".office/generation-ticket");
    writeAtomic(ticket, name);

    const writer = holdGeneration(dir, name);
    const source = holdGeneration(dir, previous);

    if (!writer || !source) throw new OfficeError("generation lease unavailable");

    return { transaction: { dir, previous, name, original, lock } satisfies Candidate, fd: writer.fd, [Symbol.dispose]() {
      writer?.[Symbol.dispose]();
      source?.[Symbol.dispose]();
      // Don't finish an interrupted pin edit as a side effect of unwinding its parent.
      // A subsequent writer recovers the journal before collecting abandoned generations.
      using sweep = openCheckoutLease(dir, publicationLease);

      if (!tryFileLock(sweep.fd, false) || existsSync(join(dir, ".office/publishing.json"))) return;
      checkDirectories(dir);
      const current = activeGeneration(dir);

      if (current) prune(dir, current);
    } };
  });
}

/**
 * Switches the active generation, office.yaml and office.lock's `packages:` section together,
 * through the journal. Other office.lock writes since the reservation are kept.
 */
export function publishGeneration({ dir, previous, name, original, lock }: Candidate, updated: string, packages: PackageLock) {
  const yaml = join(dir, "office.yaml");
  const ticket = join(dir, ".office/generation-ticket");

  return locked(dir, () => {
    establish(dir);
    recover(dir);

    const reserved = lockSections(lock).packages;

    if (!reserved.ok) throw reserved.error;
    const before = sectionDigest(reserved.value);
    const now = lockSections(readLockText(dir));

    if (activeGeneration(dir) !== previous || readFileSync(ticket, "utf8") !== name || readFileSync(yaml, "utf8") !== original || !now.packages.ok || sectionDigest(now.packages.value) !== before) {
      throw new Error(`package publication superseded; retry with the current office.yaml and ${lockFile}`);
    }

    const after = sectionDigest(packages);

    // Fails here, before anything changes, when office.lock must be rewritten and can't be read.
    if (after !== before) {
      for (const section of Object.values(now)) if (!section.ok) throw section.error;
    }

    const path = join(dir, ".office/publishing.json");
    writeAtomic(join(managedDirectory(dir, name), "previous"), previous);
    writeAtomic(path, JSON.stringify({ previous, candidate: name, before: digest(original), after: digest(updated), lock: { before, after, packages: Object.fromEntries(packages) } }));

    if (updated !== original) writeAtomic(yaml, updated);

    if (after !== before) writePackages(dir, packages);
    point(dir, name);
    rmSync(path);
  });
}
