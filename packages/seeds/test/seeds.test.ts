import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Entry, SetupContext } from "@office/sdk";
import { type Seed, seeds } from "../handles.ts";
import definition from "../office.ts";
import { applySeeds, classifySeed, type OfficeFile, type SeedClass, seedProblems } from "../seeds.ts";
import { keepSeedAttributes, type Receipt, readReceipts, receiptsFile, renderReceipts, restoreAdvice, sha256, writeReceipts } from "../store.ts";

let root: string;
let office: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "office-seeds-"));
  office = join(root, "office");
  mkdirSync(office);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/**
 * A package's folder with `files`, reached through a link, as a bound package's folder is; returns
 * the link. Writing to the returned folder changes the package.
 */
function pack(name: string, files: Record<string, string> = {}): string {
  const real = join(root, "real", name);

  mkdirSync(real, { recursive: true });

  for (const [file, text] of Object.entries(files)) write(join(real, file), text);
  const link = join(root, "linked", name);

  mkdirSync(dirname(link), { recursive: true });
  symlinkSync(real, link);

  return link;
}

const entry = (owner: string, folder: string, value: Seed): Entry<Seed> => ({ owner, folder, value });

const receipts = () => Object.fromEntries(readReceipts(office));

const read = (file: string) => readFileSync(join(office, file), "utf8");

/** Every file under the office, with its bytes, not following links: what "nothing is written" compares. */
function files(folder = office, found: Record<string, string> = {}): Record<string, string> {
  for (const item of existsSync(folder) ? readdirSync(folder, { withFileTypes: true }) : []) {
    const path = join(folder, item.name);

    if (item.isDirectory()) files(path, found);
    else if (item.isFile()) found[path.slice(office.length + 1)] = readFileSync(path, "utf8");
  }

  return found;
}

const stored = () => (existsSync(join(office, ".office/seeds")) ? readdirSync(join(office, ".office/seeds")).filter(name => /^[0-9a-f]{64}$/.test(name)).sort() : []);

test("seeds.add declares one seed; the parser refuses both or neither of source and text, an unknown key and a value that isn't text, naming the destination", () => {
  const added: unknown[] = [];
  const ctx: Pick<SetupContext, "add"> = { add: (_registry, value) => void added.push(value) };

  seeds.add(ctx, { destination: "notes/AGENTS.md", source: "guidance/notes.md" });
  seeds.add(ctx, { destination: "previews/.gitignore", text: "*\n" });
  expect(added).toEqual([{ destination: "notes/AGENTS.md", source: "guidance/notes.md" }, { destination: "previews/.gitignore", text: "*\n" }]);
  expect(seeds.id).toBe("seeds.seed");

  expect(seeds.parse({ destination: "a.md", source: "a.md" })).toEqual({ destination: "a.md", source: "a.md" });
  expect(seeds.parse({ destination: "a.md", text: "" })).toEqual({ destination: "a.md", text: "" });
  expect(() => seeds.parse({ destination: "a.md", source: "a.md", text: "x" })).toThrow("seed a.md: give exactly one of source and text");
  expect(() => seeds.parse({ destination: "a.md" })).toThrow("seed a.md: give exactly one of source and text");
  expect(() => seeds.parse({ destination: "a.md", source: "a.md", mode: "x" })).toThrow("seed a.md: unknown key mode");
  expect(() => seeds.parse({ destination: "a.md", text: 3 })).toThrow("seed a.md: text must be text");
  expect(() => seeds.parse({ destination: "a.md", source: "" })).toThrow("seed a.md: source must be a path in the package");
  expect(() => seeds.parse({ source: "a.md" })).toThrow("a seed: destination must be a path relative to the office");

  if (false) {
    // @ts-expect-error both source and text
    seeds.add(ctx, { destination: "a.md", source: "a.md", text: "x" });
    // @ts-expect-error neither
    seeds.add(ctx, { destination: "a.md" });
  }
});

test("the definition registers the registry, commits the store and declares the two commands with their usage", () => {
  expect(definition.committed).toEqual([".office/seeds/"]);
  expect(Object.entries(definition.commands ?? {}).map(([name, { usage }]) => [name, usage])).toEqual([["seeds diff", "[<path>]"], ["seeds settle", "<path>"]]);
  const registered: string[] = [];

  definition.setup?.({ settings: {}, registry: handle => void registered.push(handle.id), add: () => undefined });
  expect(registered).toEqual(["seeds.seed"]);
});

test("a file keeps its bytes and mode, a folder lays down every file under it, hidden ones too, and text is written 0644 whatever the umask, each with its receipt and stored seed", () => {
  const mask = process.umask(0o077);

  try {
    laysDown();
  } finally {
    process.umask(mask);
  }
});

function laysDown(): void {
  const folder = pack("notes", { "guidance/notes.md": "notes\r\nwith CRLF\r\n", "starter/AGENTS.md": "agents\n", "starter/active/.gitkeep": "", "starter/.config/x": "hidden\n" });

  chmodSync(join(folder, "guidance/notes.md"), 0o755);
  chmodSync(join(folder, "starter/AGENTS.md"), 0o640);

  const lines = applySeeds(office, [
    entry("notes", folder, { destination: "notes/AGENTS.md", source: "guidance/notes.md" }),
    entry("notes", folder, { destination: "tracks", source: "starter" }),
    entry("notes", folder, { destination: "previews/.gitignore", text: "*\n" }),
  ]);

  expect(lines).toEqual([
    "created notes/AGENTS.md from package notes",
    "created previews/.gitignore from package notes",
    "created tracks/.config/x from package notes",
    "created tracks/AGENTS.md from package notes",
    "created tracks/active/.gitkeep from package notes",
    "wrote .office/seeds/.gitattributes",
  ]);
  expect(read("notes/AGENTS.md")).toBe("notes\r\nwith CRLF\r\n");
  expect(statSync(join(office, "notes/AGENTS.md")).mode & 0o777).toBe(0o755);
  expect(statSync(join(office, "previews/.gitignore")).mode & 0o777).toBe(0o644);
  expect(statSync(join(office, "tracks/AGENTS.md")).mode & 0o777).toBe(0o640);
  expect(statSync(join(office, receiptsFile)).mode & 0o777).toBe(0o644);
  expect(read("tracks/active/.gitkeep")).toBe("");
  expect(receipts()).toEqual({
    "notes/AGENTS.md": { package: "notes", sha256: sha256("notes\r\nwith CRLF\r\n") },
    "previews/.gitignore": { package: "notes", sha256: sha256("*\n") },
    "tracks/.config/x": { package: "notes", sha256: sha256("hidden\n") },
    "tracks/AGENTS.md": { package: "notes", sha256: sha256("agents\n") },
    "tracks/active/.gitkeep": { package: "notes", sha256: sha256("") },
  });

  // Each stored seed's bytes hash to its name; the empty file's seed is stored once.
  for (const name of stored()) expect(sha256(readFileSync(join(office, ".office/seeds", name)))).toBe(name);
  expect(stored()).toHaveLength(5);

  // A second sync changes nothing and rewrites nothing.
  const before = files();

  expect(applySeeds(office, [entry("notes", folder, { destination: "notes/AGENTS.md", source: "guidance/notes.md" }), entry("notes", folder, { destination: "tracks", source: "starter" }), entry("notes", folder, { destination: "previews/.gitignore", text: "*\n" })])).toEqual([]);
  expect(files()).toEqual(before);
}

test("a destination built from a setting lands where the setting says, and a package's seed/ folder nobody declared lays nothing down", () => {
  const folder = pack("knowledge", { "seed/knowledge/AGENTS.md": "convention\n", "guidance/README.md": "readme\n" });
  const settings = { folder: "library" };

  expect(applySeeds(office, [entry("knowledge", folder, { destination: `${settings.folder}/README.md`, source: "guidance/README.md" })])).toEqual(["created library/README.md from package knowledge", "wrote .office/seeds/.gitattributes"]);
  expect(existsSync(join(office, "knowledge"))).toBe(false);
  expect(applySeeds(office, [])).toEqual(["left in place: library/README.md (package knowledge no longer seeds it)"]);
});

test("a file already there is kept and marked, with no stored seed, its mode untouched under any umask, and the receipts file it starts gets the store's guard", () => {
  const folder = pack("demo", { "kept.md": "the package's\n" });

  write(join(office, "kept.md"), "the office's own\n");
  chmodSync(join(office, "kept.md"), 0o600);
  const mask = process.umask(0o022);

  try {
    expect(applySeeds(office, [entry("demo", folder, { destination: "kept.md", source: "kept.md" })])).toEqual(["kept kept.md, which was already there, instead of package demo's seed", "wrote .office/seeds/.gitattributes"]);
  } finally {
    process.umask(mask);
  }

  expect(statSync(join(office, "kept.md")).mode & 0o777).toBe(0o600);
  expect(readdirSync(join(office, ".office/seeds")).sort()).toEqual([".gitattributes", "receipts.json"]);
  expect(read(".office/seeds/.gitattributes")).toBe("* -text -filter -ident -working-tree-encoding\n");
  expect(read("kept.md")).toBe("the office's own\n");
  expect(receipts()).toEqual({ "kept.md": { package: "demo", existing: true } });
  expect(stored()).toEqual([]);
});

/** Sync with `declarations`, expecting it to throw `error` and leave every seed output, the office's whole tree, byte-identical. */
function refused(declarations: Entry<Seed>[], error: string | RegExp): void {
  const before = files();

  expect(() => applySeeds(office, declarations)).toThrow(error);
  expect(files()).toEqual(before);
}

test("every declaration is checked before any write: a missing source, a source outside the package or through a link below its folder, a destination in .office/ or outside the office or through a link; the package's own folder may be a link", () => {
  const one = pack("one", { "a.md": "a\n", "c.md": "c\n", "starter/ok.md": "ok\n" });
  const other = pack("other", { "x.md": "x\n" });
  const valid = entry("other", other, { destination: "x.md", source: "x.md" });

  write(join(root, "outside.md"), "outside\n");
  symlinkSync(join(root, "outside.md"), join(one, "starter/escape.md"));
  symlinkSync(join(root), join(one, "away"));
  symlinkSync(join(root), join(office, "linked"));
  write(join(office, "notafolder"), "a file\n");

  // An earlier receipt is kept byte for byte through every refusal.
  writeReceipts(office, new Map([["earlier.md", { package: "other", existing: true }]]));

  refused([
    entry("one", one, { destination: "a.md", source: "a.md" }),
    entry("one", one, { destination: "b.md", source: "missing.md" }),
    entry("one", one, { destination: "c.md", source: "c.md" }),
    valid,
  ], "no seed was written: package one's seed b.md: source missing.md does not exist in the package");
  refused([entry("one", one, { destination: "x.md", source: "../other/file.md" }), valid], "package one's seed x.md: source ../other/file.md is not a path inside the package");
  refused([entry("one", one, { destination: "x", source: "starter" }), valid], "package one's seed x: source starter: escape.md is a link, which seeds don't follow");
  refused([entry("one", one, { destination: "x.md", source: "away/outside.md" }), valid], "package one's seed x.md: source away/outside.md: away is a link, which seeds don't follow");
  refused([entry("one", one, { destination: ".office/seeds/x", text: "" }), valid], "package one's seed .office/seeds/x: .office/seeds/x: in .office/, which office manages");
  refused([entry("one", one, { destination: ".OFFICE/x", text: "" }), valid], "in .office/, which office manages");
  refused([entry("one", one, { destination: "../x.md", text: "" }), valid], "package one's seed ../x.md: ../x.md: not a plain path relative to the office");
  refused([entry("one", one, { destination: "/etc/x", text: "" }), valid], "not a plain path relative to the office");
  refused([entry("one", one, { destination: "linked/x.md", text: "" }), valid], "linked/x.md: linked is a link, which office doesn't follow");
  refused([entry("one", one, { destination: "notafolder/x.md", text: "" }), valid], "notafolder is not a folder");

  // Every problem is named at once.
  refused([entry("one", one, { destination: "b.md", source: "missing.md" }), entry("other", other, { destination: "y.md", source: "nope.md" })], "package one's seed b.md: source missing.md does not exist in the package; package other's seed y.md: source nope.md does not exist in the package");

  // The package's own folder is a link, and seeds from it are laid down.
  expect(lstatSync(one).isSymbolicLink()).toBe(true);
  expect(applySeeds(office, [entry("one", one, { destination: "ok/ok.md", source: "starter/ok.md" })])).toContain("created ok/ok.md from package one");
});

test("two declarations of one file, from two packages or one, a folder covering a file, and a file where another needs a folder each fail naming the paths and packages, writing nothing", () => {
  const a = pack("a", { "f.md": "a\n", "tracks/AGENTS.md": "folder's\n" });
  const b = pack("b", { "f.md": "b\n" });

  refused([entry("a", a, { destination: "initiatives/AGENTS.md", source: "f.md" }), entry("b", b, { destination: "initiatives/AGENTS.md", source: "f.md" })], "initiatives/AGENTS.md is seeded by both package a and package b");
  refused([entry("a", a, { destination: "x.md", source: "f.md" }), entry("a", a, { destination: "x.md", text: "" })], "x.md is seeded by package a twice");
  refused([entry("a", a, { destination: "tracks", source: "tracks" }), entry("b", b, { destination: "tracks/AGENTS.md", source: "f.md" })], "tracks/AGENTS.md is seeded by both package a and package b");
  refused([entry("a", a, { destination: "notes", source: "f.md" }), entry("b", b, { destination: "notes/AGENTS.md", source: "f.md" })], "notes is a file seeded by package a, but package b seeds notes/AGENTS.md under it");

  // A folder holding no file still claims its path and the folders below it, though none is made for it alone.
  mkdirSync(join(b, "empty/nested/deeper"), { recursive: true });
  refused([entry("a", a, { destination: "kept/x.md", source: "f.md" }), entry("b", b, { destination: "kept/x.md/y", source: "empty" })], "kept/x.md is a file seeded by package a, but package b seeds the folder kept/x.md/y under it");
  refused([entry("a", a, { destination: "kept/x.md", source: "f.md" }), entry("b", b, { destination: "kept/x.md", source: "empty" })], "kept/x.md is a file seeded by package a, but package b seeds the folder kept/x.md there");
  refused([entry("a", a, { destination: "kept/nested/deeper", text: "" }), entry("b", b, { destination: "kept", source: "empty" })], "kept/nested/deeper is a file seeded by package a, but package b seeds the folder kept/nested/deeper there");
  expect(applySeeds(office, [entry("a", a, { destination: "kept/x.md", source: "f.md" }), entry("b", b, { destination: "elsewhere", source: "empty" })])).toContain("created kept/x.md from package a");
  expect(existsSync(join(office, "elsewhere"))).toBe(false);
});

test("a declaration is checked whatever its files: an empty folder's destination in .office/, a NUL in a destination, an unreadable source folder, each refused with its package before any write; a clash is named even where the office has a file on the way", () => {
  const one = pack("one", { "a.md": "a\n", "locked/x.md": "x\n" });
  const two = pack("two", { "a.md": "a\n" });
  const valid = entry("two", two, { destination: "first.md", source: "a.md" });

  mkdirSync(join(one, "empty"));
  write(join(office, "occupied"), "the owner's file\n");

  // Sorted first, so a sync that went ahead would write it before reaching the bad one.
  refused([valid, entry("one", one, { destination: ".office/x", source: "empty" })], "no seed was written: package one's seed .office/x: .office/x: in .office/, which office manages");
  refused([valid, entry("one", one, { destination: "z\0.md", text: "" })], "package one's seed z\0.md: z\0.md: not a plain path relative to the office");
  refused([valid, entry("one", one, { destination: "a\0", source: "empty" })], "not a plain path relative to the office");
  refused([valid, entry("one", one, { destination: "x.md", source: "a\0.md" })], "package one's seed x.md: source a\0.md is not a path inside the package");

  chmodSync(join(one, "locked"), 0o000);

  try {
    refused([valid, entry("one", one, { destination: "locked", source: "locked" })], /package one's seed locked: source locked can't be read: .*EACCES/);
  } finally {
    chmodSync(join(one, "locked"), 0o755);
  }

  refused([entry("one", one, { destination: "occupied/a.md", source: "a.md" }), entry("two", two, { destination: "occupied/a.md", source: "a.md" })], "occupied/a.md is seeded by both package one and package two");
  expect(() => applySeeds(office, [entry("one", one, { destination: "occupied/a.md", source: "a.md" })])).toThrow("package one's seed occupied/a.md: occupied/a.md: occupied is not a folder, which office doesn't follow");
});

test("a dropped receipt is retired whatever is at its path now, even under what is now the owner's file, which is neither read nor changed", () => {
  const folder = pack("notes", { "a.md": "a\n" });

  applySeeds(office, [entry("notes", folder, { destination: "notes/a", source: "a.md" })]);
  rmSync(join(office, "notes"), { recursive: true });
  write(join(office, "notes"), "now the owner's file\n");
  chmodSync(join(office, "notes"), 0o600);

  expect(applySeeds(office, [])).toEqual(["left in place: notes/a (package notes no longer seeds it)"]);
  expect(read("notes")).toBe("now the owner's file\n");
  expect(statSync(join(office, "notes")).mode & 0o777).toBe(0o600);
  expect(receipts()).toEqual({});
});

test("a first receipts file of files that were already there is guarded before it is written, so Git keeps its bytes under any line-ending setting", () => {
  const folder = pack("demo", { "kept.md": "the package's\n" });
  const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "core.autocrlf=true", ...args], { cwd, encoding: "utf8" });

  write(join(office, "kept.md"), "the office's own\n");
  applySeeds(office, [entry("demo", folder, { destination: "kept.md", source: "kept.md" })]);
  expect(stored()).toEqual([]);
  const bytes = readFileSync(join(office, receiptsFile));

  git(office, "init", "-q");
  git(office, "add", "-A");
  git(office, "commit", "-qm", "office");
  expect(git(office, "check-attr", "text", "--", receiptsFile).stdout).toBe(`${receiptsFile}: text: unset\n`);
  git(root, "clone", "-q", office, "clone");
  expect(readFileSync(join(root, "clone", receiptsFile))).toEqual(bytes);
});

test("a folder or link where a stored seed belongs is unusable: sync keeps the file and its receipt, never replaces the entry, and check warns naming it with its repair", () => {
  const folder = pack("demo", { "a.md": "a v1\n", "b.md": "b v1\n" });
  const declared = ["a.md", "b.md"].map(file => entry("demo", folder, { destination: file, source: file }));

  applySeeds(office, declared);
  const [a, b] = ["a v1\n", "b v1\n"].map(text => join(office, ".office/seeds", sha256(text)));

  rmSync(a);
  mkdirSync(a);
  rmSync(b);
  symlinkSync(join(root, "elsewhere"), b);

  for (const file of ["a.md", "b.md"]) write(join(folder, file), `${file} v2\n`);
  const fault = (text: string) => `.office/seeds/${sha256(text)}, is not a file; remove it, then ${restoreAdvice(sha256(text))}`;
  const before = files();

  expect(applySeeds(office, declared)).toEqual([`kept a.md: package demo changed its seed, but the seed office laid down, ${fault("a v1\n")}`, `kept b.md: package demo changed its seed, but the seed office laid down, ${fault("b v1\n")}`]);
  expect(files()).toEqual(before);
  expect(readdirSync(a)).toEqual([]);
  expect(readlinkSync(b)).toBe(join(root, "elsewhere"));
  expect(seedProblems(office, declared)).toEqual([
    { level: "warning", message: `a.md: its seed .office/seeds/${sha256("a v1\n")} is not a file; remove it, then ${restoreAdvice(sha256("a v1\n"))}` },
    { level: "warning", message: `b.md: its seed .office/seeds/${sha256("b v1\n")} is not a file; remove it, then ${restoreAdvice(sha256("b v1\n"))}` },
  ]);

  // A folder at the place a new seed would be stored: its file is neither created nor receipted, and the folder stays.
  const c = join(office, ".office/seeds", sha256("c\n"));

  write(join(folder, "c.md"), "c\n");
  mkdirSync(c);
  expect(() => applySeeds(office, [...declared, entry("demo", folder, { destination: "c.md", source: "c.md" })])).toThrow(`package demo's seed c.md: .office/seeds/${sha256("c\n")} is not a file, so it isn't copied; remove it, then ${restoreAdvice(sha256("c\n"))}`);
  expect(existsSync(join(office, "c.md"))).toBe(false);
  expect(readdirSync(c)).toEqual([]);
  expect(receipts()["c.md"]).toBeUndefined();
});

test("a receipts file that is a link, dangling or not, is refused by sync and check, and never replaced", () => {
  const folder = pack("demo", { "a.md": "a\n" });
  const declared = [entry("demo", folder, { destination: "a.md", source: "a.md" })];

  mkdirSync(join(office, ".office/seeds"), { recursive: true });
  symlinkSync(join(root, "nowhere.json"), join(office, receiptsFile));
  expect(() => applySeeds(office, declared)).toThrow(`${receiptsFile} is not a file (a link); restore it from Git`);
  expect(seedProblems(office, declared)).toEqual([{ level: "failed", message: `${receiptsFile} is not a file (a link); restore it from Git` }]);
  expect(readlinkSync(join(office, receiptsFile))).toBe(join(root, "nowhere.json"));
  expect(existsSync(join(office, "a.md"))).toBe(false);
});

test("when the receipts can't be saved either, the error keeps the seed's failure and the receipts' own, and doesn't say they were saved", () => {
  const folder = pack("demo", { "a.md": "first\n", "b.md": "second\n" });
  const store = join(office, ".office/seeds");

  // a.md's seed is stored already, so only b.md's needs the store written, which it can't be.
  write(join(store, sha256("first\n")), "first\n");
  write(join(store, ".gitattributes"), "* -text -filter -ident -working-tree-encoding\n");
  chmodSync(store, 0o555);

  try {
    expect(() => applySeeds(office, [entry("demo", folder, { destination: "a.md", source: "a.md" }), entry("demo", folder, { destination: "b.md", source: "b.md" })])).toThrow(/^package demo's seed b\.md: could not store it as \.office\/seeds\/[0-9a-f]{64}, so it isn't copied: .*EACCES[^;]*; could not save \.office\/seeds\/receipts\.json: .*EACCES[^;]*$/);
  } finally {
    chmodSync(store, 0o755);
  }

  expect(read("a.md")).toBe("first\n");
  expect(existsSync(join(office, receiptsFile))).toBe(false);
});

test("a path changes hands: the earlier package's receipt goes, and the new one marks the file as already there, or creates it when it was deleted", () => {
  const a = pack("a", { "notes.md": "a's notes\n" });
  const b = pack("b", { "notes.md": "b's notes\n" });

  applySeeds(office, [entry("a", a, { destination: "notes/AGENTS.md", source: "notes.md" })]);

  expect(applySeeds(office, [entry("b", b, { destination: "notes/AGENTS.md", source: "notes.md" })])).toEqual([
    "left in place: notes/AGENTS.md (package a no longer seeds it)",
    "kept notes/AGENTS.md, which was already there, instead of package b's seed",
  ]);
  expect(read("notes/AGENTS.md")).toBe("a's notes\n");
  expect(receipts()).toEqual({ "notes/AGENTS.md": { package: "b", existing: true } });

  // With no file: handed back to a after the owner deleted it.
  rmSync(join(office, "notes/AGENTS.md"));
  expect(applySeeds(office, [entry("a", a, { destination: "notes/AGENTS.md", source: "notes.md" })])).toEqual([
    "left in place: notes/AGENTS.md (package b no longer seeds it)",
    "created notes/AGENTS.md from package a",
  ]);
  expect(read("notes/AGENTS.md")).toBe("a's notes\n");
  expect(receipts()).toEqual({ "notes/AGENTS.md": { package: "a", sha256: sha256("a's notes\n") } });
});

test("a dropped seed's file stays, edited or not, its receipt goes and its stored seed stays; declared again, a file still there is marked as already there and a deleted one is created", () => {
  const folder = pack("tracks", { "a.md": "a\n", "b.md": "b\n", "c.md": "c\n" });
  const all = ["a.md", "b.md", "c.md"].map(file => entry("tracks", folder, { destination: `tracks/${file}`, source: file }));

  applySeeds(office, all);
  const seedsBefore = stored();

  write(join(office, "tracks/b.md"), "edited\n");
  rmSync(join(office, "tracks/c.md"));
  expect(applySeeds(office, [])).toEqual([
    "left in place: tracks/a.md (package tracks no longer seeds it)",
    "left in place: tracks/b.md (package tracks no longer seeds it)",
    "left in place: tracks/c.md (package tracks no longer seeds it)",
  ]);
  expect([read("tracks/a.md"), read("tracks/b.md")]).toEqual(["a\n", "edited\n"]);
  expect(receipts()).toEqual({});
  expect(stored()).toEqual(seedsBefore);

  expect(applySeeds(office, all)).toEqual([
    "kept tracks/a.md, which was already there, instead of package tracks's seed",
    "kept tracks/b.md, which was already there, instead of package tracks's seed",
    "created tracks/c.md from package tracks",
  ]);
  expect(receipts()).toEqual({ "tracks/a.md": { package: "tracks", existing: true }, "tracks/b.md": { package: "tracks", existing: true }, "tracks/c.md": { package: "tracks", sha256: sha256("c\n") } });
});

test("a write that fails after every check passed keeps the receipts of the files written before it, names the path, and the next sync doesn't mark the first file as already there", () => {
  const folder = pack("demo", { "a.md": "first\n", "b.md": "second\n" });
  const both = [entry("demo", folder, { destination: "a/a.md", source: "a.md" }), entry("demo", folder, { destination: "b/b.md", source: "b.md" })];

  // The folder for b/ can be checked but not written in.
  mkdirSync(join(office, "b"));
  chmodSync(join(office, "b"), 0o555);

  try {
    expect(() => applySeeds(office, both)).toThrow(/^package demo's seed b\/b\.md: .*EACCES.*; the receipts of the files written before it are saved$/);
  } finally {
    chmodSync(join(office, "b"), 0o755);
  }

  expect(receipts()).toEqual({ "a/a.md": { package: "demo", sha256: sha256("first\n") } });
  expect(applySeeds(office, both)).toEqual(["created b/b.md from package demo"]);
  expect(receipts()).toEqual({ "a/a.md": { package: "demo", sha256: sha256("first\n") }, "b/b.md": { package: "demo", sha256: sha256("second\n") } });
});

test("a seed the store can't hold fails naming the path, writing neither the file nor a receipt, and is laid down by a later run once the store can hold it", () => {
  const folder = pack("demo", { "a.md": "first\n" });
  const one = [entry("demo", folder, { destination: "a.md", source: "a.md" })];

  // A file where the store's folder goes, so it can't be made.
  write(join(office, ".office/seeds"), "not a folder\n");

  expect(() => applySeeds(office, one)).toThrow(`package demo's seed a.md: could not store it as .office/seeds/${sha256("first\n")}, so it isn't copied: `);
  expect(existsSync(join(office, "a.md"))).toBe(false);

  rmSync(join(office, ".office/seeds"));
  expect(applySeeds(office, one)).toEqual(["created a.md from package demo", "wrote .office/seeds/.gitattributes"]);
});

test("a stored seed whose bytes don't hash to its name is left for Git to restore, and its file is neither copied nor receipted", () => {
  const folder = pack("demo", { "a.md": "first\n" });
  const hash = sha256("first\n");

  write(join(office, ".office/seeds", hash), "first\r\n");

  expect(() => applySeeds(office, [entry("demo", folder, { destination: "a.md", source: "a.md" })])).toThrow(`.office/seeds/${hash} doesn't hash to its name, so it isn't copied; ${restoreAdvice(hash)}`);
  expect(readFileSync(join(office, ".office/seeds", hash), "utf8")).toBe("first\r\n");
  expect(existsSync(join(office, "a.md"))).toBe(false);
  expect(existsSync(join(office, receiptsFile))).toBe(false);
});

test("the receipts file: paths sorted, one receipt per line, unusual paths kept as themselves, and a change touches one line", () => {
  const hash = sha256("x\n");
  const map = new Map<string, Receipt>([["tracks/tracks.yaml", { package: "tracks", existing: true }], ["__proto__", { package: "odd", sha256: hash }], ["constructor", { package: "knowledge", existing: true }], ["a b/it's.md", { package: "demo", sha256: hash }]]);

  writeReceipts(office, map);
  const text = readFileSync(join(office, receiptsFile), "utf8");

  expect(text).toBe([
    "{",
    '  "receipts": {',
    `    "__proto__": { "package": "odd", "sha256": "${hash}" },`,
    `    "a b/it's.md": { "package": "demo", "sha256": "${hash}" },`,
    '    "constructor": { "package": "knowledge", "existing": true },',
    '    "tracks/tracks.yaml": { "package": "tracks", "existing": true }',
    "  }",
    "}",
    "",
  ].join("\n"));
  expect(readReceipts(office)).toEqual(map);
  expect([...readReceipts(office).keys()].sort()).toEqual(["__proto__", "a b/it's.md", "constructor", "tracks/tracks.yaml"]);

  // Changing one receipt changes that line alone.
  map.set("constructor", { package: "knowledge", sha256: hash });
  const changed = renderReceipts(map).split("\n");

  expect(changed.filter((line, index) => line !== text.split("\n")[index])).toEqual([`    "constructor": { "package": "knowledge", "sha256": "${hash}" },`]);
  expect(renderReceipts(new Map())).toBe('{\n  "receipts": {}\n}\n');
});

test("an invalid receipts file, or one of the wrong shape, fails sync and check naming it, and nothing is written", () => {
  const folder = pack("demo", { "a.md": "a\n" });
  const declared = [entry("demo", folder, { destination: "a.md", source: "a.md" })];

  const cases: [string, RegExp][] = [
    ["not json", /^\.office\/seeds\/receipts\.json is not valid JSON: /],
    ['{ "receipts": [] }', /^\.office\/seeds\/receipts\.json is not valid: it must be/],
    ['{ "receipts": {}, "extra": 1 }', /^\.office\/seeds\/receipts\.json is not valid: it must be/],
    ['{ "receipts": { "a.md": { "package": "demo", "existing": false } } }', /^\.office\/seeds\/receipts\.json is not valid: a\.md: must be/],
    ['{ "receipts": { "a.md": { "package": "demo", "sha256": "abc" } } }', /^\.office\/seeds\/receipts\.json is not valid: a\.md: must be/],
    ['{ "receipts": { "../a.md": { "package": "demo", "existing": true } } }', /^\.office\/seeds\/receipts\.json is not valid: \.\.\/a\.md: must be a path relative to the office/],
  ];

  for (const [text, error] of cases) {
    write(join(office, receiptsFile), text);
    refused(declared, error);
    expect(seedProblems(office, declared)).toEqual([{ level: "failed", message: expect.stringMatching(error) }]);
  }
});

test("the store's .gitattributes is kept once the store holds anything: written when missing, rewritten when edited, left when right, and a guard that can't be written fails naming it", () => {
  const store = join(office, ".office/seeds");
  const attributes = "* -text -filter -ident -working-tree-encoding\n";

  expect(keepSeedAttributes(office)).toEqual([]);
  mkdirSync(store, { recursive: true });
  expect(keepSeedAttributes(office)).toEqual([]);

  write(join(store, sha256("a\n")), "a\n");
  expect(keepSeedAttributes(office)).toEqual(["wrote .office/seeds/.gitattributes"]);
  writeFileSync(join(store, ".gitattributes"), "* text\n");
  expect(keepSeedAttributes(office)).toEqual(["wrote .office/seeds/.gitattributes"]);
  expect(readFileSync(join(store, ".gitattributes"), "utf8")).toBe(attributes);
  expect(keepSeedAttributes(office)).toEqual([]);
  // Staged outside the committed store, so nothing but the seed and the guard is left in it.
  expect(readdirSync(store).sort()).toEqual([".gitattributes", sha256("a\n")].sort());

  rmSync(join(store, ".gitattributes"));
  mkdirSync(join(store, ".gitattributes"));
  expect(() => keepSeedAttributes(office)).toThrow(/^could not write \.office\/seeds\/\.gitattributes, which stops Git converting stored seeds: /);
});

const [laid, newer, edited] = ["laid down\n", "the package's new seed\n", "the owner's edit\n"].map(text => Buffer.from(text));
const received: Receipt = { package: "demo", sha256: sha256(laid) };

test.each<[string, Receipt, Buffer | undefined, Buffer | undefined, OfficeFile, SeedClass]>([
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
])("classifySeed: %s", (_, receipt, storedSeed, seed, file, expected) => {
  expect(classifySeed(receipt, storedSeed, seed, file)).toBe(expected);
});

test("a changed seed replaces an unchanged file, stored first and with the package's mode; a deleted file or one already equal gets the new receipt; pending and blocked ones are reported and left; a file that was already there is never changed", () => {
  const names = ["untouched", "edited", "deleted", "equal", "blocked", "existing"];
  const folder = pack("demo", Object.fromEntries(names.map(name => [`${name}.md`, `${name} v1\n`])));
  const all = names.map(name => entry("demo", folder, { destination: `${name}.md`, source: `${name}.md` }));

  write(join(office, "existing.md"), "the office's own\n");
  applySeeds(office, all);
  const before = stored();

  write(join(office, "edited.md"), "the owner's edit\n");
  rmSync(join(office, "deleted.md"));
  write(join(office, "equal.md"), "equal v2\n");
  rmSync(join(office, ".office/seeds", sha256("blocked v1\n")));

  for (const name of names) write(join(folder, `${name}.md`), `${name} v2\n`);
  chmodSync(join(folder, "untouched.md"), 0o755);

  expect(applySeeds(office, all)).toEqual([
    `kept blocked.md: package demo changed its seed, but the seed office laid down, .office/seeds/${sha256("blocked v1\n")}, is missing; ${restoreAdvice(sha256("blocked v1\n"))}`,
    "recorded package demo's new seed for deleted.md, which stays deleted",
    "pending edited.md: package demo changed its seed, and the file differs from the seed office laid down; office seeds diff edited.md",
    "recorded package demo's new seed for equal.md, which already has it",
    "updated untouched.md to package demo's new seed, as the file was unchanged",
  ]);

  expect(read("untouched.md")).toBe("untouched v2\n");
  expect(statSync(join(office, "untouched.md")).mode & 0o777).toBe(0o755);
  expect(read("edited.md")).toBe("the owner's edit\n");
  expect(existsSync(join(office, "deleted.md"))).toBe(false);
  expect(read("equal.md")).toBe("equal v2\n");
  expect(read("blocked.md")).toBe("blocked v1\n");
  expect(read("existing.md")).toBe("the office's own\n");
  expect(receipts()).toEqual({
    "blocked.md": { package: "demo", sha256: sha256("blocked v1\n") },
    "deleted.md": { package: "demo", sha256: sha256("deleted v2\n") },
    "edited.md": { package: "demo", sha256: sha256("edited v1\n") },
    "equal.md": { package: "demo", sha256: sha256("equal v2\n") },
    "existing.md": { package: "demo", existing: true },
    "untouched.md": { package: "demo", sha256: sha256("untouched v2\n") },
  });
  // The new seeds recorded are stored; every earlier one but the deleted is still there.
  expect(stored()).toEqual([...before.filter(name => name !== sha256("blocked v1\n")), ...["deleted", "equal", "untouched"].map(name => sha256(`${name} v2\n`))].sort());
  // Staged outside the owner's folders, so nothing is left beside the replaced file.
  expect(readdirSync(office).sort()).toEqual([".office", "blocked.md", "edited.md", "equal.md", "existing.md", "untouched.md"]);
});

test("a pending path is reported on every sync until settled, and the owner's file and the receipts stay byte-identical", () => {
  const folder = pack("demo", { "notes.md": "- Keep slices under a day.\n- Run validate.\n" });
  const declared = [entry("demo", folder, { destination: "notes/AGENTS.md", source: "notes.md" })];
  const owned = "- Run validate.\n- Always link the PR.\n";

  applySeeds(office, declared);
  write(join(office, "notes/AGENTS.md"), owned);
  write(join(folder, "notes.md"), "- Keep slices under a day, always.\n- Run check.\n");

  const pending = ["pending notes/AGENTS.md: package demo changed its seed, and the file differs from the seed office laid down; office seeds diff notes/AGENTS.md"];
  const before = files();

  expect(applySeeds(office, declared)).toEqual(pending);
  expect(applySeeds(office, declared)).toEqual(pending);
  expect(files()).toEqual(before);
  expect(read("notes/AGENTS.md")).toBe(owned);
});

test("check reads only: a warning per missing or corrupt stored seed, per receipt sync will drop, one with the pending count, a failure for declarations sync would stop on; none when all is well", () => {
  const folder = pack("demo", { "a.md": "a v1\n", "b.md": "b v1\n", "c.md": "c v1\n" });
  const declared = ["a.md", "b.md", "c.md"].map(file => entry("demo", folder, { destination: file, source: file }));

  applySeeds(office, declared);
  expect(seedProblems(office, declared)).toEqual([]);

  for (const file of ["a.md", "b.md"]) {
    write(join(office, file), "owner's\n");
    write(join(folder, file), `${file} v2\n`);
  }

  rmSync(join(office, ".office/seeds", sha256("c v1\n")));
  const before = files();

  expect(seedProblems(office, declared.slice(0, 2))).toEqual([
    { level: "warning", message: `c.md: its seed .office/seeds/${sha256("c v1\n")} is missing; ${restoreAdvice(sha256("c v1\n"))}` },
    { level: "warning", message: "c.md: package demo no longer seeds it; office sync drops its receipt and leaves the file" },
    { level: "warning", message: "2 seeds pending; office seeds diff" },
  ]);
  expect(seedProblems(office, [...declared, entry("demo", folder, { destination: "d.md", source: "missing.md" })])).toContainEqual({ level: "failed", message: "office sync stops on the seed declarations: no seed was written: package demo's seed d.md: source missing.md does not exist in the package" });
  expect(files()).toEqual(before);
});
