import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installPackages } from "../../../../src/loader/publication/install.ts";
import { defaultPins, editLock, readLock, readLockSection, readLockText, writeLock } from "../../../../src/versions.ts";

let dir: string;
const original = "name: test\n";
const updated = "name: test\n# updated\n";
const packages = new Map([["notes", { repo: "https://example.com/packages.git", path: "notes", ref: "v1", commit: "a".repeat(40) }]]);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-install-"));
  writeFileSync(join(dir, "office.yaml"), original);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function stage() {
  const folder = join(dir, ".office/tmp/stage");

  for (const path of ["packages/notes", "installed-links/node_modules/@office", "withdrawals"]) mkdirSync(join(folder, path), { recursive: true });

  for (const file of ["selection.json", "unavailable.json"]) writeFileSync(join(folder, file), "[]");
  writeFileSync(join(folder, "packages/notes/edition"), "incoming");

  return { dir, folder, original, lock: readLockText(dir) };
}

test("install replaces package folders and merges only the packages lock section", () => {
  const installed = join(dir, ".office/packages");
  mkdirSync(join(installed, "notes"), { recursive: true });
  mkdirSync(join(installed, "retired"), { recursive: true });
  mkdirSync(join(installed, "unknown"), { recursive: true });
  writeFileSync(join(installed, "notes/edition"), "old");
  writeFileSync(join(installed, "retired/.source.json"), JSON.stringify({ office: "old", commit: "old", files: {} }));
  writeFileSync(join(installed, "unknown/edition"), "owner");
  const candidate = stage();

  writeLock(dir, defaultPins);
  editLock(dir, lock => { lock.tools.set("core:node", { version: "26.13.1" }); });
  installPackages(candidate, updated, packages, tools => new Map([...tools, ["core:bun", { version: "1.4.5" }]]));

  expect(readFileSync(join(installed, "notes/edition"), "utf8")).toBe("incoming");
  expect(existsSync(join(installed, "retired"))).toBe(false);
  expect(readFileSync(join(installed, "unknown/edition"), "utf8")).toBe("owner");
  expect(readLock(dir)).toEqual(defaultPins);
  expect(readLockSection(dir, "packages")).toEqual(packages);
  expect(readLockSection(dir, "tools")).toEqual(new Map([
    ["core:bun", { version: "1.4.5" }],
    ["core:node", { version: "26.13.1" }],
  ]));
  expect(readFileSync(join(dir, "office.yaml"), "utf8")).toBe(updated);
});

test("install refuses independently changed config and lock entries, before moving any folders", () => {
  const candidate = stage();
  const installed = join(dir, ".office/packages");

  writeFileSync(join(dir, "office.yaml"), updated);
  expect(() => installPackages(candidate, original, packages)).toThrow("package publication superseded");
  expect(existsSync(installed)).toBe(false);

  writeFileSync(join(dir, "office.yaml"), original);
  editLock(dir, lock => { lock.packages = packages; });
  expect(() => installPackages(candidate, updated, new Map())).toThrow("package publication superseded");
  expect(existsSync(installed)).toBe(false);
  expect(readLockSection(dir, "packages")).toEqual(packages);
});

test("install checks destination types and unknown lock keys before moving any folders", () => {
  const candidate = stage();
  const installed = join(dir, ".office/packages");

  symlinkSync(candidate.folder, installed);
  expect(() => installPackages(candidate, updated, packages)).toThrow(`cannot use ${installed}: expected a real folder`);
  rmSync(installed);

  writeFileSync(join(dir, "office.lock"), "extra: true\n");
  expect(() => installPackages(candidate, updated, packages)).toThrow("office.lock has a top-level key office doesn't know: extra");
  expect(existsSync(installed)).toBe(false);
  expect(readFileSync(join(dir, "office.yaml"), "utf8")).toBe(original);
});
