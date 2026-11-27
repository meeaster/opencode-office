// What a package gets from @office/sdk in the compiled office: the executable's own SDK.
import { expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { definitionFixture } from "../support/package-definition.fixture.ts";
import { definitionText, settingsSchema, writePackage } from "../support/test-package.ts";

const { exe, write, fixture } = definitionFixture({ second: false });

test("a package gets the executable's SDK, not a working stand-in on disk", () => {
  const { dir, env, probe, cli, select } = fixture("sdk-stand-in");
  const sdk = join(dir, ".office/current/node_modules/@office/sdk");

  select("  - name: notes\n");
  writePackage(join(dir, "packages/notes/office.ts"), definitionText('{commands:{"notes show":{summary:"Show notes",run(){console.log("notes shown")}}}}'));
  cli(0, "sync");

  // A working SDK whose Package.define leaves a marker, in place of the copy sync wrote.
  rmSync(sdk, { recursive: true });
  write(join(sdk, "package.json"), JSON.stringify({ name: "@office/sdk", type: "module", exports: { ".": "./index.js" } }));
  write(join(sdk, "index.js"), 'import {appendFileSync} from "node:fs"; export const Package = {define(d){appendFileSync(process.env.PROBE,"stand-in\\n"); return d}}; export const Registry = {define: r => r};');
  // It does work when it is what loads.
  const direct = Bun.spawnSync([process.execPath, "-e", `(await import(${JSON.stringify(join(sdk, "index.js"))})).Package.define({})`], { env });
  expect(direct.exitCode, direct.stderr.toString()).toBe(0);
  expect(existsSync(probe)).toBe(true);
  rmSync(probe);

  expect(cli(0, "notes", "show")).toContain("notes shown");
  expect(cli(0, "--help").split("\n")).toContainEqual(expect.stringMatching(/^\s+notes show\s+Show notes$/));
  const check = cli(0, "check");
  expect(check).toMatch(/^ok\s+package notes\b/m);
  expect(check).not.toMatch(/^FAIL\s+package/m);
  cli(0, "sync");
  expect(existsSync(probe)).toBe(false);
});

test("with one package's setting made invalid after a sync, no setup runs: its command and sync fail, nothing is published, help lists the commands", () => {
  const { dir, env, select } = fixture("sdk-settings");
  const marker = join(dir, "first-setup");
  const current = join(dir, ".office/current");

  writePackage(join(dir, "packages/first/office.ts"), definitionText('{setup(){appendFileSync(process.env.FIRST_MARKER,"set up\\n")},commands:{"first show":{summary:"Show first",run(){console.log("first shown")}}}}', 'import {appendFileSync} from "node:fs";'));
  writePackage(join(dir, "packages/second/office.ts"), definitionText(`{settings:${settingsSchema({ port: 4566 })}}`));
  select("  - name: first\n  - name: second\n    settings: {port: 4600}\n");

  const run = (status: number, ...args: string[]) => {
    const result = Bun.spawnSync([exe, "--office", dir, ...args], { cwd: dir, env: { ...env, FIRST_MARKER: marker } });
    const output = result.stdout.toString() + result.stderr.toString();

    expect(result.exitCode, output).toBe(status);

    return output;
  };

  run(0, "sync");
  expect(existsSync(marker)).toBe(true);
  rmSync(marker);
  const generation = readlinkSync(current);

  select("  - name: first\n  - name: second\n    settings: {port: \"4600\"}\n");
  const problem = "packages.second.settings.port: must be integer";

  expect(run(1, "first", "show")).toContain(`package second: ${problem}`);
  const synced = run(1, "sync");

  expect(synced).toContain(`FAILED package second: ${problem}`);
  // Stopped at the settings check, before any setup or collection.
  expect(synced).toContain("no package was set up and no package set was published");
  expect(readlinkSync(current)).toBe(generation);
  const help = run(0, "--help").split("\n");

  expect(help).toContainEqual(expect.stringMatching(/^\s+first show\s+Show first$/));
  expect(help).toContainEqual(expect.stringMatching(new RegExp(`^\\s+package second: ${problem}$`)));
  expect(existsSync(marker)).toBe(false);

  // A settings schema that isn't a mapping stops it the same way, and its own commands are listed.
  writePackage(join(dir, "packages/second/office.ts"), definitionText('{settings:null,commands:{"second show":{summary:"Show second",run(){}}}}'));
  select("  - name: first\n  - name: second\n");
  const malformed = "packages/second/office.ts: settings: must be a JSON Schema object";
  const failed = run(1, "sync");

  expect(failed).toContain(`FAILED package second: ${malformed}`);
  expect(failed).toContain("no package was set up and no package set was published");
  expect(readlinkSync(current)).toBe(generation);
  const listed = run(0, "--help").split("\n");

  expect(listed).toContainEqual(expect.stringMatching(/^\s+second show\s+Show second$/));
  expect(listed).toContainEqual(expect.stringMatching(new RegExp(`^\\s+package second: ${malformed}$`)));
  expect(existsSync(marker)).toBe(false);
});

test("an entry comes with its owner's name and the folder its definition was loaded from", () => {
  const { dir, cli, select } = fixture("sdk-folder");

  write(join(dir, "packages/provider/items.ts"), 'import {Registry} from "@office/sdk"; export const items = Registry.define({id: "provider.items", parse: entry => entry});');
  writePackage(join(dir, "packages/provider/office.ts"), definitionText('{setup(c){c.registry(items)},commands:{"provider show":{summary:"Show",run({entries}){for (const e of entries(items)) console.log([e.owner, e.folder, existsSync(join(e.folder, e.value.path))].join("|"))}}}}', 'import {existsSync} from "node:fs"; import {join} from "node:path"; import {items} from "./items.ts";'), { exports: { "./items": "./items.ts" } });
  writePackage(join(dir, "packages/consumer/office.ts"), definitionText('{setup(c){c.add(items,{name:"doc",path:"data/doc.txt"})}}', 'import {items} from "@office/provider/items";'), { dependencies: ["provider"] });
  write(join(dir, "packages/consumer/data/doc.txt"), "doc\n");
  select("  - name: provider\n  - name: consumer\n");
  cli(0, "sync");

  // A bound reader loads each definition through its package set's link.
  const [owner, folder, exists] = cli(0, "provider", "show").trim().split("|");
  const generation = readlinkSync(join(dir, ".office/current"));

  expect(owner).toBe("consumer");
  expect(folder).toBe(join(dir, ".office", generation, "node_modules/@office/consumer"));
  expect(exists).toBe("true");
});

test("a package called sdk fails sync, and the set's @office/sdk stays the SDK", () => {
  const { dir, cli, select } = fixture("sdk-name");
  const current = join(dir, ".office/current");
  const sdk = join(current, "node_modules/@office/sdk");
  const before = { generation: readlinkSync(current), index: readFileSync(join(sdk, "index.ts"), "utf8") };

  writePackage(join(dir, "packages/sdk/office.ts"), definitionText("{}"));
  select("  - name: sdk\n");
  expect(cli(1, "sync")).toContain("the name sdk is reserved for @office/sdk; rename the package");
  expect(readlinkSync(current)).toBe(before.generation);
  expect(lstatSync(sdk).isDirectory()).toBe(true);
  expect(readFileSync(join(sdk, "index.ts"), "utf8")).toBe(before.index);
});
