import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beginGeneration, publishGeneration } from "../../../../src/loader/generation/storage.ts";
import type { PackageLock } from "../../../../src/schema.ts";
import { defaultPins, editLock, packageSectionKey, readLock, readLockSection, readLockText, writeLock } from "../../../../src/versions.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-generation-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const notes = { repo: "https://example.com/acme/packages.git", path: "notes", ref: "v1", commit: "a".repeat(40) };
const sections: Record<"empty" | "notes" | "edited", PackageLock> = { empty: new Map(), notes: new Map([["notes", notes]]), edited: new Map([["notes", { ...notes, commit: "b".repeat(40) }]]) };
const yamls = { before: "name: t\n", after: "name: t\n# moved\n" } as const;

/** Sets office.lock's `packages:` section, and runtime pins when `pins`. */
function setLock(section: PackageLock, pins = false) {
  rmSync(join(dir, "office.lock"), { force: true });
  editLock(dir, (lock) => {
    lock.packages = section;
  });

  if (pins) writeLock(dir, defaultPins);
}

/**
 * An interrupted publication of `to` over `from`: the journal, the pointer at `active`, office.yaml
 * in the given state and office.lock holding `lock`. `moves: false` publishes the lock alone.
 */
function interrupted(active: "previous" | "candidate", yaml: "before" | "after", lock: PackageLock, { from = sections.empty, to = sections.notes, moves = true, pins = false } = {}) {
  const [previous, candidate] = [`g-${randomUUID()}`, `g-${randomUUID()}`];

  for (const name of [previous, candidate]) mkdirSync(join(dir, ".office/generations", name), { recursive: true });
  rmSync(join(dir, ".office/current"), { force: true });
  symlinkSync(`generations/${active === "previous" ? previous : candidate}`, join(dir, ".office/current"));
  writeFileSync(join(dir, "office.yaml"), yamls[moves ? yaml : "before"]);
  setLock(lock, pins);
  writeFileSync(join(dir, ".office/publishing.json"), JSON.stringify({
    previous, candidate, before: digest(yamls.before), after: digest(yamls[moves ? "after" : "before"]),
    lock: { before: digest(packageSectionKey(from)), after: digest(packageSectionKey(to)), packages: Object.fromEntries(to) },
  }));

  return { previous, candidate };
}

const active = () => readlinkSync(join(dir, ".office/current")).split("/")[1];
const journal = () => existsSync(join(dir, ".office/publishing.json"));

function reserveFrom() {
  using reservation = beginGeneration(dir);

  return reservation.transaction.previous;
}

test("recovery rolls an interrupted switch forward with the lock's packages: section, from both files written or office.yaml alone, keeping runtime pins, finishing a lock-only switch and removing the last section", () => {
  for (const lock of [sections.notes, sections.empty]) {
    const { candidate } = interrupted("previous", "after", lock);

    expect(reserveFrom()).toBe(candidate);
    expect(active()).toBe(candidate);
    expect(readLockSection(dir, "packages")).toEqual(sections.notes);
    expect(journal()).toBe(false);
  }

  const { candidate } = interrupted("candidate", "after", sections.notes);

  expect(reserveFrom()).toBe(candidate);
  expect(active()).toBe(candidate);

  // `office pin` ran after the publisher died: the section is still at "before", the runtime pins are new and kept.
  const { candidate: pinned } = interrupted("previous", "after", sections.empty, { pins: true });

  expect(reserveFrom()).toBe(pinned);
  expect(active()).toBe(pinned);
  expect(readLockSection(dir, "packages")).toEqual(sections.notes);
  expect(readLock(dir)).toEqual(defaultPins);

  // packages update moved only a lock entry: office.yaml is the same before and after.
  for (const lock of [sections.notes, sections.edited]) {
    const { candidate: moved } = interrupted("previous", "before", lock, { from: sections.notes, to: sections.edited, moves: false });

    expect(reserveFrom()).toBe(moved);
    expect(active()).toBe(moved);
    expect(readLockSection(dir, "packages")).toEqual(sections.edited);
  }

  // The last Git package went: office.lock goes with its section, or keeps its runtime pins.
  interrupted("previous", "after", sections.notes, { from: sections.notes, to: sections.empty });
  reserveFrom();
  expect(existsSync(join(dir, "office.lock"))).toBe(false);

  interrupted("previous", "after", sections.notes, { from: sections.notes, to: sections.empty, pins: true });
  reserveFrom();
  expect(readFileSync(join(dir, "office.lock"), "utf8")).not.toContain("packages:");
  expect(readLock(dir)).toEqual(defaultPins);
});

test("recovery accepts a switch that never began, and refuses office.yaml or the packages: section changed independently", () => {
  const { previous } = interrupted("previous", "before", sections.empty, { pins: true });

  expect(reserveFrom()).toBe(previous);
  expect(active()).toBe(previous);
  expect(readLockSection(dir, "packages")).toEqual(sections.empty);
  expect(journal()).toBe(false);

  for (const [pointer, yaml, lock] of [["previous", "before", sections.notes], ["previous", "after", sections.edited], ["candidate", "after", sections.empty], ["previous", "before", sections.edited]] as const) {
    interrupted(pointer, yaml, lock);
    const before = readLockText(dir);

    expect(reserveFrom).toThrow("office.yaml or office.lock's packages: section changed independently");
    expect(readLockText(dir)).toBe(before);
    expect(journal()).toBe(true);
  }
});

test("with a key office.lock doesn't know, no generation is made or published and no interrupted switch rolls forward, each naming the key", () => {
  const unknown = "office.lock has a top-level key office doesn't know: extra";
  const addKey = () => writeFileSync(join(dir, "office.lock"), `${readLockText(dir) ?? ""}extra: true\n`);

  // A fresh office: not even its first generation is made.
  writeFileSync(join(dir, "office.yaml"), yamls.before);
  writeLock(dir, defaultPins);
  addKey();
  const fresh = readLockText(dir);

  expect(reserveFrom).toThrow(unknown);
  expect(existsSync(join(dir, ".office/current"))).toBe(false);
  expect(readLockText(dir)).toBe(fresh);

  // The key appears between reservation and publication: the pointer stays.
  rmSync(join(dir, "office.lock"));
  writeLock(dir, defaultPins);

  {
    using reservation = beginGeneration(dir);
    const before = active();

    addKey();
    const reserved = readLockText(dir);

    expect(() => publishGeneration(reservation.transaction, yamls.after, sections.notes)).toThrow(unknown);
    expect(active()).toBe(before);
    expect(readFileSync(join(dir, "office.yaml"), "utf8")).toBe(yamls.before);
    expect(readLockText(dir)).toBe(reserved);
  }

  // An interrupted switch that would roll forward is left as it was, its journal kept.
  const { previous } = interrupted("previous", "after", sections.empty, { pins: true });
  addKey();
  const interruptedLock = readLockText(dir);

  expect(reserveFrom).toThrow(unknown);
  expect(active()).toBe(previous);
  expect(journal()).toBe(true);
  expect(readLockText(dir)).toBe(interruptedLock);
});

test("a runtime pin write between reservation and publication neither supersedes the publication nor is lost", () => {
  writeFileSync(join(dir, "office.yaml"), yamls.before);
  using reservation = beginGeneration(dir);

  writeLock(dir, defaultPins);
  publishGeneration(reservation.transaction, yamls.before, sections.notes);

  expect(active()).toBe(reservation.transaction.name);
  expect(readLock(dir)).toEqual(defaultPins);
  expect(readLockSection(dir, "packages")).toEqual(sections.notes);
  expect(journal()).toBe(false);
});

test("publication checks for an interrupted switch that appeared after reservation", () => {
  writeFileSync(join(dir, "office.yaml"), yamls.before);
  using reservation = beginGeneration(dir);
  const { previous, name } = reservation.transaction;

  writeFileSync(join(dir, ".office/publishing.json"), JSON.stringify({
    previous, candidate: name, before: digest(yamls.after), after: digest(yamls.after),
    lock: { before: digest(packageSectionKey(sections.empty)), after: digest(packageSectionKey(sections.notes)), packages: Object.fromEntries(sections.notes) },
  }));

  expect(() => publishGeneration(reservation.transaction, yamls.before, sections.notes)).toThrow("office.yaml or office.lock's packages: section changed independently");
  expect(active()).toBe(previous);
  expect(journal()).toBe(true);
});
