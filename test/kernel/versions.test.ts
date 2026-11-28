import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openCheckoutLease, publicationLease } from "../../src/checkout-lease.ts";
import { defaultPins, editLock, readLock, readLockSection, writeLock } from "../../src/versions.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-versions-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const notes = { repo: "https://example.com/acme/office-packages.git", path: "notes", ref: "v1.2.0", commit: "0123456789abcdef0123456789abcdef01234567" };
const agenda = { repo: "https://example.com/acme/agenda.git", path: "pkg", ref: "1.0", commit: "1".repeat(40) };

/** Sets office.lock's `packages:` section, as a publication does. */
function setPackages(entries: Record<string, typeof notes>) {
  editLock(dir, (sections) => {
    sections.packages = new Map(Object.entries(entries));
  });
}

test("office.lock reads with runtime pins only (round-tripping sfw's platform digests), Git packages only, or both, and rejects a short commit", () => {
  writeLock(dir, defaultPins);
  expect(readLockSection(dir, "packages")).toEqual(new Map());

  rmSync(join(dir, "office.lock"));
  setPackages({ notes });
  expect(readLock(dir)).toBeUndefined();
  expect(readLockSection(dir, "packages")).toEqual(new Map([["notes", notes]]));

  writeLock(dir, defaultPins);
  expect(readLock(dir)).toEqual(defaultPins);
  expect(readLockSection(dir, "packages")).toEqual(new Map([["notes", notes]]));

  writeFileSync(join(dir, "office.lock"), readFileSync(join(dir, "office.lock"), "utf8").replace(notes.commit, "abcdef0"));
  expect(() => readLockSection(dir, "packages")).toThrow("office.lock is not valid (restore it from Git, or remove its packages: section for office sync to rewrite):\n  packages.notes.commit: must be a full 40-character commit SHA");
});

test("each writer of office.lock leaves the other sections byte-identical, sorted by key, and an unchanged edit leaves the file alone", () => {
  const lock = join(dir, "office.lock");
  const text = () => readFileSync(lock, "utf8");
  const part = (from: string) => text().slice(text().indexOf(from));

  const writers = {
    runtime: () => writeLock(dir, { ...defaultPins, mise: { ...defaultPins.mise, version: "2026.12.1" } }),
    packages: () => setPackages({ notes: { ...notes, ref: "v1.3.0" } }),
  };

  writeLock(dir, defaultPins);
  setPackages({ notes, agenda });

  // Packages sorted by name, a ref that reads as a number stays a string.
  expect(part("packages:").indexOf("agenda:")).toBeLessThan(part("packages:").indexOf("notes:"));
  expect(readLockSection(dir, "packages").get("agenda")?.ref).toBe("1.0");

  const sections = () => {
    const [runtime, packages] = text().split("\n\n");

    return { runtime, packages };
  };

  for (const key of ["runtime", "packages"] as const) {
    const before = sections();

    writers[key]();
    const after = sections();

    expect(after).toEqual({ ...before, [key]: after[key] });
    expect(after[key]).not.toBe(before[key]);
  }

  const settled = text();

  editLock(dir, () => {});
  expect(text()).toBe(settled);

  // No packages drops the section, and a lock with no section goes.
  setPackages({});
  expect(text()).not.toContain("packages:");
  rmSync(lock);
  setPackages({ notes });
  setPackages({});
  expect(existsSync(lock)).toBe(false);
});

test("each section of office.lock reads on its own, and a writer refuses, before its edit runs, to rewrite a section it can't read", () => {
  const lock = join(dir, "office.lock");
  const packagesFix = "office.lock is not valid (restore it from Git, or remove its packages: section for office sync to rewrite)";

  writeLock(dir, defaultPins);
  setPackages({ notes });
  const valid = readFileSync(lock, "utf8");
  let edited = false;

  const edit = () => editLock(dir, () => {
    edited = true;
  });

  // A bad runtime section: the others still read, office pin rewrites it, and other writers refuse.
  writeFileSync(lock, valid.replace(`  version: ${defaultPins.mise.version}`, "  version: latest"));
  expect(() => readLock(dir)).toThrow("office.lock is not valid (run office pin to rewrite it)");
  expect(readLockSection(dir, "packages")).toEqual(new Map([["notes", notes]]));
  expect(() => edit()).toThrow("office.lock is not valid (run office pin to rewrite it)");
  writeLock(dir, defaultPins);
  expect(readFileSync(lock, "utf8")).toBe(valid);

  // A bad packages: section: the runtime pins still read, and office pin refuses rather than drop the section.
  writeFileSync(lock, valid.replace(notes.commit, "abcdef0"));
  expect(readLock(dir)).toEqual(defaultPins);
  expect(() => writeLock(dir, defaultPins)).toThrow(packagesFix);
  expect(() => edit()).toThrow(packagesFix);
  expect(edited).toBe(false);
});

test("a top-level key office.lock doesn't know fails every read naming it, and no writer, office pin's included, rewrites the file", () => {
  const lock = join(dir, "office.lock");
  let edited = false;

  // Runtime pins and no packages: section, as an office that has never locked a Git package.
  writeLock(dir, defaultPins);
  writeFileSync(lock, `${readFileSync(lock, "utf8")}\nextra:\n  kept: true\n`);
  const text = readFileSync(lock, "utf8");
  const unknown = "office.lock has a top-level key office doesn't know: extra";

  expect(() => readLock(dir)).toThrow(unknown);

  expect(() => readLockSection(dir, "packages")).toThrow(unknown);

  expect(() => writeLock(dir, defaultPins)).toThrow(unknown);
  expect(() => editLock(dir, () => { edited = true; }, { replacing: "packages" })).toThrow(unknown);
  expect(edited).toBe(false);
  expect(readFileSync(lock, "utf8")).toBe(text);
});

test("a package named like an Object property round-trips through office.lock", () => {
  setPackages({ constructor: notes, prototype: agenda });

  expect([...readLockSection(dir, "packages").keys()]).toEqual(["constructor", "prototype"]);
});

test("office.lock writers hold the publication lease, so a busy lease changes nothing and runs no edit", () => {
  const busy = "another office command is changing packages or office.lock; retry when it finishes";
  let edited = false;

  writeLock(dir, defaultPins);
  const lock = readFileSync(join(dir, "office.lock"), "utf8");

  {
    using lease = openCheckoutLease(dir, publicationLease);
    lease.acquire();

    expect(() => writeLock(dir, { ...defaultPins, mise: { ...defaultPins.mise, version: "2026.12.1" } })).toThrow(busy);
    expect(() => editLock(dir, () => {
      edited = true;
    })).toThrow(busy);
    expect(readFileSync(join(dir, "office.lock"), "utf8")).toBe(lock);
    expect(edited).toBe(false);
  }
});
