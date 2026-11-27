// Whether the office's repository keeps root repos/ and scratch/ out: an ignore rule is not
// enough when files there are already tracked, and a Git that can't answer proves nothing. The
// report only reads: the owner's rules and index stay as they are.
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../../src/git.ts";
import { unignoredFolders } from "../../src/layout.ts";

function office() {
  const dir = mkdtempSync(join(tmpdir(), "office-layout-"));

  git(["init", "-q", dir]);
  writeFileSync(join(dir, ".gitignore"), "/repos/\n/scratch/\n");

  return dir;
}

test("ignored and untracked folders pass; a tracked file under an ignored folder is named, and nothing is changed", () => {
  const dir = office();

  expect(unignoredFolders(dir)).toEqual([]);

  mkdirSync(join(dir, "scratch"));
  writeFileSync(join(dir, "scratch/draft.md"), "draft\n");
  git(["add", "--force", "scratch/draft.md"], dir);
  const index = readFileSync(join(dir, ".git/index"));

  expect(unignoredFolders(dir)).toEqual(["scratch/ holds a file the office's repository tracks (scratch/draft.md), which its ignore rules don't untrack; untrack them with git rm -r --cached scratch/"]);
  expect(readFileSync(join(dir, ".git/index"))).toEqual(index);
  expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("/repos/\n/scratch/\n");

  writeFileSync(join(dir, ".gitignore"), "/scratch/\n");
  expect(unignoredFolders(dir)[0]).toStartWith("repos/ is not ignored by the office's Git rules");
});

test("a Git that can't answer is reported, not taken as protection", () => {
  const dir = mkdtempSync(join(tmpdir(), "office-layout-"));

  writeFileSync(join(dir, ".git"), `gitdir: ${join(dir, "missing")}\n`);
  const problems = unignoredFolders(dir);

  expect(problems).toHaveLength(2);
  expect(problems[0]).toStartWith("repos/: couldn't ask Git whether the office's rules ignore it (");
});
