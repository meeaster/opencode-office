import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { SeedReceipt } from "./schema.ts";
import { applySeeds, classifySeed, keepSeedAttributes, type OfficeFile, type SeedClass, restoreAdvice, seedReceiptProblems, settleReceipts, sha256 } from "./seeds.ts";
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

test("removal judges each seed file by its receipt: unchanged created files go even when the seed changed upstream, edited and existing ones stay", () => {
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
  const seed = join(dir, "seed");

  write(join(seed, "away/new.md"), "same\n");
  write(join(seed, "alias/new.md"), "same\n");
  write(join(outside, "old.md"), "same\n");
  write(join(office, "real/old.md"), "same\n");
  symlinkSync(outside, join(office, "away"));
  symlinkSync("real", join(office, "alias"));

  expect(applySeeds(office, "demo", seed, ["alias/new.md", "away/new.md"])).toEqual([
    "FAILED package demo's seed/alias/new.md: alias is a link, which office doesn't follow",
    "FAILED package demo's seed/away/new.md: away is a link, which office doesn't follow",
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
  const seed = join(dir, "seed");
  const office = join(dir, "office");

  write(join(seed, "a.md"), "first\n");
  mkdirSync(office);

  // b.md isn't in the package's copy, so reading it fails after a.md was written.
  const failed = applySeeds(office, "demo", seed, ["a.md", "b.md"]);

  expect(failed[0]).toBe("created a.md from package demo");
  expect(failed[1]).toStartWith("FAILED package demo's seed/b.md: ENOENT");
  expect(Object.fromEntries(readLockSection(office, "seeds"))).toEqual({ "a.md": { package: "demo", sha256: sha256("first\n") } });

  write(join(seed, "b.md"), "second\n");
  expect(applySeeds(office, "demo", seed, ["a.md", "b.md"])).toEqual(["created b.md from package demo"]);
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

const stored = (office: string) => (existsSync(join(office, ".office/seeds")) ? readdirSync(join(office, ".office/seeds")).sort() : []);

const attributes = "* -text -filter -ident -working-tree-encoding\n";

test("a copied seed is stored under its hash first; a file already there and a path in .office/ store nothing", () => {
  const seed = join(dir, "seed");
  const office = join(dir, "office");
  const bytes = "created\r\nwith CRLF\r\n";

  write(join(seed, "notes/AGENTS.md"), bytes);
  write(join(seed, "kept.md"), "the package's\n");
  write(join(seed, ".office/seeds/x"), "aimed at the plumbing\n");
  write(join(office, "kept.md"), "the office's own\n");

  expect(applySeeds(office, "demo", seed, [".office/seeds/x", "kept.md", "notes/AGENTS.md"])).toEqual([
    "FAILED package demo's seed/.office/seeds/x: in .office/, which office manages",
    "kept kept.md, which was already there, instead of package demo's copy",
    "created notes/AGENTS.md from package demo",
  ]);
  expect(Object.fromEntries(readLockSection(office, "seeds"))).toEqual({ "kept.md": { package: "demo", existing: true }, "notes/AGENTS.md": { package: "demo", sha256: sha256(bytes) } });
  expect(stored(office)).toEqual([sha256(bytes)]);
  expect(readFileSync(join(office, ".office/seeds", sha256(bytes)), "utf8")).toBe(bytes);

  // A seed already stored is left as it is.
  write(join(seed, "again.md"), bytes);
  expect(applySeeds(office, "demo", seed, ["again.md", "kept.md", "notes/AGENTS.md"])).toEqual(["created again.md from package demo"]);
  expect(stored(office)).toEqual([sha256(bytes)]);

  // Removing the package deletes its unchanged files and receipts, never a stored seed.
  expect(settleReceipts(office, (name) => name === "demo")).toEqual(["deleted again.md, which package demo created", "deleted notes/AGENTS.md, which package demo created"]);
  expect(readLockSection(office, "seeds")).toEqual(new Map());
  expect(stored(office)).toEqual([sha256(bytes)]);
});

test("a stored seed whose bytes don't hash to its name is left for Git to restore, and its file is neither copied nor receipted", () => {
  const seed = join(dir, "seed");
  const office = join(dir, "office");
  const hash = sha256("first\n");

  write(join(seed, "a.md"), "first\n");
  write(join(office, ".office/seeds", hash), "first\r\n");

  expect(applySeeds(office, "demo", seed, ["a.md"])).toEqual([`FAILED package demo's seed/a.md: .office/seeds/${hash} doesn't hash to its name, so it isn't copied; ${restoreAdvice(hash)}`]);
  expect(readFileSync(join(office, ".office/seeds", hash), "utf8")).toBe("first\r\n");
  expect(existsSync(join(office, "a.md"))).toBe(false);
  expect(readLockSection(office, "seeds")).toEqual(new Map());
});

test("the store's .gitattributes is kept once the store holds a seed: written when missing, rewritten when edited, left when right", () => {
  const store = join(dir, ".office/seeds");

  expect(keepSeedAttributes(dir)).toEqual([]);
  mkdirSync(store, { recursive: true });
  expect(keepSeedAttributes(dir)).toEqual([]);
  expect(stored(dir)).toEqual([]);

  write(join(store, sha256("a\n")), "a\n");
  expect(keepSeedAttributes(dir)).toEqual(["wrote .office/seeds/.gitattributes"]);
  writeFileSync(join(store, ".gitattributes"), "* text\n");
  expect(keepSeedAttributes(dir)).toEqual(["wrote .office/seeds/.gitattributes"]);
  expect(readFileSync(join(store, ".gitattributes"), "utf8")).toBe(attributes);
  expect(keepSeedAttributes(dir)).toEqual([]);
  // Staged outside the committed store, so nothing but the seed and the guard is left in it.
  expect(stored(dir)).toEqual([".gitattributes", sha256("a\n")].sort());

  // A guard that can't be written names its own path.
  rmSync(join(store, ".gitattributes"));
  mkdirSync(join(store, ".gitattributes"));
  expect(keepSeedAttributes(dir)).toEqual([expect.stringMatching(/^FAILED \.office\/seeds\/\.gitattributes, which stops Git converting stored seeds: /)]);
});

test("a seed the store can't hold is reported and neither copied nor receipted, and is copied by a later run once the store can hold it", () => {
  const seed = join(dir, "seed");
  const office = join(dir, "office");

  write(join(seed, "a.md"), "first\n");
  // A file where the store's folder goes, so it can't be made.
  write(join(office, ".office/seeds"), "not a folder\n");

  expect(applySeeds(office, "demo", seed, ["a.md"])).toEqual([expect.stringMatching(new RegExp(`^FAILED package demo's seed/a\\.md: could not store it as \\.office/seeds/${sha256("first\n")}, so it isn't copied: `))]);
  expect(existsSync(join(office, "a.md"))).toBe(false);
  expect(readLockSection(office, "seeds")).toEqual(new Map());

  rmSync(join(office, ".office/seeds"));
  expect(applySeeds(office, "demo", seed, ["a.md"])).toEqual(["created a.md from package demo"]);
});

const [laid, newer, edited] = ["laid down\n", "the package's new seed\n", "the owner's edit\n"].map((text) => Buffer.from(text));
const received: SeedReceipt = { package: "demo", sha256: sha256(laid) };

test.each<[string, SeedReceipt, Buffer | undefined, Buffer | undefined, OfficeFile, SeedClass]>([
  ["seed unchanged, file edited", received, laid, laid, edited, "current"],
  ["seed unchanged, stored seed missing", received, undefined, laid, "missing", "current"],
  ["seed changed, file untouched", received, laid, newer, laid, "replace"],
  ["seed changed, file edited", received, laid, newer, edited, "pending"],
  ["seed changed, file already the new seed", received, laid, newer, newer, "advance"],
  ["seed changed, file deleted", received, laid, newer, "missing", "advance"],
  ["seed changed, a folder or link at the path", received, laid, newer, "other", "pending"],
  ["seed changed, stored seed missing", received, undefined, newer, laid, "blocked"],
  ["seed changed, stored seed corrupt", received, Buffer.from("laid down\r\n"), newer, laid, "blocked"],
  ["seed changed, stored seed missing, file already the new seed", received, undefined, newer, newer, "blocked"],
  ["file that was already there, seed changed", { package: "demo", existing: true }, undefined, newer, edited, "unowned"],
  ["seed dropped", received, laid, undefined, laid, "dropped"],
  ["seed dropped, file that was already there", { package: "demo", existing: true }, undefined, undefined, edited, "dropped"],
])("classifySeed: %s", (_, receipt, stored, seed, file, expected) => {
  expect(classifySeed(receipt, stored, seed, file)).toBe(expected);
});

/** A package seed folder and an office, each file's seed written and applied once. */
function appliedOffice(files: Record<string, string>) {
  const seed = join(dir, "seed");
  const office = join(dir, "office");

  for (const [file, text] of Object.entries(files)) write(join(seed, file), text);
  mkdirSync(office, { recursive: true });
  applySeeds(office, "demo", seed, Object.keys(files));

  return { seed, office, read: (file: string) => readFileSync(join(office, file), "utf8") };
}

test("a changed seed replaces an unchanged file, stored first and with the package's mode; a deleted file or one already equal gets the new receipt; pending and blocked ones are reported and left; a dropped seed's file stays and its receipt goes", () => {
  const { seed, office, read } = appliedOffice({ "untouched.md": "untouched v1\n", "edited.md": "edited v1\n", "deleted.md": "deleted v1\n", "equal.md": "equal v1\n", "blocked.md": "blocked v1\n", "gone.md": "gone v1\n" });
  const before = stored(office);

  write(join(office, "existing.md"), "the office's own\n");
  editLock(office, ({ seeds }) => {
    seeds.set("existing.md", { package: "demo", existing: true });
  });
  write(join(office, "edited.md"), "the owner's edit\n");
  rmSync(join(office, "deleted.md"));
  write(join(office, "equal.md"), "equal v2\n");
  rmSync(join(office, ".office/seeds", sha256("blocked v1\n")));
  rmSync(join(seed, "gone.md"));

  for (const file of ["untouched", "edited", "deleted", "equal", "blocked", "existing"]) write(join(seed, `${file}.md`), `${file} v2\n`);
  chmodSync(join(seed, "untouched.md"), 0o755);

  expect(applySeeds(office, "demo", seed, ["blocked.md", "deleted.md", "edited.md", "equal.md", "existing.md", "untouched.md"])).toEqual([
    `kept blocked.md: package demo changed its seed, but the seed office laid down, .office/seeds/${sha256("blocked v1\n")}, is missing; ${restoreAdvice(sha256("blocked v1\n"))}`,
    "recorded package demo's new seed for deleted.md, which stays deleted",
    "pending edited.md: package demo changed its seed, and the file differs from the seed office laid down; office seeds diff edited.md",
    "recorded package demo's new seed for equal.md, which already has it",
    "updated untouched.md to package demo's new seed, as the file was unchanged",
    "kept gone.md, which package demo no longer seeds, and dropped its receipt",
  ]);

  expect(read("untouched.md")).toBe("untouched v2\n");
  expect(statSync(join(office, "untouched.md")).mode & 0o777).toBe(0o755 & ~process.umask());
  expect(read("edited.md")).toBe("the owner's edit\n");
  expect(existsSync(join(office, "deleted.md"))).toBe(false);
  expect(read("equal.md")).toBe("equal v2\n");
  expect(read("blocked.md")).toBe("blocked v1\n");
  expect(read("gone.md")).toBe("gone v1\n");
  expect(read("existing.md")).toBe("the office's own\n");
  expect(Object.fromEntries(readLockSection(office, "seeds"))).toEqual({
    "blocked.md": { package: "demo", sha256: sha256("blocked v1\n") },
    "deleted.md": { package: "demo", sha256: sha256("deleted v2\n") },
    "edited.md": { package: "demo", sha256: sha256("edited v1\n") },
    "equal.md": { package: "demo", sha256: sha256("equal v2\n") },
    "existing.md": { package: "demo", existing: true },
    "untouched.md": { package: "demo", sha256: sha256("untouched v2\n") },
  });
  // The new seeds recorded are stored; every earlier one but the deleted is still there.
  expect(stored(office)).toEqual([...before.filter((name) => name !== sha256("blocked v1\n")), ...["deleted", "equal", "untouched"].map((file) => sha256(`${file} v2\n`))].sort());
  // Staged outside the owner's folders, so nothing is left beside the replaced file.
  expect(readdirSync(office).sort()).toEqual([".office", "blocked.md", "edited.md", "equal.md", "existing.md", "gone.md", "office.lock", "untouched.md"]);
});

test("the owner's deletion survives a package update: an edited file is byte-identical after two syncs and reported both times", () => {
  const { seed, office, read } = appliedOffice({ "notes/AGENTS.md": "- Keep slices under a day.\n- Run validate.\n" });
  const owned = "- Run validate.\n- Always link the PR.\n";

  write(join(office, "notes/AGENTS.md"), owned);
  write(join(seed, "notes/AGENTS.md"), "- Keep slices under a day, always.\n- Run check.\n- Review lives in review/.\n");

  const pending = ["pending notes/AGENTS.md: package demo changed its seed, and the file differs from the seed office laid down; office seeds diff notes/AGENTS.md"];
  const lock = readFileSync(join(office, "office.lock"), "utf8");

  expect(applySeeds(office, "demo", seed, ["notes/AGENTS.md"])).toEqual(pending);
  expect(applySeeds(office, "demo", seed, ["notes/AGENTS.md"])).toEqual(pending);
  expect(read("notes/AGENTS.md")).toBe(owned);
  expect(readFileSync(join(office, "office.lock"), "utf8")).toBe(lock);
});
