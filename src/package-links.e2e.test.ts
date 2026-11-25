// How packages import each other in the compiled office: through the set's node_modules/@office
// links, with package.json `exports` enforced, on a first sync, across an update and in a command.
import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "./git.ts";
import { definitionFixture } from "./package-definition.fixture.ts";
import { definitionText, writePackage } from "./test-package.ts";

const { root, write, read, commit, fixture, published } = definitionFixture();

/** A consumer that adds a reference named after what it imports, and prints it from a command. */
function consumer(imports: string, value: string) {
  return definitionText(`{setup(ctx){
      ctx.add(repositories,{name:${value},url:"https://example.invalid/r.git"});
    },
    commands:{"consumer show":{summary:"show",run(){console.log("value", ${value})}}}}`, `import {repositories} from "@office/references/repositories"; ${imports}`);
}

const dependencies = ["provider", "references"];

test("a first sync resolves local packages through the new set's links, and exports decide what is public", () => {
  const { dir, probe, cli, select } = fixture("first-sync");
  const provider = join(dir, "packages/provider");
  rmSync(join(dir, ".office"), { recursive: true });
  select("  - name: consumer\n  - name: provider\n");
  // The provider has libraries of its own (devDependencies, a node_modules folder) and imports a built-in's export.
  write(join(provider, "office.ts"), definitionText(`{commands:{"provider show":{summary:"show",run(){console.log("tools", typeof tools.require)}}}}`, `import {tools} from "@office/tools";`));
  write(join(provider, "package.json"), JSON.stringify({ name: "@office/provider", private: true, exports: { ".": "./index.ts", "./token": "./lib/token.ts" }, devDependencies: { typescript: "5.9.3" }, office: { definition: "./office.ts", dependencies: ["@office/tools"] } }));
  write(join(provider, "node_modules/typescript/package.json"), '{"name":"typescript"}');
  write(join(provider, "index.ts"), 'export const value = "first";');
  write(join(provider, "lib/token.ts"), 'export const token = "token";');
  write(join(provider, "private.ts"), `import {appendFileSync} from "node:fs"; appendFileSync(process.env.PROBE, "private\\n"); export const hidden = "hidden";`);
  writePackage(join(dir, "packages/consumer/office.ts"), consumer('import {value} from "@office/provider"; import {token} from "@office/provider/token";', "`${value}-${token}`"), { dependencies });

  cli(0, "sync", "--packages");
  expect(published(dir)).toContain("first-token\thttps://example.invalid/r.git\tpackage consumer");
  expect(cli(0, "consumer", "show")).toContain("value first-token");
  expect(cli(0, "provider", "show")).toContain("tools function");
  // Editing the provider's exported module shows in the next command, without a sync.
  write(join(provider, "index.ts"), 'export const value = "edited";');
  expect(cli(0, "consumer", "show")).toContain("value edited-token");

  writePackage(join(dir, "packages/consumer/office.ts"), consumer('import {hidden} from "@office/provider/private";', "hidden"), { dependencies });
  expect(cli(2, "consumer", "show")).toContain("package consumer");
  expect(existsSync(probe)).toBe(false);
});

test("an update resolves a local consumer against the provider of the set it checks", () => {
  const { dir, cli, select } = fixture("update-sets");
  const repo = join(root, "update-provider");
  const provider = join(repo, "provider");
  git(["init", "-q", "-b", "main", repo]);
  writePackage(join(provider, "office.ts"), definitionText('{}'), { exports: { ".": "./index.ts" } });
  write(join(provider, "index.ts"), 'export const value = "one";');
  commit(repo);
  select(`  - {name: provider, repo: ${repo}, path: provider, ref: main}\n  - name: consumer\n`);
  writePackage(join(dir, "packages/consumer/office.ts"), consumer('import {value} from "@office/provider";', "value"), { dependencies });
  cli(0, "sync", "--packages");
  expect(published(dir)).toContain("one\t");

  write(join(provider, "index.ts"), 'export const value = "two";');
  commit(repo);
  const update = cli(0, "packages", "update");
  expect(update).toContain("package provider: locked");
  expect(published(dir)).toContain("two\t");
  expect(published(dir)).not.toContain("one\t");
  expect(cli(0, "references", "list")).toContain("two\thttps://example.invalid/r.git\tpackage consumer");

  // The consumer already imports an export only the newer provider has.
  writePackage(join(provider, "office.ts"), definitionText('{}'), { exports: { ".": "./index.ts", "./extra": "./extra.ts" } });
  write(join(provider, "extra.ts"), 'export const extra = "three";');
  commit(repo);
  writePackage(join(dir, "packages/consumer/office.ts"), consumer('import {extra} from "@office/provider/extra";', "extra"), { dependencies });
  cli(0, "packages", "update");
  expect(cli(0, "references", "list")).toContain("three\thttps://example.invalid/r.git\tpackage consumer");
});

test("a provider's shared module is evaluated once in a run, and a definition reads a file beside it", () => {
  const { dir, probe, cli, select } = fixture("one-evaluation");
  select("  - name: provider\n  - name: left\n  - name: right\n");
  writePackage(join(dir, "packages/provider/office.ts"), definitionText('{}'), { exports: { "./count": "./count.ts" } });
  write(join(dir, "packages/provider/count.ts"), 'import {appendFileSync} from "node:fs"; appendFileSync(process.env.PROBE, "evaluated\\n"); export const counter = {n: 0};');

  for (const side of ["left", "right"]) {
    writePackage(join(dir, `packages/${side}/office.ts`), definitionText(`{setup(){counter.n++},
        commands:{"${side} count":{summary:"count",run(){console.log("${side}", counter.n, note)}}}}`, `import {counter} from "@office/provider/count"; import {readFileSync} from "node:fs";
        const note = readFileSync(new URL("./note.txt", import.meta.url), "utf8").trim();`), { dependencies: ["provider"] });
    write(join(dir, `packages/${side}/note.txt`), `${side} note\n`);
  }

  cli(0, "sync", "--packages");
  rmSync(probe, { force: true });
  // Both setups ran against one module: the counter saw both.
  expect(cli(0, "left", "count")).toContain("left 2 left note");
  expect(read(probe)).toBe("evaluated\n");
});

test("the editor link stays out of Git without a node_modules rule, and check reads a consumer of a provider's export", () => {
  const { dir, cli, select } = fixture("editor-link");
  const gitignore = join(dir, ".gitignore");
  write(gitignore, read(gitignore).replace("node_modules/\n", ""));
  select("  - name: consumer\n  - name: provider\n");
  writePackage(join(dir, "packages/provider/office.ts"), definitionText('{}'), { exports: { ".": "./index.ts" } });
  write(join(dir, "packages/provider/index.ts"), 'export const value = "checked";');
  writePackage(join(dir, "packages/consumer/office.ts"), consumer('import {value} from "@office/provider";', "value"), { dependencies });
  cli(0, "sync", "--packages");

  expect(git(["status", "--porcelain", "--untracked-files=all"], dir)).not.toContain("node_modules");
  expect(git(["check-ignore", "-v", "packages/node_modules/@office"], dir)).toMatch(/info\/exclude:\d+:\/packages\/node_modules\/\tpackages\/node_modules\/@office/);
  // Check exits 1 for unrelated host prerequisites in this fixture; its package lines must pass.
  const check = cli(1, "check");
  expect(check).toMatch(/^ok\s+package consumer\b/m);
  expect(check).toMatch(/^ok\s+package provider\b/m);
  expect(check).not.toMatch(/^FAIL\s+package/m);
  expect(check).not.toContain("node_modules");

  // The template's tsconfig.json follows the same imports through the editor link, and leaves working repositories out.
  // A local package's typed definition: Package from @office/sdk, a handle from another package.
  write(join(dir, "packages/consumer/typed.ts"), 'import { Package } from "@office/sdk"; import { repositories } from "@office/references/repositories"; import { value } from "@office/provider";\nexport default Package.define({ settings: { type: "object", additionalProperties: false, properties: { url: { type: "string", default: "u" } } }, setup(ctx) { ctx.add(repositories, { name: value, url: ctx.settings.url }); } });\n');
  write(join(dir, "repos/example/broken.ts"), 'const broken: number = "not a number";');
  const checkout = dirname(import.meta.dir);
  // With the template's own strict settings, nothing relaxed.
  const tsc = () => Bun.spawnSync([join(checkout, "node_modules/.bin/tsc"), "--noEmit", "-p", join(dir, "tsconfig.json")], { cwd: dir });
  // A deliberate type error in the local package is reported, so tsc checked it; fixed, tsc passes.
  write(join(dir, "packages/consumer/wrong.ts"), 'import { value } from "@office/provider"; export const wrong: number = value;');
  const failing = tsc();
  expect(failing.exitCode, failing.stdout.toString()).not.toBe(0);
  expect(failing.stdout.toString().trim().split("\n")).toEqual([expect.stringMatching(/^packages\/consumer\/wrong\.ts\(1,\d+\): error TS2322:/)]);
  rmSync(join(dir, "packages/consumer/wrong.ts"));
  const passing = tsc();
  expect(passing.exitCode, passing.stdout.toString()).toBe(0);
});

test("a package with an empty exports map shares nothing, even a file that exists", () => {
  const { dir, probe, cli, select } = fixture("empty-exports");
  select("  - name: consumer\n  - name: provider\n");
  write(join(dir, "packages/provider/definition.ts"), definitionText('{}'));
  write(join(dir, "packages/provider/package.json"), JSON.stringify({ name: "@office/provider", exports: {}, office: { definition: "./definition.ts" } }));
  write(join(dir, "packages/provider/office.ts"), `import {appendFileSync} from "node:fs"; appendFileSync(process.env.PROBE, "office.ts\\n"); export default {};`);
  writePackage(join(dir, "packages/consumer/office.ts"), consumer('import shared from "@office/provider/office.ts";', "String(shared)"), { dependencies });

  expect(cli(1, "sync", "--packages")).toContain("package consumer");
  expect(existsSync(probe)).toBe(false);
});
