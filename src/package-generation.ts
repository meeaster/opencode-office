import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
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
// rewrite the rest of office.lock meanwhile. Journals written before office.lock was published lack `lock`.
const journal = v.strictObject({
  previous: v.nullable(id),
  candidate: id,
  before: v.string(),
  after: v.string(),
  lock: v.optional(v.strictObject({ before: v.string(), after: v.string(), packages: v.unknown() })),
});

const bridges = [
  ["packages", "packages"],
  ["resolved/references.json", "references.json"],
  ["tsconfig.contracts.json", "tsconfig.contracts.json"],
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

    if (entry && !entry.isDirectory()) throw new OfficeError(`cannot adopt redirected or non-directory ${file}; move it aside and run office sync --packages`);
  }
}

export function checkAdoption(dir: string) {
  checkDirectories(dir);

  for (let parent = realpathSync(dir); ; parent = dirname(parent)) {
    if (existsSync(join(parent, ".git"))) break;

    if (parent === dirname(parent)) return;
  }

  const managed = ["current", "generations", "adopting", "generation-ticket", "publishing.json", ...bridges.map(([legacy]) => legacy)];
  const tracked = execFileSync("git", ["ls-files", "-z", "--", ...managed.map(member => `.office/${member}`)], { cwd: dir, encoding: "utf8" }).split("\0").find(Boolean);

  if (tracked) throw new OfficeError(`cannot adopt managed generations: ${tracked} is tracked in Git. Migrate any CI consumer to restore the pinned renderer, verify its build in a clean clone, then explicitly untrack the managed files and retry. No tracked files were moved`);
}

/** Check all destinations before creating any missing link. Never follow or
 * replace an entry left by a checkout, a legacy writer, or the owner. */
function inspectBridges(dir: string) {
  const root = join(dir, ".office");
  const missing: { path: string; link: string }[] = [];

  for (const [legacy, member] of bridges) {
    const path = join(root, legacy);
    const link = relative(dirname(path), join(root, "current", member));
    const entry = lstatSync(path, { throwIfNoEntry: false });

    if (!entry) missing.push({ path, link });
    else if (!entry.isSymbolicLink() || readlinkSync(path) !== link) {
      return { conflict: `expected ${path} to link to ${link}; move the conflicting entry aside and run office sync --packages`, missing };
    }
  }

  return { missing };
}

/** Preflight every legacy member before moving the first. The marker makes the
 * remaining renames restartable if the writer dies part-way through adoption. */
function adopt(dir: string) {
  const root = join(dir, ".office");
  const marker = join(root, "adopting");
  const current = activeGeneration(dir);
  const interrupted = existsSync(marker) ? v.parse(id, readFileSync(marker, "utf8")) : null;

  if (current && !interrupted) {
    const { conflict, missing } = inspectBridges(dir);

    if (conflict) throw new OfficeError(conflict);

    for (const { path, link } of missing) {
      mkdirSync(dirname(path), { recursive: true });
      symlinkSync(link, path);
    }

    return current;
  }

  if (current && current !== interrupted) throw new Error("interrupted adoption names a different active generation");

  for (const [legacy, member] of bridges) {
    const path = join(root, legacy);
    const entry = lstatSync(path, { throwIfNoEntry: false });

    if (entry && !(member === "packages" ? entry.isDirectory() : entry.isFile())) {
      if (interrupted && entry.isSymbolicLink() && readlinkSync(path) === relative(dirname(path), join(root, "current", member))) continue;
      throw new OfficeError(`cannot adopt unexpected ${path}; move it aside and run office sync --packages`);
    }

    if (entry && interrupted && lstatSync(join(managedDirectory(dir, interrupted), member), { throwIfNoEntry: false })) {
      throw new OfficeError(`cannot resume adoption: ${path} and its generation copy both exist; move the conflicting entry aside and run office sync --packages`);
    }
  }

  const name = interrupted ?? createGeneration(dir);

  if (!interrupted) writeAtomic(marker, name);
  const folder = managedDirectory(dir, name);

  for (const [legacy, member] of bridges) {
    const path = join(root, legacy);
    const target = join(folder, member);
    const link = relative(dirname(path), join(root, "current", member));
    const entry = lstatSync(path, { throwIfNoEntry: false });

    if (entry?.isSymbolicLink()) {
      if (readlinkSync(path) !== link) throw new Error(`cannot adopt unexpected symlink ${path}`);
      continue;
    }

    if (entry) {
      renameSync(path, target);
    }

    if (member === "packages") mkdirSync(target, { recursive: true });

    if (!activeGeneration(dir)) point(dir, name);
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(link, path);
  }

  rmSync(marker);

  return name;
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
  const section = intent.lock && lockedDigest(readLockText(dir));
  const lockAt = (state: "before" | "after") => !intent.lock || section === intent.lock[state];

  if (current === intent.previous && pins === intent.after && (lockAt("after") || lockAt("before"))) {
    if (intent.lock && !lockAt("after")) {
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
  checkAdoption(dir);
  using lease = openCheckoutLease(dir, publicationLease);
  lease.acquire(publicationBusy);
  checkAdoption(dir);

  return action();
}

/** Healthy readers only inspect links and need no write access. Repair and
 * interrupted first adoption use the same preflight and lease as writers. */
export function ensureDiscovery(dir: string) {
  checkDirectories(dir);

  if (!existsSync(join(dir, ".office/adopting"))) {
    if (!activeGeneration(dir)) return;
    const { conflict, missing } = inspectBridges(dir);

    if (!conflict && !missing.length) return;
  }

  locked(dir, () => adopt(dir));
}

/** Reserve the final path and protect both the source and candidate during materialization. */
export function beginGeneration(dir: string) {
  return locked(dir, () => {
    adopt(dir);
    recover(dir);
    const previous = activeGeneration(dir);

    if (!previous) throw new OfficeError("no active generation after adoption");
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
      checkAdoption(dir);
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
    adopt(dir);
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
