// A package's `sync` and `check` functions in the compiled office: when they run, in what order,
// what their lines and problems do, and what a throw stops.
import { expect, test } from "bun:test";
import { existsSync, readlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.ts";
import { definitionFixture } from "./package-definition.fixture.ts";
import { definitionText, pluginDefinition, writePackage } from "./test-package.ts";

const { root, exe, write, read, commit, fixture } = definitionFixture({ second: false });

const fs = 'import {appendFileSync, mkdirSync, writeFileSync} from "node:fs"; import {join} from "node:path";';

/** A definition whose `sync` appends `name` to $PROBE and returns `lines`, plus `extra` fields. */
const probed = (name: string, lines = "[]", extra = "") => definitionText(`{sync(){appendFileSync(process.env.PROBE, ${JSON.stringify(`${name}\n`)}); return ${lines}}${extra}}`, fs);

const probe = (path: string) => existsSync(path) ? read(path).split("\n").filter(Boolean) : [];

test("sync functions run after every setup in loading order and print their lines under the package's name; check functions report, never sync", () => {
  const f = fixture("lifecycle");
  const provider = join(f.dir, "packages/provider");
  write(join(provider, "items.ts"), 'import {Registry} from "@office/sdk"; export const items = Registry.define({id: "provider.items", parse: i => i});');

  const definition = (check: string) => definitionText(`{setup(c){c.registry(items)},
    sync({office, entries}){mkdirSync(join(office.dir, "notes"), {recursive: true}); writeFileSync(join(office.dir, "notes/x"), "x"); return ["wrote notes/x", ...entries(items).map(e => "entry from " + e.owner)]},
    check(){${check}}}`, `${fs} import {items} from "./items.ts";`);

  writePackage(join(provider, "office.ts"), definition('return [{level: "warning", message: "watch out"}]'), { exports: { "./items": "./items.ts" } });

  for (const name of ["early", "late"]) writePackage(join(f.dir, `packages/${name}/office.ts`), definitionText(`{setup(c){c.add(items, {name: "${name}"})}}`, 'import {items} from "@office/provider/items";'), { dependencies: ["provider"] });
  f.select("  - name: early\n  - name: provider\n  - name: late\n");

  const synced = f.cli(0, "sync");
  expect(synced).toContain("package provider: wrote notes/x");
  expect(synced).toContain("package provider: entry from early");
  expect(synced).toContain("package provider: entry from late");
  expect(read(join(f.dir, "notes/x"))).toBe("x");

  // A warning leaves check passing; check runs no sync function.
  rmSync(join(f.dir, "notes/x"));
  expect(f.cli(0, "check")).toMatch(/^WARN package provider: watch out$/m);
  expect(existsSync(join(f.dir, "notes/x"))).toBe(false);

  writePackage(join(provider, "office.ts"), definition('return [{level: "failed", message: "broken now"}]'), { exports: { "./items": "./items.ts" } });
  expect(f.cli(1, "check")).toMatch(/^FAIL package provider: broken now$/m);

  // A throw is a failed line naming the package; the next package's check still runs.
  writePackage(join(provider, "office.ts"), definition('throw Error("check boom")'), { exports: { "./items": "./items.ts" } });
  writePackage(join(f.dir, "packages/late/office.ts"), definitionText('{setup(c){c.add(items, {name: "late"})}, check: () => [{level: "warning", message: "late warning"}]}', 'import {items} from "@office/provider/items";'), { dependencies: ["provider"] });
  const thrown = f.cli(1, "check");
  expect(thrown).toMatch(/^FAIL package provider: its check failed: check boom$/m);
  expect(thrown).toMatch(/^WARN package late: late warning$/m);
}, 60_000);

test("a sync function that throws stops the sync there: earlier lines print, later functions and steps don't run, the set stays switched", () => {
  const { dir, probe: path, cli, select } = fixture("throws");
  git(["init", "-q", dir]);
  writePackage(join(dir, "packages/first/office.ts"), probed("first", '["first line"]'));
  writePackage(join(dir, "packages/thrower/office.ts"), probed("thrower"));
  writePackage(join(dir, "packages/after/office.ts"), probed("after"));
  select("  - name: first\n  - name: thrower\n  - name: after\n");
  cli(0, "sync");
  expect(probe(path)).toEqual(["first", "thrower", "after"]);
  const exclude = read(join(dir, ".git/info/exclude"));

  writePackage(join(dir, "packages/thrower/office.ts"), definitionText('{sync(){throw Error("sync boom")}}'));
  // A package-only sync, then a full one, whose later steps (the new plugin's link, the clones, the
  // exclude block) must not run.
  writePackage(join(dir, "packages/linked/office.ts"), pluginDefinition(), { dependencies: ["opencode"] });
  write(join(dir, "packages/linked/plugin/index.js"), "export default {}\n");
  const upstream = join(root, "throws-desk-repo");
  git(["init", "-qb", "main", upstream]);
  write(join(upstream, "README.md"), "work\n");
  commit(upstream);
  write(join(dir, "office.yaml"), read(join(dir, "office.yaml")).replace("  - name: after\n", "  - name: after\n  - name: linked\n").replace("    repos: []", `    repos: [{ name: work, url: ${upstream} }]`));

  for (const args of [["sync", "--packages"], ["sync"]]) {
    rmSync(path);
    const current = readlinkSync(join(dir, ".office/current"));
    const output = cli(1, ...args);

    expect(output).toContain("package first: first line");
    expect(output).toContain("package thrower: its sync failed: sync boom");
    expect(output).toContain("run office sync again");
    expect(probe(path)).toEqual(["first"]);
    expect(readlinkSync(join(dir, ".office/current"))).not.toBe(current);
    expect(existsSync(join(dir, ".opencode/plugins/linked"))).toBe(false);
    expect(existsSync(join(dir, "example/repos/work"))).toBe(false);
    expect(read(join(dir, ".git/info/exclude"))).toBe(exclude);
  }

  // Fixed, the next sync runs every function and the later steps.
  writePackage(join(dir, "packages/thrower/office.ts"), probed("thrower"));
  rmSync(path);
  cli(0, "sync");
  expect(probe(path)).toEqual(["first", "thrower", "after"]);
  expect(readlinkSync(join(dir, ".opencode/plugins/linked"))).toBe("../../packages/linked/plugin");
  expect(existsSync(join(dir, "example/repos/work/.git"))).toBe(true);
}, 60_000);

test("no sync function runs on a rejected candidate or with a package unfetched, and check runs no check function while a package is broken", () => {
  const { dir, probe: path, cli, select } = fixture("skipped");
  const repo = join(root, "skipped-source");
  git(["init", "-qb", "main", repo]);
  writePackage(join(repo, "remote/office.ts"), definitionText("{}"), { name: "remote" });
  const pinned = commit(repo);
  writePackage(join(dir, "packages/marker/office.ts"), probed("marker", "[]", ', check(){appendFileSync(process.env.PROBE, "checked\\n"); return []}'));
  select(`  - {name: remote, repo: ${repo}, path: remote, ref: ${pinned}}\n  - name: marker\n`);
  cli(0, "sync");
  rmSync(path);

  // An unfetched package: the healthy set is published and sync says why no sync function ran.
  rmSync(join(dir, ".office/packages/remote"), { recursive: true });
  rmSync(repo, { recursive: true });
  const current = readlinkSync(join(dir, ".office/current"));
  const unfetched = cli(1, "sync");
  expect(unfetched).toContain("not running any package's sync function: what package remote registers is unknown until a sync loads it");
  expect(readlinkSync(join(dir, ".office/current"))).not.toBe(current);
  expect(probe(path)).toEqual([]);

  // A rejected candidate: one package's setup throws.
  select(`  - name: marker\n  - name: broken\n`);
  writePackage(join(dir, "packages/broken/office.ts"), definitionText('{setup(){throw Error("broken setup")}}'));
  expect(cli(1, "sync")).toContain("broken setup");
  expect(probe(path)).toEqual([]);

  // Check with a broken package: no check function runs, and the skipped line says so.
  const checked = cli(1, "check");
  expect(checked).toMatch(/^WARN package claims: not checked while a package doesn't load: .*packages' own check functions/m);
  expect(probe(path)).toEqual([]);
}, 60_000);

test("office refresh publishes a moved package without applying it, then its full sync runs each sync function once", () => {
  const { dir, env, probe: path, cli, select } = fixture("deferred");
  const repo = join(root, "deferred-source");
  git(["init", "-qb", "main", repo]);
  writePackage(join(repo, "moving/office.ts"), probed("moving"), { name: "moving" });
  commit(repo);
  writePackage(join(dir, "packages/local/office.ts"), probed("local"));
  select(`  - {name: moving, repo: ${repo}, path: moving, ref: main}\n  - name: local\n`);
  cli(0, "sync");
  write(join(repo, "moving/notes.md"), "moved\n");
  const next = commit(repo);
  rmSync(path);

  const refreshed = Bun.spawnSync([exe, "--office", dir, "refresh"], { cwd: root, env });
  const output = refreshed.stdout.toString() + refreshed.stderr.toString();

  expect(output).toContain(`office.lock: locked moving at ${next.slice(0, 12)}`);
  expect(read(join(dir, "office.lock"))).toContain(`commit: ${next}`);
  expect(probe(path).sort()).toEqual(["local", "moving"]);
}, 60_000);
