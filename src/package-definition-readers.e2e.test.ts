import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.ts";
import { definitionFixture } from "./package-definition.fixture.ts";
import { definitionText, writePackage } from "./test-package.ts";

const { root, exe, marker, write, read, commit, fixture } = definitionFixture();

for (const kind of ["local", "tracked"]) {
  test(`a newly shipped built-in cannot claim the ${kind} source during sync, update or refresh`, () => {
    const { dir, probe, select, cli, newer } = fixture(`collision-${kind}`);
    const repo = join(root, `collision-source-${kind}`);
    const pkg = kind === "local" ? join(dir, "packages/arrival") : join(repo, "arrival");
    const installed = kind === "local" ? pkg : join(dir, ".office/packages/arrival");
    const link = join(dir, ".opencode/plugins/arrival");
    writePackage(join(pkg, "office.ts"), definitionText(`{}`, `${marker}`));
    write(join(pkg, "plugin/index.ts"), "// original plugin");
    write(join(pkg, "seed/arrival.md"), "seed");
    let identity = "packages/arrival";

    if (kind === "local") select("  - name: arrival\n");
    else {
      git(["init", "-q", "-b", "main", repo]);
      const first = commit(repo);
      identity = `${repo}@${first}:arrival`;
      select(`  - {name: arrival, repo: ${repo}, path: arrival, ref: ${first}, track: main}\n`);
      write(join(pkg, "plugin/index.ts"), "// new plugin");
      commit(repo);
    }

    cli(0, "sync", "--packages");
    const paths = [join(dir, "office.yaml"), join(dir, "office.lock"), join(installed, "office.ts"), join(link, "index.ts"), join(dir, "arrival.md")];

    if (kind === "tracked") paths.push(join(installed, ".source.json"));
    const old = paths.map(read);
    const target = readlinkSync(link);
    rmSync(probe);

    for (const args of [["sync"], ["sync", "--packages"], ["packages", "update"], ["refresh"]]) {
      const output = newer(1, ...args);
      expect(output).toContain("built-in package arrival");
      expect(output).toContain(identity);
      expect(existsSync(probe)).toBe(false);
      expect(readlinkSync(link)).toBe(target);
      expect(paths.map(read)).toEqual(old);

      if (kind === "local") expect(existsSync(join(dir, ".office/packages/arrival"))).toBe(false);
    }
  }, 60_000);
}

test("reads return the provider's parsed values, a copy each; sync admits no batch whose registration failed", () => {
  const { dir, cli, select } = fixture("collections");
  const path = (name: string) => join(dir, "packages", name, "office.ts");
  const contract = join(dir, "packages/catalog/items.ts");
  const current = join(dir, ".office/current");
  const author = definitionText('{setup(c){c.add(items,{name:"first",count:1})}}', 'import {items} from "@office/catalog/items";');
  const shares = { exports: { "./items": "./items.ts" } };
  const uses = { dependencies: ["catalog"] };
  const provider = definitionText('{setup(c){c.registry(items);}}', 'import {items} from "./items.ts";');
  select("  - {name: alpha}\n  - {name: beta}\n  - {name: catalog}\n");
  writePackage(path("alpha"), author, uses);
  writePackage(path("catalog"), provider, shares);
  write(contract, 'export const items={id:"catalog.items",parse(i){if(!Number.isFinite(i.count))throw Error("expected count");return {...i,count:i.count+1}}}');
  writePackage(path("beta"), definitionText(`{commands:{items:{summary:"items",run(i){
    const handle={id:"catalog.items",parse(){throw Error("reader parser ran")}};
    const first=i.read(handle); if(first.length)first[0].value.count=99;console.log(JSON.stringify(i.read(handle)));
  }}}}`));
  cli(0, "sync", "--packages");
  // Normalized once by the provider, not by the reader's handle; changing one read leaves the next alone.
  expect(cli(0, "items")).toContain('"count":2');
  const synced = readlinkSync(current);

  writePackage(path("alpha"), 'throw Error("failed author")');
  expect(cli(1, "sync", "--packages")).toContain("FAILED package alpha: packages/alpha/office.ts: failed author");
  expect(readlinkSync(current)).toBe(synced);
  expect(cli(1, "items")).toContain("package alpha: packages/alpha/office.ts: failed author");
  // A provider whose parser now refuses an author's entry stops sync, naming the author.
  writePackage(path("alpha"), author, uses);
  write(contract, 'export const items={id:"catalog.items",parse(i){if(typeof i.count!=="string")throw Error("expected text");return i}}');
  expect(cli(1, "sync", "--packages")).toContain("FAILED package alpha: expected text");
  expect(readlinkSync(current)).toBe(synced);
  writePackage(path("alpha"), author.replace("count:1", 'count:"valid"'), uses);
  writePackage(path("catalog"), provider.replace("c.registry(items);", 'c.registry(items);c.add(items,{name:"bad",count:1});'), shares);
  expect(cli(1, "sync", "--packages")).toContain("FAILED package catalog: expected text");
  expect(readlinkSync(current)).toBe(synced);
  expect(cli(1, "items")).toContain("package catalog: expected text");
});

test("a reader uses the provider as it is now; a writer that fails stops sync and leaves the applied references", () => {
  const { dir, cli, select } = fixture("reader-contract");
  const packages = join(dir, "packages");
  const contract = join(packages, "catalog/items.ts");
  const writer = join(packages, "alpha/office.ts");
  const add = 'c.add(items,{name:"x",value:12});';
  const uses = { dependencies: ["catalog"] };
  const author = (body: string) => definitionText(`{setup(c){${body}}}`, `import {items} from "@office/catalog/items";`);
  select("  - name: alpha\n  - name: catalog\n  - name: beta\n");
  write(contract, 'export const items={id:"catalog.items",parse:i=>i};export const display=i=>i.value.toFixed(0)');
  writePackage(join(packages, "catalog/office.ts"), definitionText('{setup(c){c.registry(items)}}', 'import {items} from "./items.ts";'), { exports: { "./items": "./items.ts" } });
  writePackage(join(packages, "beta/office.ts"), definitionText(`{commands:{display:{summary:"display",run(i){console.log(i.read(items).map(row=>display(row.value)).join(",") || "empty")}}}}`, `import {items,display} from "@office/catalog/items";`), uses);
  writePackage(writer, author(add), uses);
  cli(0, "sync", "--packages");
  expect(cli(0, "display")).toContain("12");
  const snapshot = join(dir, ".office/resolved/references.json");
  const previous = read(snapshot);

  // An unsynced provider edit parses this run's additions: no old row meets the new reader.
  write(contract, 'export const items={id:"catalog.items",parse:i=>({...i,value:"v"+i.value})};export const display=i=>i.value.toUpperCase()');
  expect(cli(0, "display")).toContain("V12");
  // A registry without a key accepts equal entries.
  writePackage(writer, author(add + add), uses);
  expect(cli(0, "display")).toContain("V12,V12");
  writePackage(writer, 'throw Error("writer unavailable")');
  expect(cli(1, "sync", "--packages")).toContain("writer unavailable");
  expect(read(snapshot)).toBe(previous);
  expect(cli(1, "display")).toContain("writer unavailable");
  writePackage(writer, author(add), uses);
  cli(0, "sync", "--packages");
  expect(cli(0, "display")).toContain("V12");
});

for (const order of [["alpha", "catalog"], ["catalog", "alpha"]]) {
  test(`tracked ${order.join(" then ")} publishes the final parser on the first update`, () => {
    const { dir, cli, select } = fixture(`pair-${order[0]}`);
    const repo = join(root, `source-${order[0]}`);
    git(["init", "-qb", "main", repo]);

    const contract = (unit: string) => {
      write(join(repo, "catalog/exports/items.ts"), `import {readFileSync} from "node:fs";export const unit=readFileSync(new URL("../unit.txt",import.meta.url),"utf8");export const items={id:"catalog.items",parse:i=>({...i,unit})}`);
      write(join(repo, "catalog/unit.txt"), unit);
    };

    const consumer = join(repo, "alpha/office.ts");
    write(join(repo, "alpha/compose.yaml"), "services: {alpha: {image: example/alpha}}\n");
    write(join(repo, "alpha/exports/expected.ts"), `export const expected="metres"`);
    writePackage(consumer, definitionText(`{settings:{type:"object",additionalProperties:false,properties:{enabled:{type:"boolean",default:false}}},setup(c){if(c.settings.enabled){
      c.add(items,{name:"sample"});}}}`, `import {items,unit} from "@office/catalog/items";import {expected} from "./exports/expected.ts";
      if(unit!==expected)throw Error("incompatible revisions");`), { exports: { "./expected": "./exports/expected.ts" }, dependencies: ["catalog"] });
    writePackage(join(repo, "catalog/office.ts"), definitionText(`{setup(c){c.registry(items)},
      commands:{measure:{summary:"measure",run(i){console.log(i.read(items)[0].value.unit)}}}}`, `import {items,unit} from "./exports/items.ts";import {expected} from "@office/alpha/expected";
      if(expected!==unit)throw Error("incompatible revisions");`), { exports: { "./items": "./exports/items.ts" }, dependencies: ["alpha"] });
    contract("metres");
    const first = commit(repo);
    select(order.map(name => `  - {name: ${name}, repo: ${repo}, ref: ${first}, path: ${name}, track: main${name === "alpha" ? ", settings: {enabled: true}" : ""}}\n`).join(""));
    cli(0, "sync", "--packages");
    expect(cli(0, "measure")).toContain("metres");
    contract("seconds");
    write(join(repo, "alpha/exports/expected.ts"), `export const expected="seconds"`);
    commit(repo);
    cli(0, "packages", "update");
    expect(cli(0, "measure")).toContain("seconds");
    const snapshot = join(dir, ".office/resolved/references.json");
    const published = read(snapshot);
    cli(0, "sync", "--packages");
    expect(read(snapshot)).toBe(published);
  }, 60_000);
}

test("a suspended reader retains its generation beyond the previous set", async () => {
  const { dir, cli, env, select } = fixture("leased-reader");
  const repo = join(root, "leased-reader-source");
  git(["init", "-qb", "main", repo]);
  writePackage(join(repo, "pkg/office.ts"), definitionText(`{commands:{"read edition":{summary:"Edition",async run(){
      if(process.env.WAIT_FOR_FLIPS){console.log("ready");await Bun.stdin.text()}
      console.log(readFileSync(new URL("./edition",import.meta.url),"utf8"))
    }}}}`, `import {readFileSync} from "node:fs";`), { name: "leased" });

  const pin = (value: string) => {
    write(join(repo, "pkg/edition"), value);
    select(`  - {name: leased, path: pkg, repo: ${repo}, ref: ${commit(repo)}}\n`);
    cli(0, "sync", "--packages");
  };

  pin("old");
  const active = join(dir, ".office/current");
  const old = join(dir, ".office", readlinkSync(active));
  const process = Bun.spawn([exe, "--office", dir, "read", "edition"], { env: { ...env, WAIT_FOR_FLIPS: "1" }, stdin: "pipe", stdout: "pipe", stderr: "inherit" });

  try {
    const output = process.stdout.getReader();
    expect(new TextDecoder().decode((await output.read()).value)).toContain("ready");

    for (const value of ["two", "three", "four"]) pin(value);
    expect(existsSync(old)).toBe(true);
    expect(cli(0, "read", "edition").trim()).toBe("four");
    process.stdin.end();
    let resumed = "";

    for (let next = await output.read(); !next.done; next = await output.read()) resumed += new TextDecoder().decode(next.value);
    expect(resumed.trim()).toBe("old");
    expect(await process.exited).toBe(0);
    cli(0, "sync", "--packages");
    expect(existsSync(old)).toBe(false);
    expect(readdirSync(join(dir, ".office/generations"))).toHaveLength(2);
  } finally { process.kill(); }
}, 60_000);
