import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../src/git.ts";
import { definitionFixture } from "../support/package-definition.fixture.ts";

const { root, commit, fixture } = definitionFixture({ second: false });

test("a fresh office syncs and checks without the repos package and can use references", () => {
  const f = fixture("fresh");
  const upstream = join(root, "fresh-reference");

  mkdirSync(upstream);
  git(["init", "-q", "-b", "main", upstream]);
  writeFileSync(join(upstream, "README.md"), "docs\n");
  commit(upstream);

  expect(readFileSync(join(f.dir, ".gitignore"), "utf8")).toMatch(/^\/repos\/\n\/scratch\/$/m);
  const folders = readdirSync(f.dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();

  expect(folders).toEqual([".git", ".office", ".opencode", "executor-apps", "knowledge"]);
  expect(readdirSync(join(f.dir, "executor-apps"))).toEqual(["opencode"]);

  writeFileSync(join(f.dir, "office.yaml"), readFileSync(join(f.dir, "office.yaml"), "utf8").replace("references: []", `references: [{name: docs, url: '${upstream}', ref: main, description: The docs}]`));
  f.cli(0, "sync");
  expect(f.cli(0, "references", "list")).toContain("docs\t");
  expect(existsSync(join(f.dir, "references/docs/README.md"))).toBe(true);
  expect(f.cli(0, "instructions", "--packages")).toBe("");

  const checked = f.cli(0, "check");

  expect(checked).not.toMatch(/is not ignored|\.opencode\/ folder/i);
  expect(checked).toMatch(/^ok\s+package references\b/m);
});

test("an unknown office.yaml key is reported even when installed package folders are missing", () => {
  const { dir, cli } = fixture("invalid-config");
  const yaml = join(dir, "office.yaml");
  const packages = join(dir, ".office/packages");

  writeFileSync(yaml, readFileSync(yaml, "utf8") + "\nunknown_key: []\n");
  rmSync(packages, { recursive: true });

  expect(cli(1, "check")).toContain("office.yaml is not valid:\n  unknown_key:");
  expect(existsSync(packages)).toBe(false);

  mkdirSync(packages);
  expect(cli(1, "references", "list")).toContain("office.yaml is not valid:\n  unknown_key:");
  expect(readdirSync(packages)).toEqual([]);
});
