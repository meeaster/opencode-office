import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { SeedReceipt } from "./schema.ts";
import { copySeeds, seedReceiptProblems, settleReceipts, sha256 } from "./seeds.ts";
import { editLock, readLockSection } from "./versions.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-seeds-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function setSeeds(entries: Record<string, SeedReceipt>) {
  editLock(dir, (sections) => {
    sections.seeds = new Map(Object.entries(entries));
  });
}

const receipts = () => Object.fromEntries(readLockSection(dir, "seeds"));

test("removal judges each seed file by its receipt: unchanged created files go even when the template changed upstream, edited and existing ones stay", () => {
  // The package's copy is gone or newer: removal reads only the receipts.
  const files = { "out/deep/created.md": "created\n", "out/edited.md": "the office edited this\n", "out/upstream.md": "version one\n", "out/existing.md": "the office's own\n", "other.md": "another package's\n" };

  for (const [file, text] of Object.entries(files)) write(join(dir, file), text);
  setSeeds({
    "out/deep/created.md": { package: "demo", sha256: sha256("created\n") },
    "out/edited.md": { package: "demo", sha256: sha256("as written\n") },
    "out/upstream.md": { package: "demo", sha256: sha256("version one\n") },
    "out/gone.md": { package: "demo", sha256: sha256("gone\n") },
    "out/existing.md": { package: "demo", existing: true },
    "other.md": { package: "other", sha256: sha256("another package's\n") },
  });

  expect(settleReceipts(dir, (name) => name === "demo")).toEqual([
    "deleted out/deep/created.md, which package demo created",
    "kept out/edited.md, which changed since package demo wrote it",
    "deleted out/upstream.md, which package demo created",
  ]);
  expect(existsSync(join(dir, "out/deep"))).toBe(false);
  expect(readFileSync(join(dir, "out/existing.md"), "utf8")).toBe("the office's own\n");
  expect(Object.keys(receipts())).toEqual(["other.md"]);
});

test("seed copying and removal never pass through a linked folder, whether it leads outside the office or to another folder inside it", () => {
  const office = join(dir, "office");
  const outside = join(dir, "outside");
  const template = join(dir, "template");

  write(join(template, "away/new.md"), "same\n");
  write(join(template, "alias/new.md"), "same\n");
  write(join(outside, "old.md"), "same\n");
  write(join(office, "real/old.md"), "same\n");
  symlinkSync(outside, join(office, "away"));
  symlinkSync("real", join(office, "alias"));

  expect(copySeeds(office, "demo", template, ["alias/new.md", "away/new.md"])).toEqual([
    "FAILED package demo's template/alias/new.md: alias is a link, which office doesn't follow",
    "FAILED package demo's template/away/new.md: away is a link, which office doesn't follow",
  ]);
  expect(readLockSection(office, "seeds")).toEqual(new Map());

  editLock(office, (sections) => {
    sections.seeds = new Map([["away/old.md", { package: "demo", sha256: sha256("same\n") }], ["alias/old.md", { package: "demo", sha256: sha256("same\n") }]]);
  });
  expect(settleReceipts(office, (name) => name === "demo")).toEqual([
    "kept alias/old.md, because alias is a link, which office doesn't follow",
    "kept away/old.md, because away is a link, which office doesn't follow",
  ]);
  expect(readdirSync(outside)).toEqual(["old.md"]);
  expect(readdirSync(join(office, "real"))).toEqual(["old.md"]);
});

test("a failed copy keeps the receipts of the files already copied, so the next copy doesn't mark them as already there", () => {
  const template = join(dir, "template");
  const office = join(dir, "office");

  write(join(template, "a.md"), "first\n");
  mkdirSync(office);

  // b.md isn't in the package's copy, so reading it fails after a.md was written.
  const failed = copySeeds(office, "demo", template, ["a.md", "b.md"]);

  expect(failed[0]).toBe("created a.md from package demo");
  expect(failed[1]).toStartWith("FAILED package demo's template/b.md: ENOENT");
  expect(Object.fromEntries(readLockSection(office, "seeds"))).toEqual({ "a.md": { package: "demo", sha256: sha256("first\n") } });

  write(join(template, "b.md"), "second\n");
  expect(copySeeds(office, "demo", template, ["a.md", "b.md"])).toEqual(["created b.md from package demo"]);
  expect(readLockSection(office, "seeds").get("a.md")).toEqual({ package: "demo", sha256: sha256("first\n") });
});

test("check reports an unreadable seeds: section and receipts of packages office.yaml no longer lists, except a local package's", () => {
  const sha = "0".repeat(64);
  const selected = new Set(["notes"]);

  mkdirSync(join(dir, "packages/mine"), { recursive: true });
  writeFileSync(join(dir, "office.lock"), `seeds:\n  a.md: { package: notes, sha256: "${sha}" }\n  b.md: { package: gone, existing: true }\n  c.md: { package: gone, sha256: "${sha}" }\n  d.md: { package: mine, existing: true }\n`);

  expect(seedReceiptProblems(dir, selected)).toEqual(["office.lock holds seed receipts of package gone, which office.yaml no longer lists (office sync deletes the files it created that are unchanged, and drops the receipts)"]);

  writeFileSync(join(dir, "office.lock"), "seeds:\n  /etc/passwd: { package: notes, existing: true }\n");
  expect(seedReceiptProblems(dir, selected)).toEqual([expect.stringMatching(/^office sync copies and removes no seed file until this is fixed: office\.lock is not valid/)]);
});
