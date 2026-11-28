// The seeds package in the compiled office: packages declare seeds through `@office/seeds`, its
// `sync` lays them down after the switch, and its commands are package commands. What happens to
// receipts when a package goes, comes back or can't be read, and when declarations are refused.
import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { sha256 } from "../../packages/seeds/store.ts";
import { git } from "../../src/git.ts";
import { definitionFixture } from "../support/package-definition.fixture.ts";
import { definitionText, writePackage } from "../support/test-package.ts";
import { toolPath } from "../../src/tool.ts";

const { root, write, read, commit, fixture } = definitionFixture({ second: false });

/** A definition whose setup runs `adds`, with `seeds` imported. */
const seeding = (adds: string) => definitionText(`{setup(c){${adds}}}`, 'import {seeds} from "@office/seeds";');

const uses = { dependencies: ["seeds"] };

/** The receipts of the knowledge package every fixture office selects: one per file under its seed/knowledge/. */
const knowledge = (() => {
  const folder = toolPath("packages/knowledge/seed");

  return Object.fromEntries(readdirSync(folder, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => [relative(folder, join(entry.parentPath, entry.name)), { package: "knowledge", sha256: sha256(readFileSync(join(entry.parentPath, entry.name))) }]));
})();

/** The receipts file's map, or undefined when there is none. */
const receipts = (dir: string) => existsSync(join(dir, ".office/seeds/receipts.json")) ? JSON.parse(read(join(dir, ".office/seeds/receipts.json"))).receipts : undefined;

/** Every seed output: the seeded files `paths` (null when absent), and every file in the store, with its bytes. */
function outputs(dir: string, paths: string[]) {
  const store = join(dir, ".office/seeds");

  return {
    files: Object.fromEntries(paths.map(path => [path, existsSync(join(dir, path)) ? read(join(dir, path)) : null])),
    store: existsSync(store) ? Object.fromEntries(readdirSync(store).sort().map(name => [name, read(join(store, name))])) : {},
  };
}

test("deselecting a pulled-in and a local package leaves their files and drops their receipts; selecting again marks a file still there and recreates a deleted one; an unread package stops every seed", () => {
  const { dir, cli, select } = fixture("deselect");
  const repo = join(root, "deselect-remote");
  const local = join(dir, "packages/local");
  const installed = () => lstatSync(join(dir, ".office/packages/office")).ino;
  const paths = ["notes/r.md", "notes/l.md", "notes/gone.md"];

  writePackage(join(repo, "remote/office.ts"), seeding('seeds.add(c,{destination:"notes/r.md",source:"r.md"})'), { name: "remote", ...uses });
  write(join(repo, "remote/r.md"), "remote\n");
  git(["init", "-qb", "main", repo]);
  const pinned = commit(repo);
  writePackage(join(local, "office.ts"), seeding('seeds.add(c,{destination:"notes/l.md",source:"l.md"}); seeds.add(c,{destination:"notes/gone.md",text:"gone v1\\n"})'), uses);
  write(join(local, "l.md"), "local\n");
  const both = `  - {name: remote, repo: ${repo}, path: remote, ref: ${pinned}}\n  - name: local\n`;

  select(both);
  expect(cli(0, "sync", "--packages")).toContain("package seeds: created notes/r.md from package remote");
  expect(receipts(dir)).toEqual({
    ...knowledge,
    "notes/gone.md": { package: "local", sha256: sha256("gone v1\n") },
    "notes/l.md": { package: "local", sha256: sha256("local\n") },
    "notes/r.md": { package: "remote", sha256: sha256("remote\n") },
  });
  expect(read(join(dir, "office.lock"))).not.toContain("seeds:");
  const store = outputs(dir, []).store;

  // Deselected: nothing is deleted, each path is named, and the receipts go; the store keeps every seed.
  rmSync(join(dir, "notes/gone.md"));
  select("");
  const dropped = cli(0, "sync", "--packages");

  expect(dropped).toContain("package seeds: left in place: notes/l.md (package local no longer seeds it)");
  expect(dropped).toContain("package seeds: left in place: notes/r.md (package remote no longer seeds it)");
  expect(dropped).toContain("package seeds: left in place: notes/gone.md (package local no longer seeds it)");
  expect(outputs(dir, paths).files).toEqual({ "notes/r.md": "remote\n", "notes/l.md": "local\n", "notes/gone.md": null });
  expect(receipts(dir)).toEqual(knowledge);
  const seedsAfter = outputs(dir, []).store;

  expect(Object.entries(store).filter(([name]) => name !== "receipts.json").every(([name, bytes]) => seedsAfter[name] === bytes)).toBe(true);

  // Selected again: files still there are marked as already there; the deleted one comes back.
  select(both);
  cli(0, "sync", "--packages");
  expect(outputs(dir, paths).files).toEqual({ "notes/r.md": "remote\n", "notes/l.md": "local\n", "notes/gone.md": "gone v1\n" });
  expect(receipts(dir)).toEqual({
    ...knowledge,
    "notes/gone.md": { package: "local", sha256: sha256("gone v1\n") },
    "notes/l.md": { package: "local", existing: true },
    "notes/r.md": { package: "remote", existing: true },
  });

  // The remote can't be fetched while the local seed changes: the set is published, no seed output changes.
  const before = outputs(dir, paths);
  const previousCopy = installed();

  writePackage(join(local, "office.ts"), seeding('seeds.add(c,{destination:"notes/l.md",source:"l.md"}); seeds.add(c,{destination:"notes/gone.md",text:"gone v2\\n"})'), uses);
  renameSync(repo, `${repo}-gone`);
  rmSync(join(dir, ".office/packages/remote"), { recursive: true });
  const unread = cli(1, "sync", "--packages");

  expect(unread).toContain("not running any package's sync function: what package remote registers is unknown until a sync loads it");
  expect(installed()).not.toBe(previousCopy);
  expect(outputs(dir, paths)).toEqual(before);

  // The next sync that loads every package applies it.
  renameSync(`${repo}-gone`, repo);
  expect(cli(0, "sync", "--packages")).toContain("package seeds: updated notes/gone.md to package local's new seed, as the file was unchanged");
  expect(read(join(dir, "notes/gone.md"))).toBe("gone v2\n");
}, 60_000);

test("a wrong shape is refused before the package set switches; a missing source, a clash or a refused path stops sync after it, with no seed output written", () => {
  const { dir, cli, select } = fixture("refused");
  const pkg = join(dir, "packages/bad");
  const other = join(dir, "packages/other");
  const installed = () => lstatSync(join(dir, ".office/packages/office")).ino;
  const paths = ["notes/a.md", "notes/o.md", "notes/new.md"];

  writePackage(join(pkg, "office.ts"), seeding('seeds.add(c,{destination:"notes/a.md",source:"a.md"})'), uses);
  write(join(pkg, "a.md"), "a\n");
  mkdirSync(join(pkg, "empty"));
  writePackage(join(other, "office.ts"), seeding('seeds.add(c,{destination:"notes/o.md",text:"o v1\\n"})'), uses);
  select("  - name: bad\n  - name: other\n");
  cli(0, "sync");
  // Another package's seed changes too, so a sync that went ahead would write.
  writePackage(join(other, "office.ts"), seeding('seeds.add(c,{destination:"notes/o.md",text:"o v2\\n"}); seeds.add(c,{destination:"notes/new.md",text:"new\\n"})'), uses);
  const before = outputs(dir, paths);

  // Plain JavaScript can give both, neither or an unknown key: the registry's parser refuses each, naming the destination.
  for (const [entry, reason] of [['{destination:"x.md",source:"a.md",text:"b"}', "give exactly one of source and text"], ['{destination:"x.md"}', "give exactly one of source and text"], ['{destination:"x.md",source:"a.md",mode:1}', "unknown key mode"]]) {
    const previousCopy = installed();

    writePackage(join(pkg, "office.ts"), seeding(`c.add(seeds, ${entry})`), uses);
    expect(cli(1, "sync")).toContain(`FAILED package bad: seed x.md: ${reason}`);
    expect(installed()).toBe(previousCopy);
    expect(outputs(dir, paths)).toEqual(before);
  }

  // Found only with the files: the set switches, nothing is written, and sync says to run again.
  for (const [adds, reason] of [
    ['seeds.add(c,{destination:"notes/b.md",source:"missing.md"})', "package bad's seed notes/b.md: source missing.md does not exist in the package"],
    ['seeds.add(c,{destination:"notes/o.md",source:"a.md"})', "notes/o.md is seeded by both package bad and package other"],
    ['seeds.add(c,{destination:".office/seeds/x",source:"a.md"})', "package bad's seed .office/seeds/x: .office/seeds/x: in .office/, which office manages"],
    ['seeds.add(c,{destination:".office/x",source:"empty"})', "package bad's seed .office/x: .office/x: in .office/, which office manages"],
    ['seeds.add(c,{destination:"notes/z\\u0000.md",text:""})', "package bad's seed notes/z\u0000.md: notes/z\u0000.md: not a plain path relative to the office"],
  ]) {
    const previousCopy = installed();

    writePackage(join(pkg, "office.ts"), seeding(`seeds.add(c,{destination:"notes/a.md",source:"a.md"}); ${adds}`), uses);
    const output = cli(1, "sync");

    expect(output).toContain(`FAILED package seeds: its sync failed: no seed was written: ${reason}`);
    expect(output).toContain("the new package set is active and the rest of this sync did not run: fix the package, then run office sync again");
    expect(installed()).not.toBe(previousCopy);
    expect(outputs(dir, paths)).toEqual(before);
  }
}, 60_000);
