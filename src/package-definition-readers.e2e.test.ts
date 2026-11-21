import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "./git.ts";
import { definitionFixture } from "./package-definition.fixture.ts";

const { root, exe, marker, write, read, commit, fixture } = definitionFixture();

for (const kind of ["local", "tracked"]) {
  test(`a newly shipped built-in cannot claim the ${kind} source during sync, update or refresh`, () => {
    const { dir, probe, select, cli, newer } = fixture(`collision-${kind}`);
    const repo = join(root, `collision-source-${kind}`);
    const pkg = kind === "local" ? join(dir, "packages/arrival") : join(repo, "arrival");
    const installed = kind === "local" ? pkg : join(dir, ".office/packages/arrival");
    const link = join(dir, ".opencode/plugins/arrival");
    write(join(pkg, "office.ts"), `${marker} export default {name:"arrival",description:"Original"}`);
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

test("published values survive repeated reads; failed registrations cannot admit dependent batches", () => {
  const { dir, cli, select } = fixture("collections");
  const path = (name: string) => join(dir, "packages", name, "office.ts");
  const contract = join(dir, "packages/catalog/items.ts");
  const author = 'import {items} from "../catalog/items.ts";export default {name:"alpha",description:"author",setup(c){c.add(items,{name:"first",count:1})}}';
  const provider = 'import {items} from "./items.ts";export default {name:"catalog",description:"provider",setup(c){c.collection(items);}}';
  select("  - {name: alpha}\n  - {name: beta}\n  - {name: catalog}\n");
  write(path("alpha"), author);
  write(path("catalog"), provider);
  write(contract, 'export const items={id:"catalog.items",parse(i){if(!Number.isFinite(i.count))throw Error("expected count");return {...i,count:i.count+1}}}');
  write(path("beta"), `export default {name:"beta",description:"reader",setup(c){c.command({name:"items",summary:"items",run(i){
    const handle={id:"catalog.items",parse(){throw Error("reader parser ran")}};
    const first=i.read(handle); if(first.length)first[0].value.count=99;console.log(JSON.stringify(i.read(handle)));
  }})}}`);
  cli(0, "sync", "--packages");
  expect(cli(0, "items")).toContain('"count":2');
  write(path("alpha"), 'throw Error("failed author")');
  cli(1, "sync", "--packages");
  expect(cli(0, "items")).toContain('"count":2');
  write(contract, 'export const items={id:"catalog.items",parse(i){if(typeof i.count!=="string")throw Error("expected text");return i}}');
  expect(cli(1, "sync", "--packages")).toContain("provider contract changed");
  expect(cli(0, "items")).toContain("[]");
  write(path("alpha"), author.replace("count:1", 'count:"valid"'));
  write(path("catalog"), provider.replace("c.collection(items);", 'c.collection(items);c.add(items,{name:"bad",count:1});'));
  expect(cli(1, "sync", "--packages")).toContain("provider of catalog.items failed");
  expect(cli(0, "items")).toContain("[]");
});

test.each(["file", "link"])("an external reader cannot consume an old publication through a changed provider %s", layout => {
  const { dir, cli, select } = fixture(`reader-contract-${layout}`);
  const packages = join(dir, "packages");
  const contract = join(packages, "catalog/items.ts");
  const writer = join(packages, "alpha/office.ts");
  const add = 'c.add(items,{name:"x",value:12});';
  const author = (body: string) => `import {items} from "../catalog/items.ts";export default {name:"alpha",description:"author",setup(c){${body}}}`;
  select("  - name: alpha\n  - name: catalog\n  - name: beta\n");
  const numeric = 'export const items={id:"catalog.items",parse:i=>i};export const display=i=>i.value.toFixed(0)';
  const text = 'export const items={id:"catalog.items",parse:i=>({...i,value:"v"+i.value})};export const display=i=>i.value.toUpperCase()';

  if (layout === "link") {
    write(join(dirname(contract), "numeric.ts"), numeric);
    write(join(dirname(contract), "text.ts"), text);
    symlinkSync("numeric.ts", contract);
  } else write(contract, numeric);

  write(join(packages, "catalog/office.ts"), 'import {items} from "./items.ts";export default {name:"catalog",description:"provider",setup(c){c.collection(items)}}');
  write(join(packages, "beta/office.ts"), `import {items,display} from "../catalog/items.ts";export default {name:"beta",description:"reader",
    setup(c){c.command({name:"display",summary:"display",run(i){console.log(i.read(items).map(row=>display(row.value)).join(",") || "empty")}})}}`);
  write(writer, author(add));
  cli(0, "sync", "--packages");
  expect(cli(0, "display")).toContain("12");
  const snapshot = join(dir, ".office/resolved/references.json");
  const previous = read(snapshot);

  if (layout === "link") {
    rmSync(contract);
    symlinkSync("text.ts", contract);
  } else write(contract, text);

  expect(cli(1, "display")).toMatch(/catalog\.items:.*published contract.*sync --packages/);

  // Only detecting the changed contract depends on the layout; the file variant covers recovery.
  if (layout === "link") return;
  write(writer, author(add + add));
  expect(cli(1, "sync", "--packages")).toContain("claimed by both");
  expect(read(snapshot)).toBe(previous);
  expect(cli(1, "display")).toMatch(/catalog\.items:.*published contract.*sync --packages/);
  write(writer, 'throw Error("writer unavailable")');
  expect(cli(1, "sync", "--packages")).toContain("omitting last-good catalog.items/x");
  expect(cli(0, "display")).toContain("empty");
  write(writer, author(add));
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
    write(consumer, `import {items,unit} from "@office/catalog/items";import {expected} from "./exports/expected.ts";
      if(unit!==expected)throw Error("incompatible revisions");
      export default {name:"alpha",description:"author",setup(c){if(c.booleanSetting("enabled",{default:false,description:"use catalog"})){
      c.add(items,{name:"sample"});}}}`);
    write(join(repo, "catalog/office.ts"), `import {items,unit} from "./exports/items.ts";import {expected} from "@office/alpha/expected";
      if(expected!==unit)throw Error("incompatible revisions");
      export default {name:"catalog",description:"provider",setup(c){
      c.collection(items);c.command({name:"measure",summary:"measure",run(i){console.log(i.read(items)[0].value.unit)}})}}`);
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

test("a suspended indexed reader retains its generation beyond the previous set", async () => {
  const { dir, cli, env, select } = fixture("leased-reader");
  const repo = join(root, "leased-reader-source");
  git(["init", "-qb", "main", repo]);
  write(join(repo, "pkg/office.ts"), `import {readFileSync} from "node:fs";
    export default {name:"leased",description:"Reader",setup(c){c.command({name:"read edition",summary:"Edition",async run(){
      if(process.env.WAIT_FOR_FLIPS){console.log("ready");await Bun.stdin.text()}
      console.log(readFileSync(new URL("./edition",import.meta.url),"utf8"))
    }})}}`);

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
