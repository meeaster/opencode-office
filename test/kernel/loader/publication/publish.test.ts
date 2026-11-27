import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openCheckoutLease } from "../../../../src/checkout-lease.ts";
import { git } from "../../../../src/git.ts";
import { changeText, isFailure } from "../../../../src/lib/change.ts";
import { packageLockProblems, publishPackages } from "../../../../src/loader/publication/publish.ts";
import { loadOffice } from "../../../../src/office.ts";
import type { LockedPackage } from "../../../../src/schema.ts";
import { editLock, readLockSection } from "../../../../src/versions.ts";
import { definitionText, writePackage } from "../../../support/test-package.ts";
import { syncLines as sync } from "../../../support/sync.fixture.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-operation-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function repository() {
  const repo = join(dir, "upstream");

  git(["init", "-qb", "main", repo]);

  return repo;
}

function commit(repo: string) {
  git(["add", "--all"], repo);
  git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "package revision"], repo);

  return git(["rev-parse", "HEAD"], repo);
}

function select(...packages: { name: string; repo: string; path: string; ref: string }[]) {
  const entries = packages.map(entry => `  - ${JSON.stringify(entry)}\n`).join("");

  writeFileSync(join(dir, "office.yaml"), `name: test\n${entries ? `packages:\n${entries}` : ""}`);
}

function setPackages(entries: Record<string, LockedPackage>) {
  editLock(dir, (sections) => {
    sections.packages = new Map(Object.entries(entries));
  });
}

const lockEntries = () => Object.fromEntries(readLockSection(dir, "packages"));
const active = () => readlinkSync(join(dir, ".office/current"));

async function publish() {
  const result = await publishPackages(loadOffice(dir), false);

  expect(result.published, result.lines.map(changeText).join("\n")).toBe(true);
  expect(result.lines.filter(isFailure)).toEqual([]);
}

test("publication uses a matching lock over a moved ref and replaces stale lock entries with the staged commit", async () => {
  const repo = repository();
  const file = join(repo, "pkg/package.yaml");

  writePackage(file, "# first\n{}\n", { name: "notes" });
  const first = commit(repo);
  writePackage(file, "# second\n{}\n", { name: "notes" });
  const second = commit(repo);
  const source = { repo, path: "pkg", ref: "main" };

  select({ name: "notes", ...source });
  setPackages({ notes: { ...source, commit: first }, gone: { ...source, commit: first } });
  await publish();
  const copy = join(dir, ".office/packages/notes");

  expect(readFileSync(join(copy, "package.yaml"), "utf8")).toStartWith("# first");
  expect(lockEntries()).toEqual({ notes: { ...source, commit: first } });

  for (const stale of [{ ref: "other" }, { path: "old-path" }, { repo: join(dir, "old-repo") }]) {
    rmSync(copy, { recursive: true });
    setPackages({ notes: { ...source, ...stale, commit: first } });
    await publish();
    expect(readFileSync(join(copy, "package.yaml"), "utf8")).toStartWith("# second");
    expect(lockEntries()).toEqual({ notes: { ...source, commit: second } });
  }

  // A hand-edited lock can name a commit that contradicts its own full-SHA ref.
  const pinned = { ...source, ref: second };

  select({ name: "notes", ...pinned });
  setPackages({ notes: { ...pinned, commit: first } });
  await publish();
  expect(lockEntries()).toEqual({ notes: { ...pinned, commit: second } });
});

test("publication adopts a matching copy offline, preserves a failed package's lock and drops deselected entries", async () => {
  const repo = repository();

  writePackage(join(repo, "pkg/package.yaml"), "{}\n", { name: "notes" });
  const revision = commit(repo);
  const source = { repo, path: "pkg", ref: "main" };
  const notes = { ...source, commit: revision };

  select({ name: "notes", ...source });
  await publish();
  renameSync(repo, `${repo}-offline`);
  setPackages({});
  await publish();
  expect(lockEntries()).toEqual({ notes });

  select({ name: "notes", ...source, ref: "next" });
  const partial = await publishPackages(loadOffice(dir), false);

  expect(partial).toMatchObject({ published: true, lines: expect.arrayContaining([expect.objectContaining({ failure: expect.stringContaining("FAILED .office/packages/notes") })]) });
  expect(lockEntries()).toEqual({ notes });
  expect(readFileSync(join(dir, ".office/packages/notes/package.yaml"), "utf8")).toBe("{}\n");

  select();
  await publish();
  expect(lockEntries()).toEqual({});
  expect(existsSync(join(dir, "office.lock"))).toBe(false);
});

test("a rejected candidate holds back a consumer whose published copy depended on the provider", async () => {
  const repo = repository();
  const names = ["consumer", "provider", "peer"];

  for (const name of names) writePackage(join(repo, name, "office.ts"), definitionText("{}"), { dependencies: name === "consumer" ? ["provider"] : [] });
  commit(repo);
  select(...names.map(name => ({ name, repo, path: name, ref: "main" })));
  await publish();

  const previous = active();
  const locked = lockEntries();
  const update = (revision: string) => publishPackages(loadOffice(dir), false, { yaml: text => text, apply: false, names, commits: new Map(names.map(name => [name, revision])) });

  writePackage(join(repo, "consumer/office.ts"), definitionText("{}"));
  writePackage(join(repo, "provider/office.ts"), definitionText('{ setup() { throw Error("rejected provider"); } }'));
  const rejected = await update(commit(repo));

  expect(rejected).toMatchObject({ published: false });
  expect(rejected.lines.map(changeText).join("\n")).toContain("rejected provider");
  expect(rejected.rejected?.sort()).toEqual(["consumer", "provider"]);
  expect(active()).toBe(previous);
  expect(lockEntries()).toEqual(locked);

  writePackage(join(repo, "provider/office.ts"), definitionText("{}"));
  writePackage(join(repo, "consumer/office.ts"), definitionText('{ setup() { throw Error("rejected consumer"); } }'));
  const reverse = await update(commit(repo));

  expect(reverse).toMatchObject({ published: false });
  expect(reverse.lines.map(changeText).join("\n")).toContain("rejected consumer");
  expect(reverse.rejected?.sort()).toEqual(["consumer", "provider"]);
  expect(active()).toBe(previous);

  writeFileSync(join(repo, "peer/package.json"), "{");
  expect((await update(commit(repo))).rejected).toEqual(names);
  expect(active()).toBe(previous);
});

test("a selected optional provider couples an update even if the provider has no copy", async () => {
  const repo = repository();

  writePackage(join(repo, "consumer/office.ts"), definitionText("{}"));
  writeFileSync(join(repo, "consumer/integration.ts"), "");
  writeFileSync(join(repo, "consumer/package.json"), JSON.stringify({ name: "@office/consumer", office: { definition: "./office.ts", integrations: { "@office/provider": "./integration.ts" } } }));
  writePackage(join(repo, "peer/office.ts"), definitionText("{}"));
  commit(repo);
  const consumer = { name: "consumer", repo, path: "consumer", ref: "main" };
  const provider = { name: "provider", repo: join(dir, "no-repository"), path: "provider", ref: "main" };
  const peer = { name: "peer", repo, path: "peer", ref: "main" };

  select(consumer, provider);
  const rejected = await publishPackages(loadOffice(dir), false, { yaml: text => text, apply: false, names: ["consumer", "provider"] });

  expect(rejected.published).toBe(false);
  expect(rejected.rejected?.sort()).toEqual(["consumer", "provider"]);
  expect(existsSync(join(dir, ".office/current/selection.json"))).toBe(false);

  select(consumer, peer);
  writeFileSync(join(repo, "consumer/office.ts"), definitionText('{ setup() { throw Error("rejected consumer"); } }'));
  commit(repo);
  const independent = await publishPackages(loadOffice(dir), false, { yaml: text => text, apply: false, names: ["consumer", "peer"] });

  expect(independent.published).toBe(false);
  expect(independent.lines.map(changeText).join("\n")).toContain("rejected consumer");
  expect(independent.rejected).toEqual(["consumer"]);
});

test("check reports a Git package's missing or mismatched office.lock entry, a copy installed at another commit and an entry for a package no longer selected, naming office sync", () => {
  const repo = "https://example.com/acme/packages.git";
  const [locked, installed] = ["a".repeat(40), "b".repeat(40)];
  const copy = join(dir, ".office/packages/notes");

  writeFileSync(join(dir, "office.yaml"), `name: t\npackages:\n  - { name: notes, repo: ${repo}, path: notes, ref: v2 }\n`);
  mkdirSync(copy, { recursive: true });
  writeFileSync(join(copy, ".source.json"), JSON.stringify({ repo, path: "notes", ref: "v2", commit: installed, files: {} }));

  const office = loadOffice(dir);

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
  select();
  const file = join(dir, ".office/resolved/checkout-leases/.package-application.lock");

  // Held by another sync: here, this process's own descriptor.
  const held = openCheckoutLease(dir, ".package-application");

  try {
    held.acquire();
    expect(await sync(loadOffice(dir), { scope: "packages" })).toEqual([expect.stringMatching(/^FAILED cannot take the package application lock: another office sync or package update holds \.office\/resolved\/checkout-leases\/\.package-application\.lock; retry once it finishes/)]);
  } finally {
    held[Symbol.dispose]();
  }

  // A link where the lock file goes is never followed.
  rmSync(file);
  symlinkSync(join(dir, "elsewhere"), file);
  expect(await sync(loadOffice(dir), { scope: "packages" })).toEqual([expect.stringMatching(/^FAILED cannot take the package application lock: ELOOP/)]);
  expect(existsSync(join(dir, ".office/current/selection.json"))).toBe(false);
});
