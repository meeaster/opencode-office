// Folders under .office/ a package declares committed, in the compiled office: the exclude block
// leaves them out only from a package set applied whole, and is left as it is otherwise.
import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.ts";
import { definitionFixture } from "./package-definition.fixture.ts";
import { definitionText, writePackage } from "./test-package.ts";

const { root, write, read, commit, fixture } = definitionFixture({ second: false });

/** A package that declares `committed` and writes `.office/notes/x.md` in its sync. */
const keeper = (committed: string[]) => definitionText(`{committed: ${JSON.stringify(committed)}, sync({office}){mkdirSync(join(office.dir, ".office/notes"), {recursive: true}); writeFileSync(join(office.dir, ".office/notes/x.md"), "x\\n")}}`, 'import {mkdirSync, writeFileSync} from "node:fs"; import {join} from "node:path";');

/** Untracked entries of .office/ git status shows, but for the seeds package's store. */
const untracked = (dir: string) => git(["status", "--porcelain", "--untracked-files=all"], dir).split("\n").filter(line => line.includes(".office/") && !line.includes(".office/seeds/"));

test("a committed folder shows in git status, office's own folders and paths outside .office/ fail the load, and deselecting drops the exception", () => {
  const { dir, cli, select } = fixture("committed");
  const exclude = join(dir, ".git/info/exclude");
  const definition = join(dir, "packages/keeper/office.ts");
  git(["init", "-q", dir]);
  writePackage(definition, keeper([".office/notes/"]));
  select("  - name: keeper\n");
  cli(0, "sync");
  expect(read(exclude)).toContain("\n!/.office/notes/\n");
  expect(untracked(dir)).toEqual(["?? .office/notes/x.md"]);
  const block = read(exclude);

  for (const path of [".office/generations/", "notes/"]) {
    writePackage(definition, keeper([path]));
    const output = cli(1, "sync");

    expect(output).toMatch(new RegExp(`package keeper: .*${JSON.stringify(path).replaceAll(".", "\\.")}`));
    expect(read(exclude)).toBe(block);
  }

  writePackage(definition, keeper([".office/notes/"]));
  cli(0, "sync");
  write(join(dir, "office.yaml"), read(join(dir, "office.yaml")).replace("  - name: keeper\n", ""));
  expect(cli(0, "sync")).toContain("excluded /.office/notes/ from commits (info/exclude)");
  expect(read(exclude)).not.toContain("/.office/notes/");
  expect(untracked(dir)).toEqual([]);
}, 60_000);

test("the exclude block's bytes stay through a sync with an unfetched package and one with a rejected candidate", () => {
  const { dir, cli, select } = fixture("committed-kept");
  const exclude = join(dir, ".git/info/exclude");
  const repo = join(root, "committed-source");
  git(["init", "-q", dir]);
  git(["init", "-qb", "main", repo]);
  writePackage(join(repo, "remote/office.ts"), definitionText("{}"), { name: "remote" });
  const pinned = commit(repo);
  writePackage(join(dir, "packages/keeper/office.ts"), keeper([]));
  select(`  - {name: remote, repo: ${repo}, path: remote, ref: ${pinned}}\n  - name: keeper\n`);
  cli(0, "sync");
  const block = read(exclude);

  // Each sync below would add the exception if it rewrote the block.
  writePackage(join(dir, "packages/keeper/office.ts"), keeper([".office/notes/"]));
  rmSync(join(dir, ".office/packages/remote"), { recursive: true });
  rmSync(repo, { recursive: true });
  expect(cli(1, "sync")).toContain("FAILED .office/packages/remote");
  expect(read(exclude)).toBe(block);

  select("  - name: keeper\n  - name: broken\n");
  writePackage(join(dir, "packages/broken/office.ts"), definitionText('{setup(){throw Error("broken setup")}}'));
  expect(cli(1, "sync")).toContain("broken setup");
  expect(read(exclude)).toBe(block);
}, 60_000);
