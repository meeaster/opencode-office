import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadOffice } from "../office.ts";
import { applySeeds, restoreAdvice, sha256 } from "../seeds.ts";
import { editLock, readLockSection } from "../versions.ts";
import { guidance, seedsDiff, settleSeed } from "./seeds.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-seeds-command-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const laid = "- Keep slices under a day.\n- Run `office tracks validate` after editing a record.\n";
const newer = "- Keep slices under a day.\n- Run `office tracks check` after editing a record.\n- Slices under review live in `review/`.\n";
const owned = "- Run `office tracks validate` after editing a record.\n- Always link the PR in the slice.\n";
const seed = () => join(dir, "packages/demo/seed");

/**
 * An office with local package demo, whose seeds were laid down: `notes/AGENTS.md` and
 * `notes/README.md` from `laid`, and `mine.md`, which was already there.
 */
function office() {
  write(join(dir, "office.yaml"), "name: t\npackages:\n  - name: demo\n");
  write(join(dir, "packages/demo/package.yaml"), "name: demo\ndescription: A demo package.\n");

  for (const file of ["notes/AGENTS.md", "notes/README.md", "mine.md"]) write(join(seed(), file), laid);
  write(join(dir, "mine.md"), "the office's own\n");
  applySeeds(dir, "demo", seed(), ["mine.md", "notes/AGENTS.md", "notes/README.md"]);

  return loadOffice(dir);
}

/** Every file in the office, with its bytes. */
function files(folder = dir): Record<string, string> {
  return Object.fromEntries(readdirSync(folder, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => {
    const path = join(entry.parentPath, entry.name);

    return [path.slice(dir.length + 1), readFileSync(path, "utf8")];
  }));
}

const receipts = () => Object.fromEntries(readLockSection(dir, "seeds"));

test("seeds diff shows what the package changed and what the owner changed, the guidance and the settle command, lists pending paths, and changes nothing", () => {
  const loaded = office();

  expect(seedsDiff(loaded)).toBe("No seeds are pending.");
  expect(seedsDiff(loaded, "notes/AGENTS.md")).toBe("notes/AGENTS.md is current: package demo's seed is the one office laid down.");

  write(join(dir, "notes/AGENTS.md"), owned);
  write(join(seed(), "notes/AGENTS.md"), newer);
  write(join(seed(), "notes/README.md"), newer);
  write(join(seed(), "mine.md"), newer);

  const before = files();
  const shown = seedsDiff(loaded, "notes/AGENTS.md");
  const [packageSide, ownerSide] = shown.split("What you changed");

  expect(shown).toStartWith("What package demo changed (the seed office laid down → package demo's seed now):\ndiff --git");
  expect(packageSide).toContain("\n-- Run `office tracks validate` after editing a record.\n+- Run `office tracks check` after editing a record.\n+- Slices under review live in `review/`.");
  expect(ownerSide).toStartWith(" (the seed office laid down → your file):\ndiff --git");
  expect(ownerSide).toContain("\n-- Keep slices under a day.\n");
  expect(ownerSide).toContain("\n+- Always link the PR in the slice.");
  expect(shown).toEndWith(`\n\n${guidance.join("\n")}\n\nWhen you have dealt with it:\n  office seeds settle notes/AGENTS.md`);
  expect(guidance).toEqual(["Keep owner deletions deleted, including package rewrites of deleted rules or sections.", "If nothing else applies, leave the file unchanged and settle."]);

  expect(seedsDiff(loaded)).toBe("Pending seeds (the package changed its seed, and the file differs from the seed office laid down):\n  notes/AGENTS.md (package demo)\n\nShow one with office seeds diff <path>.");
  // An unchanged file isn't pending: sync replaces it.
  expect(seedsDiff(loaded, "notes/README.md")).toBe("notes/README.md is current: the file is unchanged, so office sync replaces it with package demo's new seed.");

  // A file that was already there has no seed office laid down: a plain comparison, for manual review.
  const manual = seedsDiff(loaded, "mine.md");

  expect(manual).toStartWith("mine.md was already there when package demo was installed, so office has no seed it laid down to compare with.\nThis comparison cannot tell a package addition from an owner deletion; it needs manual review.\n\nYour file → package demo's seed now:\ndiff --git");
  expect(manual).toContain("\n-the office's own\n");
  expect(manual).toEndWith("\n\nWhen you have dealt with it:\n  office seeds settle mine.md");

  expect(() => seedsDiff(loaded, "notes/other.md")).toThrow("no package seeded notes/other.md");
  expect(files()).toEqual(before);

  rmSync(join(dir, "notes/README.md"));
  expect(seedsDiff(loaded, "notes/README.md")).toBe("notes/README.md is current: the file is deleted or already has package demo's new seed, so office sync records it.");
  rmSync(join(seed(), "notes/README.md"));
  expect(() => seedsDiff(loaded, "notes/README.md")).toThrow("notes/README.md: package demo no longer seeds it");

  // A folder at the seeded path is pending, and never read as the file.
  rmSync(join(dir, "notes/AGENTS.md"));
  mkdirSync(join(dir, "notes/AGENTS.md"));
  expect(seedsDiff(loaded, "notes/AGENTS.md")).toContain("What you changed (the seed office laid down → your file):\n  notes/AGENTS.md isn't a file office reads.\n");

  const hash = sha256(laid);

  writeFileSync(join(dir, ".office/seeds", hash), "corrupt\n");
  expect(() => seedsDiff(loaded, "notes/AGENTS.md")).toThrow(`notes/AGENTS.md: package demo changed its seed, but the seed office laid down, .office/seeds/${hash}, doesn't hash to its name; ${restoreAdvice(hash)}`);
  rmSync(join(dir, ".office/seeds", hash));
  expect(() => seedsDiff(loaded, "notes/AGENTS.md")).toThrow(`notes/AGENTS.md: package demo changed its seed, but the seed office laid down, .office/seeds/${hash}, is missing; ${restoreAdvice(hash)}`);
  expect(restoreAdvice(hash)).toBe(`restore it from Git (git checkout -- .office/seeds/${hash}) or, if it was never committed, copy the file as office laid it down (for an unchanged file, the office's file) to .office/seeds/${hash}`);
});

test("printed commands quote a path that needs it", () => {
  const loaded = office();
  const path = "notes/it's mine.md";

  write(join(seed(), path), laid);
  applySeeds(dir, "demo", seed(), ["mine.md", "notes/AGENTS.md", "notes/README.md", path]);
  write(join(dir, path), owned);
  write(join(seed(), path), newer);

  expect(applySeeds(dir, "demo", seed(), ["mine.md", "notes/AGENTS.md", "notes/README.md", path])).toEqual([`pending ${path}: package demo changed its seed, and the file differs from the seed office laid down; office seeds diff 'notes/it'\\''s mine.md'`]);
  expect(seedsDiff(loaded, path)).toEndWith("\n  office seeds settle 'notes/it'\\''s mine.md'");
});

test("seeds settle stores the package's current seed and then records it, leaving the file; the earlier seed stays and sync stops reporting the path", () => {
  const loaded = office();

  write(join(dir, "notes/AGENTS.md"), owned);
  write(join(seed(), "notes/AGENTS.md"), newer);
  expect(applySeeds(dir, "demo", seed(), ["mine.md", "notes/AGENTS.md", "notes/README.md"])).toEqual(["pending notes/AGENTS.md: package demo changed its seed, and the file differs from the seed office laid down; office seeds diff notes/AGENTS.md"]);

  expect(settleSeed(loaded, "notes/AGENTS.md")).toBe(`settled notes/AGENTS.md: recorded package demo's seed ${sha256(newer).slice(0, 12)}, stored as .office/seeds/${sha256(newer)}; the file is unchanged. Commit office.lock and .office/seeds/.`);
  expect(receipts()["notes/AGENTS.md"]).toEqual({ package: "demo", sha256: sha256(newer) });
  expect(readFileSync(join(dir, ".office/seeds", sha256(newer)), "utf8")).toBe(newer);
  expect(readFileSync(join(dir, ".office/seeds", sha256(laid)), "utf8")).toBe(laid);
  expect(readFileSync(join(dir, "notes/AGENTS.md"), "utf8")).toBe(owned);
  expect(applySeeds(dir, "demo", seed(), ["mine.md", "notes/AGENTS.md", "notes/README.md"])).toEqual([]);
  expect(seedsDiff(loaded)).toBe("No seeds are pending.");

  // Settling again changes nothing, not even the store's guard.
  const lock = readFileSync(join(dir, "office.lock"), "utf8");

  rmSync(join(dir, ".office/seeds/.gitattributes"));
  expect(settleSeed(loaded, "notes/AGENTS.md")).toBe("notes/AGENTS.md is current: package demo's seed is the one its receipt names; nothing to settle.");
  expect(readFileSync(join(dir, "office.lock"), "utf8")).toBe(lock);
  expect(existsSync(join(dir, ".office/seeds/.gitattributes"))).toBe(false);

  // Settling an unchanged file declines sync's replacement; a folder at the path is settled and left.
  write(join(seed(), "notes/README.md"), newer);
  expect(settleSeed(loaded, "notes/README.md")).toEndWith(", declining the automatic replacement: the file stays as it is, and office sync won't replace it with this seed. Commit office.lock and .office/seeds/.");
  expect(readFileSync(join(dir, "notes/README.md"), "utf8")).toBe(laid);
  write(join(seed(), "notes/AGENTS.md"), laid);
  rmSync(join(dir, "notes/AGENTS.md"));
  mkdirSync(join(dir, "notes/AGENTS.md"));
  expect(settleSeed(loaded, "notes/AGENTS.md")).toEndWith("; the file is unchanged. Commit office.lock and .office/seeds/.");
  expect(readdirSync(join(dir, "notes/AGENTS.md"))).toEqual([]);
  expect(applySeeds(dir, "demo", seed(), ["mine.md", "notes/AGENTS.md", "notes/README.md"])).toEqual([]);
});

test("settling a file that was already there gives it a stored seed, guarded from Git's conversions, so later updates are offered", () => {
  const loaded = office();

  rmSync(join(dir, ".office"), { recursive: true });
  expect(settleSeed(loaded, "mine.md")).toStartWith("settled mine.md: recorded package demo's seed");
  expect(receipts()["mine.md"]).toEqual({ package: "demo", sha256: sha256(laid) });
  expect(readdirSync(join(dir, ".office/seeds")).sort()).toEqual([".gitattributes", sha256(laid)].sort());
  expect(readFileSync(join(dir, "mine.md"), "utf8")).toBe("the office's own\n");

  write(join(seed(), "mine.md"), newer);
  expect(seedsDiff(loaded)).toContain("  mine.md (package demo)");
});

test("seeds settle fails, changing nothing, for a path without a receipt, a seed the package dropped, or a missing or corrupt stored seed", () => {
  const loaded = office();

  write(join(seed(), "notes/AGENTS.md"), newer);
  rmSync(join(seed(), "notes/README.md"));
  rmSync(join(dir, ".office/seeds", sha256(laid)));

  const before = files();

  expect(() => settleSeed(loaded, "notes/other.md")).toThrow("no package seeded notes/other.md");
  expect(() => settleSeed(loaded, "notes/README.md")).toThrow("notes/README.md: package demo no longer has a seed for it, so there is nothing to settle");
  expect(() => settleSeed(loaded, "notes/AGENTS.md")).toThrow(`notes/AGENTS.md: not settled: the seed office laid down, .office/seeds/${sha256(laid)}, is missing; ${restoreAdvice(sha256(laid))}`);
  expect(files()).toEqual(before);
  write(join(dir, ".office/seeds", sha256(laid)), "corrupt\n");
  expect(() => settleSeed(loaded, "notes/AGENTS.md")).toThrow(`notes/AGENTS.md: not settled: the seed office laid down, .office/seeds/${sha256(laid)}, doesn't hash to its name; ${restoreAdvice(sha256(laid))}`);
  expect(receipts()["notes/AGENTS.md"]).toEqual({ package: "demo", sha256: sha256(laid) });
  expect(existsSync(join(dir, ".office/seeds", sha256(newer)))).toBe(false);
});

test("a path whose package isn't installed can't be diffed or settled", () => {
  const loaded = office();

  editLock(dir, ({ seeds }) => {
    seeds.set("other.md", { package: "absent", sha256: sha256(laid) });
  });
  expect(() => seedsDiff(loaded, "other.md")).toThrow("package absent, which seeded other.md, isn't installed or couldn't be read; run office sync");
  expect(() => settleSeed(loaded, "other.md")).toThrow("package absent, which seeded other.md, isn't installed or couldn't be read");
});

test("office seeds rejects unknown flags", () => {
  const run = Bun.spawnSync([process.execPath, join(import.meta.dir, "../cli.ts"), "seeds", "diff", "--verbose"], { cwd: dir });

  expect(run.exitCode).toBe(1);
  expect(run.stderr.toString()).toBe("office: usage: office seeds diff [path] | office seeds settle <path> [--office <dir>]\n");
});
