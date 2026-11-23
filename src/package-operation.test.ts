import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openCheckoutLease } from "./checkout-lease.ts";
import { syncLines as sync } from "./sync.fixture.ts";
import { loadOffice, type PackageEntry } from "./office.ts";
import { boundCommit, candidatePackageLock, packageLockProblems } from "./package-operation.ts";
import { editLock } from "./versions.ts";
import { fetchPackage, fileHashes, type ResolvedPackage } from "./packages.ts";
import { writePackage } from "./test-package.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-operation-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const locked = "a".repeat(40);
const published = "b".repeat(40);
const source = { repo: "https://example.com/acme/packages.git", path: "notes", ref: "v1", track: undefined };
const entry: PackageEntry = { name: "notes", settings: {}, source };
const entryLock = { repo: source.repo, path: source.path, ref: source.ref, commit: locked };
const lock = new Map([["notes", entryLock]]);

test("the locked commit binds a Git package while its repo, path and ref match; otherwise none does, and sync keeps a matching copy or resolves the ref", () => {
  expect(boundCommit(lock, entry)).toBe(locked);

  for (const moved of [{ ref: "v2" }, { path: "other" }, { repo: "https://example.com/acme/fork.git" }]) {
    expect(boundCommit(lock, { ...entry, source: { ...source, ...moved } })).toBeUndefined();
  }

  expect(boundCommit(new Map(), entry)).toBeUndefined();
  expect(boundCommit(lock, { ...entry, source: undefined })).toBeUndefined();

  // An entry edited by hand so its full-SHA ref names another commit is ignored, so sync resolves the ref again.
  const pinned = { ...entry, source: { ...source, ref: published } };

  expect(boundCommit(new Map([["notes", { ...entryLock, ref: published }]]), pinned)).toBeUndefined();
  expect(boundCommit(new Map([["notes", { ...entryLock, ref: published, commit: published }]]), pinned)).toBe(published);
});

type StagedRecord = { repo: string; path: string; ref: string; commit: string };

function staged(name: string, record: StagedRecord | undefined): void {
  const folder = join(dir, "packages", name);

  mkdirSync(folder, { recursive: true });
  writePackage(join(folder, "package.yaml"), `# Staged.\n{}\n`);

  if (record) writeFileSync(join(folder, ".source.json"), JSON.stringify({ ...record, files: fileHashes(folder) }));
}

test("the candidate lock takes each staged Git copy's commit, keeps a failed one's entry, drops deselected ones and has none without Git packages", () => {
  const remote = (name: string, ref = "v1"): ResolvedPackage => ({ entry: { ...entry, name, source: { ...source, ref } }, kind: "remote", dir: "" });
  const next = "c".repeat(40);

  staged("notes", { ...source, ref: "v2", commit: next });
  staged("failed", { ...source, ref: "v2", commit: next });
  staged("fresh", { ...source, commit: next });

  const previous = new Map([["notes", entryLock], ["failed", entryLock], ["gone", entryLock]]);
  const local: ResolvedPackage = { entry: { name: "own", settings: {}, source: undefined }, kind: "local", dir: "" };
  const builtin: ResolvedPackage = { entry: { name: "office", settings: {}, source: undefined }, kind: "built-in", dir: "" };

  expect(candidatePackageLock([builtin, local, remote("notes", "v2"), remote("failed", "v2"), remote("fresh")], join(dir, "packages"), ["failed"], previous)).toEqual(new Map([
    ["notes", { repo: source.repo, path: source.path, ref: "v2", commit: next }],
    ["failed", entryLock],
    ["fresh", { repo: source.repo, path: source.path, ref: "v1", commit: next }],
  ]));
  expect(candidatePackageLock([builtin, local], join(dir, "packages"), [], previous)).toEqual(new Map());
});

test("an installed copy whose record matches its entry is adopted into the lock without fetching", async () => {
  const office = join(dir, "office");

  mkdirSync(office);
  writeFileSync(join(office, "office.yaml"), "name: t\n");
  // The repository doesn't exist: a fetch would fail.
  const offline = { ...source, repo: join(dir, "absent") };

  staged("notes", { ...offline, commit: published });
  expect(await fetchPackage(loadOffice(office), { ...entry, source: offline }, offline, undefined, undefined, join(dir, "packages/notes"))).toEqual([]);
  expect(candidatePackageLock([{ entry: { ...entry, source: offline }, kind: "remote", dir: "" }], join(dir, "packages"), [], new Map())).toEqual(new Map([
    ["notes", { repo: offline.repo, path: offline.path, ref: offline.ref, commit: published }],
  ]));
});

test("check reports a Git package's missing or mismatched office.lock entry, a copy installed at another commit and an entry for a package no longer selected, naming office sync", () => {
  const repo = "https://example.com/acme/packages.git";
  const [locked, installed] = ["a".repeat(40), "b".repeat(40)];
  const copy = join(dir, ".office/packages/notes");

  writeFileSync(join(dir, "office.yaml"), `name: t\npackages:\n  - { name: notes, repo: ${repo}, path: notes, ref: v2 }\n`);
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(copy, ".source.json"), JSON.stringify({ repo, path: "notes", ref: "v2", commit: installed, files: {} }));

  const office = loadOffice(dir);

  const setPackages = (entries: Record<string, typeof entryLock>) => editLock(dir, (sections) => {
    sections.packages = new Map(Object.entries(entries));
  });

  expect(packageLockProblems(office)).toEqual(["office.lock has no entry for package notes (office sync locks its commit)"]);

  setPackages({ notes: { repo, path: "notes", ref: "v1", commit: locked } });
  expect(packageLockProblems(office)).toEqual(["office.lock doesn't match office.yaml for package notes: ref (v1, office.yaml v2) (office sync resolves it again and rewrites the entry)"]);

  setPackages({ notes: { repo, path: "notes", ref: "v2", commit: locked } });
  expect(packageLockProblems(office)).toEqual([`package notes is installed at ${installed.slice(0, 12)}, but office.lock locks ${locked.slice(0, 12)} (office sync installs the locked commit)`]);

  setPackages({ notes: { repo, path: "notes", ref: "v2", commit: installed } });
  expect(packageLockProblems(office)).toEqual([]);

  // An entry for a package office.yaml no longer selects, such as one removed by hand.
  setPackages({ notes: { repo, path: "notes", ref: "v2", commit: installed }, constructor: { repo, path: "gone", ref: "v1", commit: locked } });
  expect(packageLockProblems(office)).toEqual(["office.lock locks package constructor, which office.yaml no longer selects from a Git repository (office sync removes the entry)"]);

  // Ownership conflicts, a local folder and a Git entry with built-in names, don't hide unrelated drift
  // or make the conflicting Git entry's lock entry look deselected.
  mkdirSync(join(dir, "packages/references"), { recursive: true });
  writeFileSync(join(dir, "office.yaml"), `name: t\npackages:\n  - { name: notes, repo: ${repo}, path: notes, ref: v2 }\n  - { name: browser, repo: ${repo}, path: browser, ref: v1 }\n`);
  setPackages({ notes: { repo, path: "notes", ref: "v2", commit: locked }, browser: { repo, path: "browser", ref: "v1", commit: locked } });
  expect(packageLockProblems(loadOffice(dir))).toEqual([`package notes is installed at ${installed.slice(0, 12)}, but office.lock locks ${locked.slice(0, 12)} (office sync installs the locked commit)`]);
});

test("a package application lock that can't be opened or is held fails the sync by name, publishing nothing", async () => {
  const office = join(dir, "office");
  mkdirSync(office);
  writeFileSync(join(office, "office.yaml"), "name: t\n");
  const file = join(office, ".office/resolved/checkout-leases/.package-application.lock");

  // Held by another sync: here, this process's own descriptor.
  const held = openCheckoutLease(office, ".package-application");

  try {
    held.acquire();
    expect(await sync(loadOffice(office), { scope: "packages" })).toEqual([expect.stringMatching(/^FAILED cannot take the package application lock: another office sync or package update holds \.office\/resolved\/checkout-leases\/\.package-application\.lock; retry once it finishes/)]);
  } finally {
    held[Symbol.dispose]();
  }

  // A link where the lock file goes is never followed.
  rmSync(file);
  symlinkSync(join(dir, "elsewhere"), file);
  expect(await sync(loadOffice(office), { scope: "packages" })).toEqual([expect.stringMatching(/^FAILED cannot take the package application lock: ELOOP/)]);
  expect(existsSync(join(office, ".office/current/selection.json"))).toBe(false);
});
