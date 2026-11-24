// An office without desks in the compiled office: a fresh one is initialized, synced and checked
// without the repos package and gets no desk folders, configs or starter apps; references still
// work. An office.yaml that still declares desks is refused, naming the migration, by every
// command that reads it, and nothing in the office changes.
import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.ts";
import { definitionFixture } from "./package-definition.fixture.ts";

const { root, write, commit, fixture } = definitionFixture({ second: false });

/** Every entry under `dir` with its contents or link target, `.git` internals aside. */
function tree(dir: string, folder = "", entries = new Map<string, string>()) {
  for (const name of readdirSync(join(dir, folder)).sort()) {
    const path = join(folder, name);
    const full = join(dir, path);
    const info = lstatSync(full);

    if (info.isSymbolicLink()) entries.set(path, `-> ${readlinkSync(full)}`);
    else if (info.isDirectory() && name === ".git") entries.set(path, "git");
    else if (info.isDirectory()) tree(dir, path, entries);
    else entries.set(path, readFileSync(full, "utf8"));
  }

  return entries;
}

test("a fresh office syncs and checks without repos: no desk folders, configs or starter apps, and references still work", () => {
  const f = fixture("fresh");
  const upstream = join(root, "fresh-reference");

  mkdirSync(upstream);
  git(["init", "-q", "-b", "main", upstream]);
  writeFileSync(join(upstream, "README.md"), "docs\n");
  commit(upstream);

  expect(readFileSync(join(f.dir, "office.yaml"), "utf8")).not.toMatch(/^desks:/m);
  expect(readFileSync(join(f.dir, ".gitignore"), "utf8")).toMatch(/^\/repos\/\n\/scratch\/$/m);
  // Only the template's folders: no example desk, no folder with its own AGENTS.md, .opencode or app.
  const folders = readdirSync(f.dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name).sort();

  expect(folders).toEqual([".git", ".office", ".opencode", "executor-apps", "knowledge"]);
  expect(readdirSync(join(f.dir, "executor-apps"))).toEqual(["opencode"]);

  writeFileSync(join(f.dir, "office.yaml"), readFileSync(join(f.dir, "office.yaml"), "utf8").replace("references: []", `references: [{name: docs, url: '${upstream}', ref: main, description: The docs}]`));
  expect(f.cli(0, "sync")).not.toMatch(/\bdesks?\b/i);
  expect(f.cli(0, "references", "list")).toContain("docs\t");
  expect(existsSync(join(f.dir, "references/docs/README.md"))).toBe(true);
  expect(f.cli(0, "instructions")).not.toMatch(/\bdesks?\b/i);
  expect(f.cli(0, "instructions", "--packages")).toBe("");

  // Nothing check says is about desks or the layout.
  const checked = f.cli(0, "check");

  expect(checked).not.toMatch(/\bdesks?\b|is not ignored|\.opencode\/ folder/i);
  expect(checked).toMatch(/^ok\s+package references\b/m);
});

test("an office.yaml that still declares desks, even none, is refused by every command that reads it, naming the migration, and nothing changes", () => {
  const f = fixture("legacy");

  // An office as an earlier release left it: a desk with its own instructions, app and a checkout.
  const yaml = readFileSync(join(f.dir, "office.yaml"), "utf8");

  write(join(f.dir, "work/AGENTS.md"), "# Work desk\n");
  write(join(f.dir, "work/executor-apps/work/package.json"), '{"name":"work"}\n');
  write(join(f.dir, "work/scratch/draft.md"), "draft\n");
  git(["init", "-q", join(f.dir, "work/repos/site")]);

  // A discovery link that needs repair: refused before anything repairs it.
  rmSync(join(f.dir, ".office/packages"));

  for (const desks of ["desks: {}\n", "desks:\n  work:\n    description: Work.\n    repos: [{name: site, url: 'https://example.invalid/site.git'}]\n"]) {
    write(join(f.dir, "office.yaml"), `${yaml}${desks}`);
    const before = tree(f.dir);

    for (const args of [["sync"], ["sync", "--packages"], ["sync", "--references"], ["check"], ["up"], ["down"], ["instructions", "--packages"], ["opencode", "inspect"], ["apps", "deploy"], ["references", "list"]]) {
      const output = f.cli(1, ...args);

      expect(output, args.join(" ")).toContain("desks: desks are no longer supported, so office changed nothing here. Move this office off desks as \"Offices with desks\" in the office CLI's README describes, or keep running it with the office executable it was made with");
      expect(tree(f.dir), args.join(" ")).toEqual(before);
    }

    // The session guidance says the same, rather than describing a layout it can't read.
    expect(f.cli(0, "instructions")).toContain("desks: desks are no longer supported");
    expect(tree(f.dir)).toEqual(before);
  }

  // Without a published package set, too: nothing is created and the package text isn't an empty success.
  rmSync(join(f.dir, ".office"), { recursive: true });
  const bare = tree(f.dir);

  for (const args of [["instructions", "--packages"], ["sync"], ["references", "list"]]) {
    expect(f.cli(1, ...args), args.join(" ")).toContain("desks: desks are no longer supported");
    expect(tree(f.dir), args.join(" ")).toEqual(bare);
  }
});
