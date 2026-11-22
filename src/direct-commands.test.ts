import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Collection, CollectionEntry } from "../packages/office/package-context.ts";
import { repositories } from "../packages/references/repositories.ts";
import { combine, loadPackage } from "./direct-commands.ts";
import { loadOffice } from "./office.ts";
import type { Registered } from "./package-setup.ts";
import type { ResolvedPackage } from "./packages.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-commands-"));
  writeFileSync(join(dir, "office.yaml"), "name: paper\n");
});

afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** A local package in its own folder (Bun caches a required office.ts by path). */
function local(name: string, definition: string, settings: ResolvedPackage["entry"]["settings"] = {}): ResolvedPackage {
  write(join(dir, "packages", name, "office.ts"), definition);

  return { entry: { name, settings, cron: {}, source: undefined }, kind: "local", dir: join(dir, "packages", name) };
}

const load = (item: ResolvedPackage, unavailable: string[] = []) => loadPackage(loadOffice(dir), item, new Set(unavailable));

test("a package that can't load fails with its reason: module, setup or setting", async () => {
  const labelled = 'settings:{label:{description:"Label",default:"x"}},setup(ctx){ctx.command({name:"ink show",summary:"Show",run(){}})}';

  await expect(load(local("module", 'throw Error("module failed")'))).rejects.toThrow("packages/module/office.ts: module failed");
  await expect(load(local("setup", 'export default {name:"setup",description:"d",setup(){throw Error("setup failed")}}'))).rejects.toThrow("setup failed");
  await expect(load(local("unknown", `export default {name:"unknown",description:"d",${labelled}}`, { colour: "red" }))).rejects.toThrow("settings.colour");
  await expect(load(local("typed", `export default {name:"typed",description:"d",${labelled}}`, { label: [1] }))).rejects.toThrow("settings.label");
  await expect(load(local("command", 'export default {name:"command",description:"d",setup(ctx){ctx.command({name:"Bad",summary:"s",run(){}})}}'))).rejects.toThrow('invalid route "Bad"');

  const ok = await load(local("ok", `export default {name:"ok",description:"d",${labelled}}`, { label: "y" }));
  expect(ok?.commands.map(command => command.name)).toEqual(["ink show"]);
  expect(await load(local("plain", 'export default {name:"plain",description:"d"}'))).toBeUndefined();
});

test("a pulled-in package the last sync rejected, or with no copy yet, doesn't load and says to sync", async () => {
  const pulled = (name: string): ResolvedPackage => ({ entry: { name, settings: {}, cron: {}, source: undefined }, kind: "built-in", dir: join(dir, ".office/packages", name) });
  write(join(dir, ".office/packages/rejected/office.ts"), 'throw Error("loaded")');

  await expect(load(pulled("rejected"), ["rejected"])).rejects.toThrow("rejected by the last sync; run office sync");
  await expect(load(pulled("absent"))).rejects.toThrow("not synced yet; run office sync");
  await expect(load(pulled("rejected"))).rejects.toThrow("no readable .source.json");
});

const registered = (part: Partial<Registered>): Registered => ({ collections: new Map(), additions: [], commands: [], invalid: [], scalars: {}, ...part });
const provider = (handle: Collection<CollectionEntry>) => registered({ collections: new Map([[handle.id, handle]]) });
const references = registered({ collections: new Map([[repositories.id, repositories]]) });

test("reads list office.yaml's references first, then each package's, parsed once and copied per read", () => {
  let parsed = 0;

  const items = {
    id: "catalog.items",
    parse(input: CollectionEntry) {
      parsed++;

      return { ...input, count: Number(input.count) + 1 };
    },
  };

  const load = combine([{ name: "own", url: "o" }], [
    { name: "references", registered: references },
    { name: "catalog", registered: provider(items) },
    { name: "alpha", registered: registered({ additions: [{ id: "catalog.items", value: { name: "first", count: 1 } }, { id: repositories.id, value: { name: "docs", url: "d" } }] }) },
  ]);

  expect(load.failures).toEqual([]);
  expect(load.read(repositories)).toEqual([
    { value: { name: "own", url: "o" }, owner: "office.yaml", stale: false },
    { value: { name: "docs", url: "d" }, owner: "package alpha", stale: false },
  ]);
  const first = load.read(items);
  first[0].value.count = 99;
  // A reader's own handle has another parser; reads never run it.
  expect(load.read({ id: "catalog.items", parse(): CollectionEntry { throw new Error("reader parser ran"); } })).toEqual([{ value: { name: "first", count: 2 }, owner: "package alpha", stale: false }]);
  expect(parsed).toBe(1);
});

test("an addition with no provider, or one its parser refuses, fails that package and drops its commands", () => {
  const strict = { id: "catalog.items", parse(): CollectionEntry { throw new Error("expected count"); } };
  const command = { name: "beta show", aliases: [], summary: "Show", run() {} };

  const load = combine([], [
    { name: "catalog", registered: provider(strict) },
    { name: "alpha", registered: registered({ additions: [{ id: "missing.items", value: { name: "x" } }] }) },
    { name: "beta", registered: registered({ additions: [{ id: "catalog.items", value: { name: "y" } }], commands: [command] }) },
  ]);

  expect(load.failures).toEqual(["package alpha: no provider registered missing.items", "package beta: expected count"]);
  expect(load.commands).toEqual([]);
});

test("a name claimed twice conflicts, unless its collection keeps names per package", () => {
  const scoped = { id: "catalog.notes", identity: "package" as const, parse: (input: CollectionEntry) => input };
  const add = (id: string, name: string) => registered({ additions: [{ id, value: { name, url: "u" } }] });

  const load = combine([{ name: "docs", url: "u" }], [
    { name: "references", registered: references },
    { name: "catalog", registered: provider(scoped) },
    { name: "alpha", registered: add(repositories.id, "docs") },
    { name: "beta", registered: add("catalog.notes", "same") },
    { name: "gamma", registered: add("catalog.notes", "same") },
  ]);

  expect(load.conflicts).toEqual(["reference docs claimed by both office.yaml and package alpha; select one claimant"]);
});
