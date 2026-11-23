import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Entries, Entry, Registry, RegistryEntry } from "@office/sdk";
import { diffCommand, guidance, seedsDiff, settleCommand, settleSeed } from "../commands.ts";
import type { Seed } from "../handles.ts";
import { applySeeds } from "../seeds.ts";
import { readReceipts, receiptsFile, restoreAdvice, sha256, writeReceipts } from "../store.ts";

let dir: string;
let seed: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-seeds-command-"));
  seed = join(dir, "packages/demo/seed");
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

/** Package demo's declarations: one file seed per path, from its `seed/` folder. */
const declared = (paths = ["mine.md", "notes/AGENTS.md", "notes/README.md"]): Entry<Seed>[] => paths.map(path => ({ owner: "demo", folder: join(dir, "packages/demo"), value: { destination: path, source: `seed/${path}` } }));

/**
 * An office whose package demo's seeds were laid down: `notes/AGENTS.md` and `notes/README.md`
 * from `laid`, and `mine.md`, which was already there.
 */
function office(): void {
  for (const file of ["notes/AGENTS.md", "notes/README.md", "mine.md"]) write(join(seed, file), laid);
  write(join(dir, "mine.md"), "the office's own\n");
  applySeeds(dir, declared());
}

/** Every file in the office, with its bytes. */
function files(folder = dir): Record<string, string> {
  return Object.fromEntries(readdirSync(folder, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => {
    const path = join(entry.parentPath, entry.name);

    return [path.slice(dir.length + 1), readFileSync(path, "utf8")];
  }));
}

const receipts = () => Object.fromEntries(readReceipts(dir));

test("seeds diff shows what the package changed and what the owner changed, the guidance and the settle command, lists pending paths, and changes nothing", () => {
  office();

  expect(seedsDiff(dir, declared())).toBe("No seeds are pending.");
  expect(seedsDiff(dir, declared(), "notes/AGENTS.md")).toBe("notes/AGENTS.md is current: package demo's seed is the one office laid down.");

  write(join(dir, "notes/AGENTS.md"), owned);
  write(join(seed, "notes/AGENTS.md"), newer);
  write(join(seed, "notes/README.md"), newer);
  write(join(seed, "mine.md"), newer);

  const before = files();
  const shown = seedsDiff(dir, declared(), "notes/AGENTS.md");
  const [packageSide, ownerSide] = shown.split("What you changed");

  expect(shown).toStartWith("What package demo changed (the seed office laid down → package demo's seed now):\ndiff --git");
  expect(packageSide).toContain("\n-- Run `office tracks validate` after editing a record.\n+- Run `office tracks check` after editing a record.\n+- Slices under review live in `review/`.");
  expect(ownerSide).toStartWith(" (the seed office laid down → your file):\ndiff --git");
  expect(ownerSide).toContain("\n-- Keep slices under a day.\n");
  expect(ownerSide).toContain("\n+- Always link the PR in the slice.");
  expect(shown).toEndWith(`\n\n${guidance.join("\n")}\n\nWhen you have dealt with it:\n  office seeds settle notes/AGENTS.md`);

  expect(seedsDiff(dir, declared())).toBe("Pending seeds (the package changed its seed, and the file differs from the seed office laid down):\n  notes/AGENTS.md (package demo)\n\nShow one with office seeds diff <path>.");
  // An unchanged file isn't pending: sync replaces it.
  expect(seedsDiff(dir, declared(), "notes/README.md")).toBe("notes/README.md is current: the file is unchanged, so office sync replaces it with package demo's new seed.");

  // A file that was already there has no seed office laid down: a plain comparison, for manual review.
  const manual = seedsDiff(dir, declared(), "mine.md");

  expect(manual).toStartWith("mine.md was already there when package demo was installed, so office has no seed it laid down to compare with.\nThis comparison cannot tell a package addition from an owner deletion; it needs manual review.\n\nYour file → package demo's seed now:\ndiff --git");
  expect(manual).toContain("\n-the office's own\n");
  expect(manual).toEndWith("\n\nWhen you have dealt with it:\n  office seeds settle mine.md");

  expect(() => seedsDiff(dir, declared(), "notes/other.md")).toThrow(`no package seeded notes/other.md: ${receiptsFile} has no receipt for it`);
  expect(files()).toEqual(before);

  rmSync(join(dir, "notes/README.md"));
  expect(seedsDiff(dir, declared(), "notes/README.md")).toBe("notes/README.md is current: the file is deleted or already has package demo's new seed, so office sync records it.");
  expect(() => seedsDiff(dir, declared(["mine.md", "notes/AGENTS.md"]), "notes/README.md")).toThrow("notes/README.md: package demo no longer seeds it");

  // A folder at the seeded path is pending, and never read as the file.
  rmSync(join(dir, "notes/AGENTS.md"));
  mkdirSync(join(dir, "notes/AGENTS.md"));
  expect(seedsDiff(dir, declared(), "notes/AGENTS.md")).toContain("What you changed (the seed office laid down → your file):\n  notes/AGENTS.md isn't a file office reads.\n");

  const hash = sha256(laid);

  writeFileSync(join(dir, ".office/seeds", hash), "corrupt\n");
  expect(() => seedsDiff(dir, declared(), "notes/AGENTS.md")).toThrow(`notes/AGENTS.md: package demo changed its seed, but the seed office laid down, .office/seeds/${hash}, doesn't hash to its name; ${restoreAdvice(hash)}`);
  rmSync(join(dir, ".office/seeds", hash));
  expect(() => seedsDiff(dir, declared(), "notes/AGENTS.md")).toThrow(`notes/AGENTS.md: package demo changed its seed, but the seed office laid down, .office/seeds/${hash}, is missing; ${restoreAdvice(hash)}`);
  expect(restoreAdvice(hash)).toBe(`restore it from Git (git checkout -- .office/seeds/${hash}) or, if it was never committed, copy the file as office laid it down (for an unchanged file, the office's file) to .office/seeds/${hash}`);
});

test("a pending text seed's diff shows the package's new text and the owner's edit, through a temporary file outside the office that is removed", () => {
  const text = (value: string): Entry<Seed>[] => [{ owner: "preview", folder: join(dir, "packages/preview"), value: { destination: "previews/.gitignore", text: value } }];

  mkdirSync(join(dir, "packages/preview"), { recursive: true });
  applySeeds(dir, text("*\n"));
  write(join(dir, "previews/.gitignore"), "*\n# mine\n");
  const before = files();
  const temporary = () => readdirSync(tmpdir()).filter(name => name.startsWith("office-seed-")).sort();
  const earlier = temporary();
  const shown = seedsDiff(dir, text("*\n!keep\n"), "previews/.gitignore");
  const [packageSide, ownerSide] = shown.split("What you changed");

  expect(packageSide).toStartWith("What package preview changed (the seed office laid down → package preview's seed now):\ndiff --git");
  expect(packageSide).toContain("\n+!keep\n");
  expect(packageSide).not.toContain("# mine");
  expect(ownerSide).toContain("\n+# mine");
  expect(ownerSide).not.toContain("!keep");
  expect(files()).toEqual(before);
  expect(temporary()).toEqual(earlier);
});

test("printed commands quote a path that needs it, and settle takes a path with a space", () => {
  const path = "notes/it's mine.md";
  const spaced = "my notes/a b.md";
  const paths = ["mine.md", "notes/AGENTS.md", "notes/README.md", path, spaced];

  office();
  write(join(seed, path), laid);
  write(join(seed, spaced), laid);
  applySeeds(dir, declared(paths));
  write(join(dir, path), owned);
  write(join(seed, path), newer);

  expect(applySeeds(dir, declared(paths))).toEqual([`pending ${path}: package demo changed its seed, and the file differs from the seed office laid down; office seeds diff 'notes/it'\\''s mine.md'`]);
  expect(seedsDiff(dir, declared(paths), path)).toEndWith("\n  office seeds settle 'notes/it'\\''s mine.md'");

  write(join(dir, spaced), owned);
  write(join(seed, spaced), newer);
  expect(settleSeed(dir, declared(paths), spaced)).toStartWith(`settled ${spaced}: recorded package demo's seed`);
  expect(receipts()[spaced]).toEqual({ package: "demo", sha256: sha256(newer) });
});

test("seeds settle stores the package's current seed and then records it, leaving the file; the earlier seed stays and sync stops reporting the path", () => {
  office();
  write(join(dir, "notes/AGENTS.md"), owned);
  write(join(seed, "notes/AGENTS.md"), newer);
  expect(applySeeds(dir, declared())).toEqual(["pending notes/AGENTS.md: package demo changed its seed, and the file differs from the seed office laid down; office seeds diff notes/AGENTS.md"]);

  expect(settleSeed(dir, declared(), "notes/AGENTS.md")).toBe(`settled notes/AGENTS.md: recorded package demo's seed ${sha256(newer).slice(0, 12)}, stored as .office/seeds/${sha256(newer)}; the file is unchanged. Commit .office/seeds/.`);
  expect(receipts()["notes/AGENTS.md"]).toEqual({ package: "demo", sha256: sha256(newer) });
  expect(readFileSync(join(dir, ".office/seeds", sha256(newer)), "utf8")).toBe(newer);
  expect(readFileSync(join(dir, ".office/seeds", sha256(laid)), "utf8")).toBe(laid);
  expect(readFileSync(join(dir, "notes/AGENTS.md"), "utf8")).toBe(owned);
  expect(applySeeds(dir, declared())).toEqual([]);
  expect(seedsDiff(dir, declared())).toBe("No seeds are pending.");

  // Settling again changes nothing, not even the store's guard.
  const text = readFileSync(join(dir, receiptsFile), "utf8");

  rmSync(join(dir, ".office/seeds/.gitattributes"));
  expect(settleSeed(dir, declared(), "notes/AGENTS.md")).toBe("notes/AGENTS.md is current: package demo's seed is the one its receipt names; nothing to settle.");
  expect(readFileSync(join(dir, receiptsFile), "utf8")).toBe(text);
  expect(existsSync(join(dir, ".office/seeds/.gitattributes"))).toBe(false);

  // Settling an unchanged file declines sync's replacement; a folder at the path is settled and left.
  write(join(seed, "notes/README.md"), newer);
  expect(settleSeed(dir, declared(), "notes/README.md")).toEndWith(", declining the automatic replacement: the file stays as it is, and office sync won't replace it with this seed. Commit .office/seeds/.");
  expect(readFileSync(join(dir, "notes/README.md"), "utf8")).toBe(laid);
  write(join(seed, "notes/AGENTS.md"), laid);
  rmSync(join(dir, "notes/AGENTS.md"));
  mkdirSync(join(dir, "notes/AGENTS.md"));
  expect(settleSeed(dir, declared(), "notes/AGENTS.md")).toEndWith("; the file is unchanged. Commit .office/seeds/.");
  expect(readdirSync(join(dir, "notes/AGENTS.md"))).toEqual([]);
  expect(applySeeds(dir, declared())).toEqual([]);
});

test("settling a file that was already there gives it a stored seed, guarded from Git's conversions, so later updates are offered", () => {
  office();
  rmSync(join(dir, ".office/seeds"), { recursive: true, force: true });
  writeReceipts(dir, new Map([["mine.md", { package: "demo", existing: true }]]));

  expect(settleSeed(dir, declared(), "mine.md")).toStartWith("settled mine.md: recorded package demo's seed");
  expect(receipts()).toEqual({ "mine.md": { package: "demo", sha256: sha256(laid) } });
  expect(readdirSync(join(dir, ".office/seeds")).sort()).toEqual([".gitattributes", "receipts.json", sha256(laid)].sort());
  expect(readFileSync(join(dir, "mine.md"), "utf8")).toBe("the office's own\n");

  write(join(seed, "mine.md"), newer);
  expect(seedsDiff(dir, declared(["mine.md"]))).toContain("  mine.md (package demo)");
});

test("seeds settle fails, changing nothing, for a path without a receipt, a seed no package declares any more, or a missing or corrupt stored seed", () => {
  office();
  write(join(seed, "notes/AGENTS.md"), newer);
  rmSync(join(dir, ".office/seeds", sha256(laid)));
  const without = declared(["mine.md", "notes/AGENTS.md"]);
  const before = files();

  expect(() => settleSeed(dir, without, "notes/other.md")).toThrow("no package seeded notes/other.md");
  expect(() => settleSeed(dir, without, "notes/README.md")).toThrow("notes/README.md: package demo no longer has a seed for it, so there is nothing to settle");
  expect(() => settleSeed(dir, without, "notes/AGENTS.md")).toThrow(`notes/AGENTS.md: not settled: the seed office laid down, .office/seeds/${sha256(laid)}, is missing; ${restoreAdvice(sha256(laid))}`);
  expect(files()).toEqual(before);
  write(join(dir, ".office/seeds", sha256(laid)), "corrupt\n");
  expect(() => settleSeed(dir, without, "notes/AGENTS.md")).toThrow(`notes/AGENTS.md: not settled: the seed office laid down, .office/seeds/${sha256(laid)}, doesn't hash to its name; ${restoreAdvice(sha256(laid))}`);
  expect(receipts()["notes/AGENTS.md"]).toEqual({ package: "demo", sha256: sha256(laid) });
  expect(existsSync(join(dir, ".office/seeds", sha256(newer)))).toBe(false);

  // A path another package now declares is not demo's to settle.
  const other: Entry<Seed>[] = [{ owner: "other", folder: join(dir, "packages/demo"), value: { destination: "notes/README.md", source: "seed/notes/README.md" } }];

  expect(() => settleSeed(dir, other, "notes/README.md")).toThrow("notes/README.md: package demo no longer has a seed for it");
});

test("a folder where a stored seed belongs is unusable: diff and settle refuse naming it with its repair, and settle never replaces one at the new seed's place", () => {
  office();
  write(join(seed, "notes/AGENTS.md"), newer);
  write(join(dir, "notes/AGENTS.md"), owned);
  const laidAt = join(dir, ".office/seeds", sha256(laid));

  rmSync(laidAt);
  mkdirSync(laidAt);
  const unusable = `the seed office laid down, .office/seeds/${sha256(laid)}, is not a file; remove it, then ${restoreAdvice(sha256(laid))}`;
  const before = files();

  expect(() => seedsDiff(dir, declared(), "notes/AGENTS.md")).toThrow(`notes/AGENTS.md: package demo changed its seed, but ${unusable}`);
  expect(() => settleSeed(dir, declared(), "notes/AGENTS.md")).toThrow(`notes/AGENTS.md: not settled: ${unusable}`);
  expect(files()).toEqual(before);
  expect(readdirSync(laidAt)).toEqual([]);

  // A folder at the place the new seed would be stored: the file already there can't be settled, and the folder stays.
  const newerAt = join(dir, ".office/seeds", sha256(newer));

  write(join(seed, "mine.md"), newer);
  mkdirSync(newerAt);
  expect(() => settleSeed(dir, declared(), "mine.md")).toThrow(`mine.md: not settled: .office/seeds/${sha256(newer)} is not a file, so it isn't copied; remove it, then ${restoreAdvice(sha256(newer))}`);
  expect(readdirSync(newerAt)).toEqual([]);
  expect(receipts()["mine.md"]).toEqual({ package: "demo", existing: true });
});

/** A command's inputs over `list`, whatever registry is asked for: the seeds commands read only the seeds registry. */
function inputs(args: string[], list: Entry<Seed>[]) {
  const entries: Entries = <Value extends RegistryEntry>(registry: Registry<Value>) => list.flatMap(item => (registry.id === "seeds.seed" ? [{ ...item, value: registry.parse(item.value) }] : []));

  return { office: { dir, name: "test", mode: "container" as const, launcher: "office" }, entries, settings: {}, args };
}

test("the commands print their output, and fail with exit status 1 and one line, changing nothing, for a wrong number of words, an invalid receipts file, or one of the wrong shape", () => {
  office();
  const out = spyOn(console, "log").mockImplementation(() => undefined);
  const err = spyOn(console, "error").mockImplementation(() => undefined);

  const run = (command: typeof diffCommand, args: string[]) => {
    out.mockClear();
    err.mockClear();
    process.exitCode = 0;
    command(inputs(args, declared()));

    return { code: process.exitCode, out: out.mock.calls.map(call => call.join(" ")), err: err.mock.calls.map(call => call.join(" ")) };
  };

  try {
    expect(run(diffCommand, [])).toEqual({ code: 0, out: ["No seeds are pending."], err: [] });
    expect(run(diffCommand, ["a", "b"])).toEqual({ code: 1, out: [], err: ["office: usage: office seeds diff [<path>]: one path at most, not 2"] });
    expect(run(settleCommand, [])).toEqual({ code: 1, out: [], err: ["office: usage: office seeds settle <path>: exactly one path, not 0"] });
    expect(run(settleCommand, ["notes/other.md"]).err).toEqual([`office: no package seeded notes/other.md: ${receiptsFile} has no receipt for it (give the path relative to the office's folder)`]);
    // One leading -- is dropped, as printed before a path that starts with a dash; a second is the path.
    expect(run(diffCommand, ["--"])).toEqual({ code: 0, out: ["No seeds are pending."], err: [] });
    expect(run(diffCommand, ["--", "a", "b"]).err).toEqual(["office: usage: office seeds diff [<path>]: one path at most, not 2"]);
    expect(run(settleCommand, ["--"]).err).toEqual(["office: usage: office seeds settle <path>: exactly one path, not 0"]);
    expect(run(settleCommand, ["--", "--"]).err).toEqual([`office: no package seeded --: ${receiptsFile} has no receipt for it (give the path relative to the office's folder)`]);
    expect(run(diffCommand, ["--", "--help"]).err).toEqual([`office: no package seeded --help: ${receiptsFile} has no receipt for it (give the path relative to the office's folder)`]);

    for (const text of ["not json", '{ "receipts": [] }']) {
      write(join(dir, receiptsFile), text);
      const before = files();

      for (const [command, args] of [[diffCommand, []], [diffCommand, ["mine.md"]], [settleCommand, ["mine.md"]]] as const) {
        const result = run(command, [...args]);

        expect(result.code).toBe(1);
        expect(result.err).toEqual([expect.stringMatching(/^office: \.office\/seeds\/receipts\.json is not valid/)]);
      }

      expect(files()).toEqual(before);
    }
  } finally {
    process.exitCode = 0;
    out.mockRestore();
    err.mockRestore();
  }
});
