import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { git } from "./git.ts";
import { highestTag, resolveTrack } from "./track.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-track-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];

test("a tag pattern picks the highest stable version, not the newest push, and ignores prereleases and other majors", () => {
  const tags = ["v2.10.0", "v2.9.0", "v2.11.0-rc.1", "v20.0.0", "v3.0.0", "v2.1", "v2.1.0.1", "v2.01.0", "x2.99.0"].map((name, index) => ({ name, commit: String(index) }));

  expect(highestTag("v2.*", tags)).toEqual({ tag: { name: "v2.10.0", commit: "0" }, matched: 2 });
  expect(highestTag("v*", tags)?.tag.name).toBe("v20.0.0");
  expect(highestTag("v9.*", tags)).toBeUndefined();
  expect(highestTag("release-*", [{ name: "release-1.2.3", commit: "a" }, { name: "release-1.10.0", commit: "b" }])?.tag.commit).toBe("b");
  // Two names for one version: the first in sort order, whatever order they come in.
  expect(highestTag("*", [{ name: "v1.0.0", commit: "b" }, { name: "1.0.0", commit: "a" }])?.tag.name).toBe("1.0.0");
});

test("a branch resolves to its commit and a pattern to the commit an annotated tag points at, through git ls-remote", async () => {
  const repo = join(dir, "repo");

  mkdirSync(repo);
  git(["init", "--quiet", "--initial-branch", "main", repo]);
  writeFileSync(join(repo, "file"), "one\n");
  git(["add", "."], repo);
  git([...identity, "commit", "--quiet", "-m", "one"], repo);

  const first = git(["rev-parse", "HEAD"], repo);

  git([...identity, "tag", "-a", "v1.2.0", "-m", "annotated"], repo);
  writeFileSync(join(repo, "file"), "two\n");
  git([...identity, "commit", "--quiet", "-am", "two"], repo);
  git(["tag", "v1.10.0-beta.1"], repo);

  expect(await resolveTrack(repo, "main")).toEqual({ commit: git(["rev-parse", "HEAD"], repo), via: "branch main" });
  expect(await resolveTrack(repo, "v1.*")).toEqual({ commit: first, via: "tag v1.2.0, the highest of 1 stable tag matching v1.*" });
  await expect(resolveTrack(repo, "v2.*")).rejects.toThrow("no stable SemVer tag");
  await expect(resolveTrack(repo, "develop")).rejects.toThrow("has no branch develop");
});
