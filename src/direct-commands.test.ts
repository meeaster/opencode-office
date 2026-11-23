import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Registry, RegistryEntry } from "../sdk/index.ts";
import { repositories } from "../packages/references/repositories.ts";
import { setLinkProblem } from "./bound-paths.ts";
import { commandHelp, dispatchCommand } from "./direct-commands.ts";
import { gatherPackages, parseEntries, readEntries, type SetUp } from "./gather.ts";
import { loadOffice } from "./office.ts";
import type { Registered } from "./package-setup.ts";
import { fileHashes, type ResolvedPackage, selectionProblems } from "./packages.ts";
import { packageJsonHint } from "./package-manifest.ts";
import { recordRequiredBuiltins } from "./test-builtin-record.ts";
import { definitionText, settingsSchema, writePackage } from "./test-package.ts";

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
  writePackage(join(dir, "packages", name, "office.ts"), definition);

  return { entry: { name, settings, source: undefined }, kind: "local", dir: join(dir, "packages", name) };
}

/** A synced office (its required built-ins as fixtures) selecting `entries`, each a package with its definition body and settings. */
function office(packages: Record<string, { body: string; prelude?: string; settings?: string }>) {
  write(join(dir, "office.yaml"), `name: paper\npackages:\n${Object.entries(packages).map(([name, { settings }]) => `  - name: ${name}\n${settings ? `    settings: ${settings}\n` : ""}`).join("")}`);
  recordRequiredBuiltins(dir);

  for (const [name, { body, prelude }] of Object.entries(packages)) writePackage(join(dir, "packages", name, "office.ts"), definitionText(body, prelude));
}

/** What the package commands printed. */
async function printed(words: string[]) {
  const lines: string[] = [];
  const log = console.log;

  console.log = (...parts: string[]) => lines.push(parts.join(" "));

  try {
    expect(await dispatchCommand({ dir }, words)).toEqual({ found: true });
  } finally {
    console.log = log;
  }

  return lines;
}

/** A prelude whose `mark()` leaves a marker file for package `name`, under $OFFICE_TEST_MARKER. */
const marker = (name: string) => `import {appendFileSync} from "node:fs"; const mark = () => appendFileSync(process.env.OFFICE_TEST_MARKER + ${JSON.stringify(`-${name}`)}, "set up\\n");`;

test("a definition's commands run by name or alias with its settings as office.yaml has them, and help lists them, with or without a setup", async () => {
  const label = settingsSchema({ label: "plain" });

  office({
    notes: { body: `{settings:${label},commands:{"notes list":{summary:"List notes",aliases:["notes ls"],run({settings}){console.log("label:" + settings.label)}}}}` },
  });

  expect(await commandHelp({ dir })).toContain("  notes list | notes ls    List notes");
  expect(await printed(["notes", "ls"])).toEqual(["label:plain"]);
  write(join(dir, "office.yaml"), readFileSync(join(dir, "office.yaml"), "utf8").replace("  - name: notes\n", "  - name: notes\n    settings: {label: edited}\n"));
  expect(await printed(["notes", "list"])).toEqual(["label:edited"]);
});

test("the longest declared name or alias starting the words runs, with the rest as its arguments as given, and its office's folder", async () => {
  const echo = (name: string) => `run({args, office}){console.log(${JSON.stringify(name)}, JSON.stringify(args), office.dir)}`;

  office({
    notes: { body: `{commands:{"notes":{summary:"Notes",${echo("notes")}},"notes show":{summary:"Show a note",usage:"<path>",aliases:["notes cat"],${echo("show")}}}}` },
  });

  expect(await printed(["notes", "show", "a/b.md", "--raw"])).toEqual([`show ["a/b.md","--raw"] ${dir}`]);
  expect(await printed(["notes", "cat", "my notes/a b.md"])).toEqual([`show ["my notes/a b.md"] ${dir}`]);
  expect(await printed(["notes", "show"])).toEqual([`show [] ${dir}`]);
  expect(await printed(["notes", "showing"])).toEqual([`notes ["showing"] ${dir}`]);
  expect(await dispatchCommand({ dir }, ["note", "show"])).toEqual({ found: false, failures: [] });
  expect(await commandHelp({ dir })).toEqual(["  notes    Notes", "  notes show <path> | notes cat <path>    Show a note"]);
});

test("two packages may declare a name and a longer one starting with it; two declaring one folder committed fails the gathering naming both", async () => {
  office({
    short: { body: '{commands:{"notes":{summary:"Notes",run({args}){console.log("short", args.join(","))}}},committed:[".office/notes/"]}' },
    long: { body: '{commands:{"notes show":{summary:"Show",run({args}){console.log("long", args.join(","))}}},committed:[".office/notes/",".office/alpha/"]}' },
  });

  const gathered = await gatherPackages(loadOffice(dir));

  expect(gathered.names).toEqual([]);
  expect(gathered.committed).toEqual([".office/alpha/", ".office/notes/"]);
  expect(gathered.problems).toEqual([{ packages: ["short", "long"], named: true, message: ".office/notes/ is declared committed by both package short and package long" }]);
  expect(gathered.complete).toBe(false);
});

test("a committed folder that isn't one plain folder under .office/, or is one office keeps, fails its package's load naming it", async () => {
  const paths = ["notes/", ".office/generations/", ".office/Packages/", ".office/a/b/", ".office/*/", ".office/notes"];

  office(Object.fromEntries(paths.map((path, index) => [`p${index}`, { body: `{committed:[${JSON.stringify(path)}]}` }])));
  const { problems } = await gatherPackages(loadOffice(dir));

  expect(problems.map(({ packages, message }) => [packages, message])).toEqual(paths.map((path, index) => [[`p${index}`], expect.stringContaining(JSON.stringify(path))]));
});

test("a package that can't load fails with its reason, and the others' commands are still listed", async () => {
  office({
    module: { body: "{}", prelude: 'throw Error("module failed");' },
    setup: { body: '{setup(){throw Error("setup failed")}}' },
    removed: { body: '{setup(c){c.booleanSetting("on",{default:true,description:"On"})}}' },
    ink: { body: '{commands:{"ink show":{summary:"Show",run(){}}}}' },
  });

  const help = await commandHelp({ dir });

  expect(help).toContain("  ink show    Show");
  expect(help).toContainEqual(expect.stringMatching(/^ {2}package module: .*packages\/module\/office\.ts: module failed$/));
  expect(help).toContain("  package setup: setup failed");
  // A removed setup call is a call to something that isn't there, named with the package.
  expect(help).toContainEqual(expect.stringMatching(/^ {2}package removed: .*booleanSetting/));
  await expect(dispatchCommand({ dir }, ["ink", "show"])).rejects.toThrow("package setup: setup failed");
});

test("with any package's settings invalid no setup runs: a command fails naming them, and help lists every declared command and the problem", async () => {
  const markers = join(dir, "marker");

  process.env.OFFICE_TEST_MARKER = markers;

  try {
    office({
      first: { body: '{setup(){mark()},commands:{"first show":{summary:"Show first",run(){}}}}', prelude: marker("first") },
      second: { body: `{settings:${settingsSchema({ port: 4566 })},setup(){mark()},commands:{"second show":{summary:"Show second",run(){}}}}`, prelude: marker("second"), settings: '{port: "4600"}' },
    });

    const help = await commandHelp({ dir });

    expect(help).toEqual(["  first show    Show first", "  second show    Show second", "  package second: packages.second.settings.port: must be integer"]);
    await expect(dispatchCommand({ dir }, ["first", "show"])).rejects.toThrow("first show: package second: packages.second.settings.port: must be integer");
    expect(existsSync(`${markers}-first`)).toBe(false);
    expect(existsSync(`${markers}-second`)).toBe(false);
    // Valid again, every setup runs.
    write(join(dir, "office.yaml"), readFileSync(join(dir, "office.yaml"), "utf8").replace('{port: "4600"}', "{port: 4600}"));
    await dispatchCommand({ dir }, ["first", "show"]);
    expect([existsSync(`${markers}-first`), existsSync(`${markers}-second`)]).toEqual([true, true]);
  } finally {
    delete process.env.OFFICE_TEST_MARKER;
  }
});

test("a settings schema whose root isn't an object, or that doesn't compile, stops every setup; the commands are still listed", async () => {
  const markers = join(dir, "marker");

  process.env.OFFICE_TEST_MARKER = markers;

  try {
    office({
      first: { body: '{setup(){mark()},commands:{"first show":{summary:"Show first",run(){}}}}', prelude: marker("first") },
      listed: { body: '{settings:{type:"array"},commands:{"listed show":{summary:"Show listed",run(){}}}}' },
      broken: { body: '{settings:{type:"object",properties:{port:{type:"nope"}}},commands:{"broken show":{summary:"Show broken",run(){}}}}' },
    });

    const help = await commandHelp({ dir });

    expect(help.slice(0, 4)).toEqual(["  first show    Show first", "  listed show    Show listed", "  broken show    Show broken", '  package listed: packages/listed/office.ts: settings: its root must have type: "object"']);
    expect(help[4]).toStartWith("  package broken: packages/broken/office.ts: settings: schema is invalid");
    await expect(dispatchCommand({ dir }, ["first", "show"])).rejects.toThrow("package listed: packages/listed/office.ts: settings: its root must have type");
    expect(existsSync(`${markers}-first`)).toBe(false);
  } finally {
    delete process.env.OFFICE_TEST_MARKER;
  }
});

test("settings that aren't a JSON mapping (null included) stop every setup; each package's commands are still listed", async () => {
  const markers = join(dir, "marker");
  const malformed = { nulled: "null", off: "false", number: "3", text: '"object"', list: '[{type:"object"}]', unjson: '{type:"object",default:()=>({})}' };

  process.env.OFFICE_TEST_MARKER = markers;

  try {
    office({
      first: { body: '{setup(){mark()},commands:{"first show":{summary:"Show first",run(){}}}}', prelude: marker("first") },
      ...Object.fromEntries(Object.entries(malformed).map(([name, settings]) => [name, { body: `{settings:${settings},setup(){mark()},commands:{"${name} show":{summary:"Show ${name}",run(){}}}}`, prelude: marker(name) }])),
    });

    const help = await commandHelp({ dir });
    const names = Object.keys(malformed);

    expect(help).toEqual([
      "  first show    Show first",
      ...names.map(name => `  ${name} show    Show ${name}`),
      ...names.map(name => `  package ${name}: packages/${name}/office.ts: settings: must be a JSON Schema object`),
    ]);
    await expect(dispatchCommand({ dir }, ["first", "show"])).rejects.toThrow("package nulled: packages/nulled/office.ts: settings: must be a JSON Schema object");
    expect(["first", ...names].filter(name => existsSync(`${markers}-${name}`))).toEqual([]);
  } finally {
    delete process.env.OFFICE_TEST_MARKER;
  }
});

test("a package that fails a check after its definition loaded keeps its commands, and fails alone", async () => {
  office({
    service: { body: '{host:{services:{svc:{description:"Service",script:"missing.sh"}}},commands:{"service show":{summary:"Show service",run(){}}}}' },
    skilled: { body: '{commands:{"skilled show":{summary:"Show skilled",run(){}}}}' },
    ink: { body: '{setup(){},commands:{"ink show":{summary:"Show ink",run(){console.log("ink shown")}}}}' },
  });
  // skills/ that isn't a folder can't be listed.
  write(join(dir, "packages/skilled/skills"), "");

  const help = await commandHelp({ dir });

  expect(help.slice(0, 3)).toEqual(["  service show    Show service", "  skilled show    Show skilled", "  ink show    Show ink"]);
  expect(help).toContain("  package service: service: host.services.svc: missing.sh must be a file inside the package");
  expect(help).toContainEqual(expect.stringMatching(/^ {2}package skilled: packages\/skilled\/office\.ts: .*ENOTDIR/));
  await expect(dispatchCommand({ dir }, ["service", "show"])).rejects.toThrow("service show: package service: service: host.services.svc");
});

test("a selected package named sdk loads nothing, and is named once", async () => {
  const imported = join(dir, "imported");

  office({ ink: { body: '{commands:{"ink show":{summary:"Show ink",run(){}}}}', prelude: `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(imported)}, "x");` } });
  write(join(dir, "office.yaml"), `${readFileSync(join(dir, "office.yaml"), "utf8")}  - name: sdk\n`);
  const reserved = "package sdk: the name sdk is reserved for @office/sdk; rename the package";

  expect(await commandHelp({ dir })).toEqual([`  ${reserved}`]);
  await expect(dispatchCommand({ dir }, ["ink", "show"])).rejects.toThrow(`no package loaded: ${reserved}`);
  expect(existsSync(imported)).toBe(false);
});

test("a selected built-in whose ownership is in conflict loads nothing: no other package can import its copy", async () => {
  const imported = join(dir, "imported");

  office({ ink: { body: '{commands:{"ink show":{summary:"Show ink",run(){}}}}', prelude: `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(imported)}, "x");` } });
  mkdirSync(join(dir, "packages/references"));
  const conflict = "package references: built-in package references conflicts with local packages/references; rename one before syncing";

  const help = await commandHelp({ dir });

  expect(existsSync(imported)).toBe(false);
  expect(help).toEqual([`  ${conflict}`]);
  await expect(dispatchCommand({ dir }, ["ink", "show"])).rejects.toThrow(`no package loaded: ${conflict}`);
  expect(existsSync(imported)).toBe(false);
});

test("a command reads a contributed system recipe without its bootstrap file; only a gathering for the machine reads that file", async () => {
  writePackage(join(dir, ".office/packages/mise-integration/office.ts"), definitionText('{setup(c){c.registry({id: "mise-integration.recipes", parse: i => i})}}'));
  const recipe = { name: "giver", setting: "system", description: "Giver", platforms: ["ubuntu-24.04-amd64-wsl"], bootstrap: "system/bootstrap.toml", ready: ["/opt/giver"], env: {} };
  const settings = '{type:"object",additionalProperties:false,properties:{system:{type:"boolean",default:false}}}';

  office({ giver: { body: `{settings:${settings},setup(c){c.add({id: "mise-integration.recipes"}, ${JSON.stringify(recipe)})},commands:{"giver show":{summary:"Show",run({entries}){for (const e of entries({id: "mise-integration.recipes"})) console.log(e.value.name, e.value.bootstrap)}}}}` } });

  expect(await printed(["giver", "show"])).toEqual(["giver system/bootstrap.toml"]);
  expect((await gatherPackages(loadOffice(dir), { machine: true })).problems).toEqual([{ packages: ["giver"], message: "system/bootstrap.toml must be a file inside package giver" }]);
});

test("a command claimed twice is reported with the packages that failed", async () => {
  office({
    notes: { body: '{setup(){throw Error("setup failed")},commands:{"shared show":{summary:"Show",run(){}}}}' },
    pages: { body: '{commands:{"shared show":{summary:"Show",run(){}}}}' },
  });

  await expect(dispatchCommand({ dir }, ["shared", "show"])).rejects.toThrow("shared show: package notes: setup failed; command shared show claimed by both package notes and package pages");
});

test("every setup finishes before an entry is parsed, whatever the order; handles match by id; owners are names", async () => {
  write(join(dir, "packages/provider/items.ts"), 'import {Registry} from "@office/sdk"; export const finished = {count: 0}; export const items = Registry.define({id: "provider.items", parse(input) { return {...input, seen: finished.count}; }});');
  office({
    // The consumer is set up first and adds through its own handle object with the provider's id.
    consumer: { body: '{setup(c){finished.count++; c.add({id: "provider.items", parse: i => i}, {name: "entry"})}}', prelude: 'import {finished} from "../provider/items.ts";' },
    provider: { body: '{setup(c){finished.count++; c.registry(items)},commands:{"provider show":{summary:"Show",run({entries}){for (const e of entries(items)) console.log(JSON.stringify([e.value, e.owner]))}}}}', prelude: 'import {finished, items} from "./items.ts";' },
  });

  expect(await printed(["provider", "show"])).toEqual([JSON.stringify([{ name: "entry", seen: 2 }, "consumer"])]);
});

test("adding to a registry no selected package registered fails, naming the adder and the id; a handle is matched by its id alone", async () => {
  office({
    adder: { body: '{setup(c){c.add({id: "nobody.items"}, {name: "x"})},commands:{"adder show":{summary:"Show",run(){}}}}' },
  });

  await expect(dispatchCommand({ dir }, ["adder", "show"])).rejects.toThrow("package adder: no provider registered nobody.items");

  // An incomplete gathering's read throws, rather than answering with what did register.
  const gathered = await gatherPackages(loadOffice(dir));

  expect(gathered.complete).toBe(false);
  expect(() => gathered.entries({ id: "nobody.items", parse: (input: RegistryEntry) => input })).toThrow("cannot read nobody.items: the packages' registrations are incomplete: package adder: no provider registered nobody.items");
});

test("a value that isn't a JSON object, such as one holding a function, fails the run naming the adder and the registry", async () => {
  office({
    adder: { body: '{setup(c){c.registry(items); c.add(items, {name: "x", run() {}})},commands:{"adder show":{summary:"Show",run(){}}}}', prelude: 'const items = {id: "adder.items", parse: i => i};' },
  });

  await expect(dispatchCommand({ dir }, ["adder", "show"])).rejects.toThrow("package adder: adder.items: an entry must be a JSON object");
});

test("the selection is checked without importing: rejected, uncopied and edited copies, package.json and declared dependencies, @office/sdk among them", () => {
  const pulled = (name: string): ResolvedPackage => ({ entry: { name, settings: {}, source: undefined }, kind: "built-in", dir: join(dir, ".office/packages", name) });
  const marker = `import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(join(dir, "imported"))}, "x");`;
  writePackage(join(dir, ".office/packages/rejected/office.ts"), marker);
  writePackage(join(dir, ".office/packages/recorded/office.ts"), marker);
  writeFileSync(join(dir, ".office/packages/recorded/.source.json"), JSON.stringify({ office: "fixture", commit: "fixture", files: fileHashes(join(dir, ".office/packages/recorded")) }));
  const clean = [pulled("recorded"), local("consumer", marker), local("needs", marker)];
  // office.yaml selects, not what resolved: "broken" is selected even though it failed resolution.
  const office = { packages: ["recorded", "consumer", "needs", "broken", "absent"].map(name => ({ name, settings: {}, source: undefined })) };
  writePackage(join(dir, "packages/needs/office.ts"), marker, { dependencies: ["references", "consumer", "broken"] });

  expect(selectionProblems(office, clean)).toEqual([]);
  writePackage(join(dir, "packages/needs/office.ts"), marker, { dependencies: ["references", "missing", "sdk"] });
  write(join(dir, ".office/packages/recorded/office.ts"), `${marker}// edited`);
  rmSync(join(dir, "packages/consumer/package.json"));

  // A skipped package isn't checked: the gate names a rejected one on its own.
  expect(selectionProblems(office, [...clean, pulled("rejected"), pulled("absent")], new Set(["rejected"])).map(problem => [problem.packages, problem.message])).toEqual([
    [["recorded"], "package files edited: office.ts (edited); office sync restores them"],
    [["consumer"], `no package.json; ${packageJsonHint("consumer")}`],
    [["needs"], "depends on @office/missing, which isn't selected; add it to office.yaml"],
    [["needs"], "lists @office/sdk in office.dependencies; @office/sdk is always available, so remove it"],
    [["absent"], "not synced yet; run office sync"],
  ]);
  expect(existsSync(join(dir, "imported"))).toBe(false);
});

test("in a bound reader, a package the set has no link for, or a wrong link, is a problem", () => {
  const set = join(dir, ".office/generations/g-1");
  const item = local("added", "export default {}");
  local("other", "export default {}");
  mkdirSync(join(set, "node_modules/@office"), { recursive: true });

  expect(setLinkProblem(set, item)).toBe("selected since the last sync; run office sync");
  symlinkSync(join(dir, "packages/other"), join(set, "node_modules/@office/added"));
  expect(setLinkProblem(set, item)).toBe("the package set links it to a different folder; run office sync");
  rmSync(join(set, "node_modules/@office/added"));
  symlinkSync(join(dir, "packages/added"), join(set, "node_modules/@office/added"));
  expect(setLinkProblem(set, item)).toBeUndefined();
});

const registered = (part: Partial<Registered>): Registered => ({ registries: new Map(), additions: [], ...part });
const provider = (handle: Registry<RegistryEntry>) => registered({ registries: new Map([[handle.id, handle]]) });
const references = registered({ registries: new Map([[repositories.id, repositories]]) });
const setUp = (name: string, part: Registered): SetUp => ({ name, folder: `/set/${name}`, registered: part });
const own = (references: { name: string; url: string }[]) => ({ dir: "/office", references });
const add = (id: string, ...values: RegistryEntry[]) => registered({ additions: values.map(value => ({ id, value })) });
const messages = (load: ReturnType<typeof parseEntries>) => load.problems.map(problem => [problem.packages, problem.message]);

test("reads list office.yaml's references first, then each package's, parsed once and copied per read", () => {
  let parsed = 0;

  const items = {
    id: "catalog.items",
    parse(input: RegistryEntry) {
      parsed++;

      return { ...input, count: Number(input.count) + 1 };
    },
  };

  const load = parseEntries(own([{ name: "own", url: "o" }]), [
    setUp("references", references),
    setUp("catalog", provider(items)),
    setUp("alpha", registered({ additions: [{ id: "catalog.items", value: { name: "first", count: 1 } }, { id: repositories.id, value: { name: "docs", url: "d" } }] })),
  ]);

  expect(load.problems).toEqual([]);
  expect(readEntries(load.entries, repositories)).toEqual([
    { value: { name: "own", url: "o" }, owner: "office.yaml", folder: "/office" },
    { value: { name: "docs", url: "d" }, owner: "alpha", folder: "/set/alpha" },
  ]);
  const first = readEntries(load.entries, items);
  first[0].value.count = 99;
  // A reader's own handle has another parser; reads never run it.
  expect(readEntries(load.entries, { id: "catalog.items", parse(): RegistryEntry { throw new Error("reader parser ran"); } })).toEqual([{ value: { name: "first", count: 2 }, owner: "alpha", folder: "/set/alpha" }]);
  expect(parsed).toBe(1);
});

test("an addition one's parser refuses fails that package; a reference without a name is refused by its parser", () => {
  const strict = { id: "catalog.items", parse(): RegistryEntry { throw new Error("expected count"); } };

  expect(messages(parseEntries(own([]), [setUp("catalog", provider(strict)), setUp("beta", add("catalog.items", { name: "y" }))]))).toEqual([[["beta"], "expected count"]]);
  expect(messages(parseEntries(own([]), [setUp("references", references), setUp("beta", add(repositories.id, { url: "https://example.com/x.git" }))]))).toEqual([[["beta"], "a reference needs a name"]]);
});

test("a registry's key: two owners clash, office.yaml counts as one, a package scope keeps keys per package, and no key accepts equal entries", () => {
  const notes = { id: "catalog.notes", key: (entry: RegistryEntry) => String(entry.name), keyScope: "package" as const, parse: (input: RegistryEntry) => input };
  const plain = { id: "catalog.plain", parse: (input: RegistryEntry) => input };
  const shared = { id: "catalog.shared", key: (entry: RegistryEntry) => String(entry.name), parse: (input: RegistryEntry) => input };

  const load = parseEntries(own([{ name: "floci", url: "u" }]), [
    setUp("references", references),
    setUp("catalog", registered({ registries: new Map<string, Registry<RegistryEntry>>([[notes.id, notes], [plain.id, plain], [shared.id, shared]]) })),
    setUp("alpha", registered({ additions: [{ id: repositories.id, value: { name: "floci", url: "u" } }, { id: notes.id, value: { name: "bun" } }, { id: shared.id, value: { name: "docs" } }, { id: plain.id, value: { destination: "~/a", source: "s" } }] })),
    setUp("beta", registered({ additions: [{ id: notes.id, value: { name: "bun" } }, { id: notes.id, value: { name: "bun" } }, { id: shared.id, value: { name: "docs" } }, { id: plain.id, value: { destination: "~/a", source: "s" } }] })),
  ]);

  expect(messages(load)).toEqual([
    [["alpha"], "references.repository floci claimed by both office.yaml and package alpha"],
    [["beta"], "catalog.notes bun added twice by package beta"],
    [["alpha", "beta"], "catalog.shared docs claimed by both package alpha and package beta"],
  ]);
  // An entry without a name, in a registry without a key: both equal entries are read.
  expect(readEntries(load.entries, plain).map(entry => [entry.value, entry.owner])).toEqual([[{ destination: "~/a", source: "s" }, "alpha"], [{ destination: "~/a", source: "s" }, "beta"]]);
});

test("a key that isn't text, a key that throws, a parser that returns something other than JSON, and a key two packages add each fail the run, naming the registry", async () => {
  // Plain JavaScript, as a package can write it: no type stops these.
  office({
    catalog: { body: '{setup(c){c.registry(numbered);c.registry(throwing);c.registry(functional);c.registry(shared)},commands:{"catalog show":{summary:"Show",run(){}}}}', prelude: 'export const numbered = {id: "catalog.numbered", key: e => e.count, parse: i => i}; export const throwing = {id: "catalog.throwing", key() { throw Error("no key"); }, parse: i => i}; export const functional = {id: "catalog.functional", parse: i => ({...i, run() {}})}; export const shared = {id: "catalog.shared", key: e => e.name, parse: i => i};' },
    alpha: { body: '{setup(c){c.add({id: "catalog.numbered"}, {count: 1}); c.add({id: "catalog.shared"}, {name: "docs"})}}' },
    beta: { body: '{setup(c){c.add({id: "catalog.throwing"}, {name: "x"}); c.add({id: "catalog.shared"}, {name: "docs"})}}' },
    gamma: { body: '{setup(c){c.add({id: "catalog.functional"}, {name: "x"})}}' },
  });

  const failure = await dispatchCommand({ dir }, ["catalog", "show"]).then(() => "", (error: Error) => error.message);
  expect(failure).toContain("package gamma: catalog.functional: its parser returned something other than a JSON object");
  expect(failure).toContain("package alpha: catalog.numbered: its key returned something other than text");
  expect(failure).toContain("package beta: catalog.throwing: its key failed: no key");
  expect(failure).toContain("catalog.shared docs claimed by both package alpha and package beta");
});

test("a key runs on a copy of the entry, and a result that isn't text is refused without being read", () => {
  // A BigInt can't be serialized, and a proxy throws when anything inspects it. Object() types
  // them as anything, as plain JavaScript would.
  const hostile = new Proxy({}, { get() { throw new Error("result inspected"); } });
  const big = { id: "catalog.big", key: (): string => Object(1n).valueOf(), parse: (input: RegistryEntry) => input };
  const trap = { id: "catalog.trap", key: (): string => Object(hostile), parse: (input: RegistryEntry) => input };

  const editing = {
    id: "catalog.editing",
    key(entry: RegistryEntry) {
      entry.name = "changed";

      return "fixed";
    },
    parse: (input: RegistryEntry) => input,
  };

  const load = parseEntries(own([]), [
    setUp("catalog", registered({ registries: new Map<string, Registry<RegistryEntry>>([[big.id, big], [trap.id, trap], [editing.id, editing]]) })),
    setUp("alpha", add(big.id, { name: "a" })),
    setUp("beta", add(trap.id, { name: "b" })),
    setUp("gamma", add(editing.id, { name: "kept" })),
  ]);

  expect(messages(load)).toEqual([
    [["alpha"], "catalog.big: its key returned something other than text"],
    [["beta"], "catalog.trap: its key returned something other than text"],
  ]);
  expect(readEntries(load.entries, editing).map(entry => entry.value)).toEqual([{ name: "kept" }]);
});
