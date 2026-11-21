import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import * as v from "valibot";
import { openCheckoutLease, tryFileLock } from "./checkout-lease.ts";
import { atomicWrite } from "./secrets.ts";
import { OfficeError } from "./office.ts";

const id = v.pipe(v.string(), v.regex(/^g-[a-f0-9-]{36}$/));

const journal = v.strictObject({
  previous: v.nullable(id),
  candidate: id,
  before: v.string(),
  after: v.string(),
});

const bridges = [
  ["packages", "packages"],
  ["resolved/references.json", "references.json"],
  ["tsconfig.contracts.json", "tsconfig.contracts.json"],
] as const;

function digest(text: string) {
  return createHash("sha256").update(text).digest("hex");
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

export function checkAdoption(dir: string) {
  for (const member of [".office", ".office/generations", ".office/resolved"]) {
    const file = join(dir, member);
    const entry = lstatSync(file, { throwIfNoEntry: false });

    if (entry && !entry.isDirectory()) throw new OfficeError(`cannot adopt redirected or non-directory ${member}`);
  }

  if (activeGeneration(dir)) return;

  for (let parent = dir; ; parent = dirname(parent)) {
    if (existsSync(join(parent, ".git"))) break;

    if (parent === dirname(parent)) return;
  }

  const tracked = execFileSync("git", ["ls-files", "-z", "--", ...bridges.map(([legacy]) => `.office/${legacy}`)], { cwd: dir, encoding: "utf8" }).split("\0").find(Boolean);

  if (tracked) throw new OfficeError(`cannot adopt managed generations: ${tracked} is tracked in Git. Migrate any CI consumer to restore the pinned renderer, verify its build in a clean clone, then explicitly untrack the managed files and retry. No tracked files were moved`);
}

/** Preflight every legacy member before moving the first. The marker makes the
 * remaining renames restartable if the writer dies part-way through adoption. */
function adopt(dir: string) {
  const root = join(dir, ".office");
  const marker = join(root, "adopting");
  const current = activeGeneration(dir);

  if (current && !existsSync(marker)) return current;

  checkAdoption(dir);

  for (const [legacy, member] of bridges) {
    const path = join(root, legacy);
    const entry = lstatSync(path, { throwIfNoEntry: false });

    if (entry && !(member === "packages" ? entry.isDirectory() : entry.isFile())) {
      if (existsSync(marker) && entry.isSymbolicLink() && readlinkSync(path) === relative(dirname(path), join(root, "current", member))) continue;
      throw new OfficeError(`cannot adopt unexpected ${legacy}; preserve it and resolve the conflict before retrying`);
    }
  }

  const name = existsSync(marker) ? v.parse(id, readFileSync(marker, "utf8")) : createGeneration(dir);

  if (current && current !== name) throw new Error("interrupted adoption names a different active generation");

  if (!existsSync(marker)) writeAtomic(marker, name);
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
      if (existsSync(target)) throw new Error(`cannot adopt ${path}: ${target} also exists`);
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

export type Candidate = { dir: string; previous: string; name: string; original: string };

/** A process death after the pin rename rolls forward to the already admitted candidate.
 * Before that rename the old set remains authoritative. Never overwrite manual YAML edits. */
function recover(dir: string) {
  const path = join(dir, ".office/publishing.json");

  if (!existsSync(path)) return;
  const intent = v.parse(journal, JSON.parse(readFileSync(path, "utf8")));
  const current = activeGeneration(dir);
  const pins = digest(readFileSync(join(dir, "office.yaml"), "utf8"));

  if (current === intent.previous && pins === intent.after) point(dir, intent.candidate);
  else if (!(current === intent.candidate && pins === intent.after) && !(current === intent.previous && pins === intent.before)) {
    throw new Error(`interrupted package publication: active ${current}, proposed ${intent.candidate}; office.yaml changed independently; restore the recorded pins before retrying`);
  }

  rmSync(path);
}

function locked<T>(dir: string, action: () => T) {
  using lease = openCheckoutLease(dir, ".managed-generations");
  lease.acquire();
  recover(dir);

  return action();
}

/** Reserve the final path and protect both the source and candidate during materialization. */
export function beginGeneration(dir: string) {
  checkAdoption(dir);
  return locked(dir, () => {
    const previous = adopt(dir);
    prune(dir, previous);
    const name = createGeneration(dir);
    const original = readFileSync(join(dir, "office.yaml"), "utf8");
    const ticket = join(dir, ".office/generation-ticket");
    writeAtomic(ticket, name);

    const writer = holdGeneration(dir, name);
    const source = holdGeneration(dir, previous);

    if (!writer || !source) throw new OfficeError("generation lease unavailable");

    return { transaction: { dir, previous, name, original } satisfies Candidate, fd: writer.fd, [Symbol.dispose]() {
      writer?.[Symbol.dispose]();
      source?.[Symbol.dispose]();
      // Don't finish an interrupted pin edit as a side effect of unwinding its parent.
      // A subsequent writer recovers the journal before collecting abandoned generations.
      using sweep = openCheckoutLease(dir, ".managed-generations");

      if (!tryFileLock(sweep.fd, false) || existsSync(join(dir, ".office/publishing.json"))) return;
      const current = activeGeneration(dir);

      if (current) prune(dir, current);
    } };
  });
}

export function publishGeneration({ dir, previous, name, original }: Candidate, updated: string) {
  const yaml = join(dir, "office.yaml");
  const ticket = join(dir, ".office/generation-ticket");

  return locked(dir, () => {
    if (activeGeneration(dir) !== previous || readFileSync(ticket, "utf8") !== name || readFileSync(yaml, "utf8") !== original) throw new Error("package publication superseded; retry with the current office.yaml");
    const path = join(dir, ".office/publishing.json");
    const snapshot = join(dir, ".office/resolved/references.json");

    if (!lstatSync(snapshot, { throwIfNoEntry: false })) symlinkSync("../current/references.json", snapshot);
    writeAtomic(join(managedDirectory(dir, name), "previous"), previous);
    writeAtomic(path, JSON.stringify({ previous, candidate: name, before: digest(original), after: digest(updated) }));

    if (updated !== original) writeAtomic(yaml, updated);
    point(dir, name);
    rmSync(path);
  });
}
