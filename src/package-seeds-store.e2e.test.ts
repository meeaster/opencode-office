// The seeds package's store in the compiled office: what the official packages lay down, a clone's
// first sync, a check that writes nothing, and an office.lock that still holds the old seeds:
// section.
import { expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { sha256 } from "../packages/seeds/store.ts";
import { git } from "./git.ts";
import { definitionFixture } from "./package-definition.fixture.ts";
import { definitionText, writePackage } from "./test-package.ts";
import { toolPath } from "./tool.ts";

const { exe, write, read, fixture } = definitionFixture({ second: false });

const receipts = (dir: string) => JSON.parse(read(join(dir, ".office/seeds/receipts.json"))).receipts;

/** Every file under `folder`, relative to it, with its bytes. */
function tree(folder: string): Record<string, string> {
  return Object.fromEntries(readdirSync(folder, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => [relative(folder, join(entry.parentPath, entry.name)), readFileSync(join(entry.parentPath, entry.name), "latin1")]));
}

test("the official packages lay down their declared seeds with full receipts, office.lock holds none, an undeclared seed/ file stays put, and the seeds commands are listed and run", () => {
  const { dir, cli, select } = fixture("official");
  const shipped = toolPath("packages");
  const expected: Record<string, { package: string; sha256: string }> = {};
  const files: Record<string, string> = {};

  writePackage(join(dir, "packages/plain/office.ts"), definitionText("{}"));
  write(join(dir, "packages/plain/seed/plain.md"), "never laid down\n");
  // Knowledge is already selected in a new office.
  select("  - name: design\n  - name: artifact-share\n    settings: {url: https://example.org}\n  - name: plain\n");
  cli(0, "sync", "--packages");

  for (const name of ["design", "knowledge", "artifact-share"]) {
    for (const [path, bytes] of Object.entries(tree(join(shipped, name, "seed")))) {
      expected[path] = { package: name, sha256: sha256(Buffer.from(bytes, "latin1")) };
      files[path] = bytes;
    }
  }

  expect(Object.keys(expected)).toHaveLength(7);
  expect(receipts(dir)).toEqual(expected);

  for (const [path, bytes] of Object.entries(files)) expect(readFileSync(join(dir, path), "latin1")).toBe(bytes);
  expect(read(join(dir, "office.lock"))).not.toContain("seeds:");
  expect(existsSync(join(dir, "plain.md"))).toBe(false);

  const help = cli(0, "--help");

  expect(help).toContain("seeds diff [<path>]");
  expect(help).toContain("seeds settle <path>");
  expect(cli(0, "seeds", "diff")).toContain("No seeds are pending.");
  expect(cli(0, "seeds", "settle", "knowledge/README.md")).toContain("knowledge/README.md is current");
  expect(cli(1, "seeds", "settle")).toContain("usage: office seeds settle <path>");
}, 60_000);

test("a clone's first sync keeps the committed receipts and store, an edited file and a deleted one; check writes nothing with pending and missing stored seeds", () => {
  const { dir, cli, run, select } = fixture("cloned");
  const clone = join(dirname(dir), "cloned-clone");
  const pkg = join(dir, "packages/notes");
  const store = join(dir, ".office/seeds");

  writePackage(join(pkg, "office.ts"), definitionText('{setup(c){seeds.add(c,{destination:"notes",source:"starter"})}}', 'import {seeds} from "@office/seeds";'), { dependencies: ["seeds"] });
  write(join(pkg, "starter/edited.md"), "laid down\n");
  write(join(pkg, "starter/deleted.md"), "laid down, then deleted\n");
  write(join(pkg, "starter/kept.md"), "laid down too\n");
  select("  - name: notes\n");
  git(["init", "-q", dir]);
  cli(0, "sync");
  write(join(dir, "notes/edited.md"), "the owner's edit\n");
  rmSync(join(dir, "notes/deleted.md"));

  // Of .office/, Git offers the store alone.
  expect(git(["status", "--porcelain", "--untracked-files=all"], dir).split("\n").filter(line => line.includes(".office/")).every(line => line.startsWith("?? .office/seeds/"))).toBe(true);
  git(["add", "-A"], dir);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "office"], dir);
  git(["clone", "-q", dir, clone]);
  expect(existsSync(join(clone, ".office/current"))).toBe(false);
  const committed = tree(join(clone, ".office/seeds"));

  run(exe, 0, "--office", clone, "sync");
  expect(tree(join(clone, ".office/seeds"))).toEqual(committed);
  expect(receipts(clone)).toEqual(receipts(dir));

  for (const [name, bytes] of Object.entries(committed)) if (/^[0-9a-f]{64}$/.test(name)) expect(sha256(Buffer.from(bytes, "latin1"))).toBe(name);
  expect(read(join(clone, "notes/edited.md"))).toBe("the owner's edit\n");
  expect(existsSync(join(clone, "notes/deleted.md"))).toBe(false);

  // Check, with two pending paths and a missing stored seed, warns and writes nothing.
  write(join(pkg, "starter/edited.md"), "changed by the package\n");
  write(join(pkg, "starter/kept.md"), "changed by the package\n");
  write(join(dir, "notes/kept.md"), "the owner's too\n");
  write(join(pkg, "starter/extra.md"), "new\n");
  const missing = receipts(dir)["notes/deleted.md"].sha256;

  rmSync(join(store, missing));
  const before = { store: tree(store), notes: tree(join(dir, "notes")), lock: read(join(dir, "office.lock")) };
  const checked = cli(0, "check");

  expect(checked).toMatch(/^WARN package seeds: 2 seeds pending; office seeds diff$/m);
  expect(checked).toMatch(new RegExp(`^WARN package seeds: notes/deleted\\.md: its seed \\.office/seeds/${missing} is missing; restore it from Git`, "m"));
  expect({ store: tree(store), notes: tree(join(dir, "notes")), lock: read(join(dir, "office.lock")) }).toEqual(before);
}, 60_000);

test("an office.lock that still has a seeds: section stops sync before anything is written or repaired, and office pin, naming the key", () => {
  const { dir, cli } = fixture("old-lock");
  const lock = join(dir, "office.lock");
  const yaml = join(dir, "office.yaml");
  const current = readlinkSync(join(dir, ".office/current"));

  // Runtime pins and no packages: section, as init leaves it; then the old seeds: section, as before
  // the receipts moved: no receipts file, and knowledge's seeds not yet laid down.
  expect(read(lock)).not.toContain("packages:");
  rmSync(join(dir, ".office/seeds"), { recursive: true });
  rmSync(join(dir, "knowledge"), { recursive: true });
  write(lock, `${read(lock)}\nseeds:\n  knowledge/AGENTS.md: { package: knowledge, sha256: ${"0".repeat(64)} }\n`);
  const text = read(lock);
  const bridge = join(dir, ".office/packages");

  // A missing discovery link, which any other command repairs first.
  expect(lstatSync(bridge).isSymbolicLink()).toBe(true);
  rmSync(bridge);

  for (const args of [["sync"], ["sync", "--packages"], ["pin"]]) {
    expect(cli(1, ...args)).toContain("office.lock has a top-level key office doesn't know: seeds");
    expect(read(lock)).toBe(text);
    expect(readlinkSync(join(dir, ".office/current"))).toBe(current);
    expect(existsSync(join(dir, ".office/seeds/receipts.json"))).toBe(false);
    expect(existsSync(join(dir, "knowledge"))).toBe(false);

    if (args[0] === "sync") expect(lstatSync(bridge, { throwIfNoEntry: false })).toBeUndefined();
  }
}, 60_000);
