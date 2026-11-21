import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import * as v from "valibot";
import { openCheckoutLease } from "./checkout-lease.ts";
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

/** Never unlink an unexpected link or discard a second copy. Repeating after any rename
 * completes the interrupted adoption. Caller holds the publication lock. */
function adopt(dir: string) {
  const root = join(dir, ".office");
  const marker = join(root, "adopting");
  const current = activeGeneration(dir);

  if (current && !existsSync(marker)) return current;

  if (!current && existsSync(join(dir, ".git"))) {
    const tracked = execFileSync("git", ["ls-files", "-z", "--", ...bridges.map(([legacy]) => `.office/${legacy}`)], { cwd: dir, encoding: "utf8" }).split("\0").find(Boolean);

    if (tracked) throw new OfficeError(`cannot adopt managed generations: ${tracked} is tracked in Git. The packages discovery link cannot contain tracked descendants. Check CI consumers before untracking any files; no tracked files were moved`);
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

/** A candidate keeps its final name from materialization through publication. Retain
 * published directories: external plugin runtimes cannot signal that they released one. */
export function beginGeneration(dir: string) {
  return locked(dir, () => {
    const previous = adopt(dir);
    const name = createGeneration(dir);
    const original = readFileSync(join(dir, "office.yaml"), "utf8");
    const ticket = join(dir, ".office/generation-ticket");
    writeAtomic(ticket, name);

    return { dir, previous, name, original } satisfies Candidate;
  });
}

export function publishGeneration({ dir, previous, name, original }: Candidate, updated: string) {
  const yaml = join(dir, "office.yaml");
  const ticket = join(dir, ".office/generation-ticket");

  return locked(dir, () => {
    if (activeGeneration(dir) !== previous || readFileSync(ticket, "utf8") !== name || readFileSync(yaml, "utf8") !== original) throw new Error("package publication superseded; retry with the current office.yaml");
    const path = join(dir, ".office/publishing.json");
    writeAtomic(path, JSON.stringify({ previous, candidate: name, before: digest(original), after: digest(updated) }));

    if (updated !== original) writeAtomic(yaml, updated);
    point(dir, name);
    rmSync(path);
  });
}
