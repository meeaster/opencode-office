import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "./git.ts";
import { definitionFixture } from "./package-definition.fixture.ts";
import { definitionText, writePackage } from "./test-package.ts";

const { root, exe, variant, marker, write, read, commit, fixture, collector } = definitionFixture();

test("consenting host sync and bound check agree on Browser's stable mise fragment", () => {
  const { dir, home, env, cli } = fixture("browser-mise");
  const config = join(dir, "office.yaml");
  const path = join(dir, ".office/mise/browser.toml");
  const stable = ".office/packages/browser";
  const browserLine = (output: string) => output.split("\n").find(line => /^(?:ok|FAIL)\s+package browser:/.test(line)) ?? "";

  write(config, JSON.stringify({
    name: "browser-mise",
    opencode: { mode: "host", url: "http://127.0.0.1:1" },
    tools: { sfw: { enabled: false } },
    packages: [{ name: "browser" }],
  }));
  write(env.OFFICE_MACHINE_RECORD, JSON.stringify({ office: { name: "browser-mise", dir }, consented: "fixture", files: [] }));
  // Only presence is checked. Don't actually install or invoke Browse.
  write(join(home, ".local/bin/browse"), "#!/bin/sh\nexit 1\n", 0o755);
  cli(0, "sync", "--packages");
  const original = read(path);
  const generation = readlinkSync(join(dir, ".office/current"));
  const generationPath = `.office/${generation}/packages/browser`;

  expect(original).toContain(`${stable}/scripts/install-browse.ts`);
  expect(original).not.toContain(".office/generations/");
  expect(readlinkSync(join(env.OFFICE_MISE_CONFIG_DIR, "conf.d/office-browser-mise-1-browser.toml"))).toBe(path);
  // Check exits 1 for unrelated host prerequisites in this fixture; require Browser itself to pass.
  expect(browserLine(cli(1, "check"))).toMatch(/^ok\s+package browser:.*mise setup in \.office\/mise\/browser\.toml/);

  utimesSync(path, 1, 1);
  expect(cli(0, "sync", "--packages")).toContain("already in sync");
  expect(statSync(path).mtimeMs).toBe(1000);
  expect(read(path)).toBe(original);
  expect(browserLine(cli(1, "check"))).toMatch(/^ok\s+package browser:.*mise setup in \.office\/mise\/browser\.toml/);

  // A genuinely wrong delivery path must still fail check, even if the generation still exists.
  write(path, original.replaceAll(stable, generationPath));
  expect(browserLine(cli(1, "check"))).toMatch(/^FAIL package browser:.*lacks or differs from the package's host install or system setup/);
  cli(0, "sync", "--packages");
  expect(read(path)).toBe(original);
  expect(browserLine(cli(1, "check"))).toMatch(/^ok\s+package browser:.*mise setup in \.office\/mise\/browser\.toml/);
});

test("sync doesn't publish while the references bridge is replaced, and sets it back only once the owner's file is moved aside", () => {
  const { dir, cli, select } = fixture("legacy-writer");
  const bridge = join(dir, ".office/resolved/references.json");
  const current = join(dir, ".office/current");
  const before = readlinkSync(current);
  const packages = join(dir, ".office/packages");
  const pkg = join(dir, "packages/notes/office.ts");
  const command = 'commands:{"notes bye":{summary:"bye",run(){console.log("updated")}}}';
  select("  - name: notes\n");
  // Simulate the old executable's atomic replacement during collection, after reservation.
  writePackage(pkg, definitionText(`{setup(ctx){
    writeFileSync(${JSON.stringify(`${bridge}.tmp`)}, "owner bytes"); renameSync(${JSON.stringify(`${bridge}.tmp`)}, ${JSON.stringify(bridge)})}, ${command}}`, `import {renameSync,writeFileSync} from "node:fs";`));
  expect(cli(1, "sync", "--packages")).toContain(bridge);
  expect(readlinkSync(current)).toBe(before);
  rmSync(packages);
  expect(cli(1, "notes", "bye")).toContain("move the conflicting entry aside");
  expect(existsSync(packages)).toBe(false);
  expect(read(bridge)).toBe("owner bytes");
  renameSync(bridge, `${bridge}.saved`);
  symlinkSync(`${bridge}.saved`, bridge);
  expect(cli(1, "sync", "--packages")).toContain(bridge);
  expect(readlinkSync(current)).toBe(before);
  rmSync(bridge);
  writePackage(pkg, definitionText(`{${command}}`));
  cli(0, "sync", "--packages");
  expect(readlinkSync(bridge)).toBe("../current/references.json");
  expect(readlinkSync(packages)).toBe("current/packages");
  expect(cli(0, "notes", "bye")).toContain("updated");
  expect(read(`${bridge}.saved`)).toBe("owner bytes");
});

test("recovery checks every discovery destination before rolling the pending journal forward", () => {
  const { dir, cli } = fixture("bridge-journal");
  const current = join(dir, ".office/current");
  const previous = readlinkSync(current).split("/")[1];
  cli(0, "sync", "--packages");
  const candidate = readlinkSync(current).split("/")[1];
  rmSync(current);
  symlinkSync(`generations/${previous}`, current);
  const journal = join(dir, ".office/publishing.json");
  const digest = new Bun.CryptoHasher("sha256").update(read(join(dir, "office.yaml"))).digest("hex");
  write(journal, JSON.stringify({ previous, candidate, before: digest, after: digest }));
  const bridge = join(dir, ".office/resolved/references.json");
  rmSync(bridge);
  write(join(bridge, "mine"), "keep");
  const packages = join(dir, ".office/packages");
  rmSync(packages);
  expect(cli(1, "sync", "--packages")).toContain(bridge);
  expect(readlinkSync(current)).toBe(`generations/${previous}`);
  expect(existsSync(packages)).toBe(false);
  expect(existsSync(journal)).toBe(true);
  renameSync(bridge, `${bridge}.saved`);
  cli(0, "references", "list");
  expect(readlinkSync(bridge)).toBe("../current/references.json");
  expect(readlinkSync(packages)).toBe("current/packages");
  cli(0, "sync", "--packages");
  expect(read(join(current, "previous"))).toBe(candidate);
  expect(existsSync(journal)).toBe(false);
  expect(read(join(`${bridge}.saved`, "mine"))).toBe("keep");
});

test("checking out a tracked package tree blocks writers; switching back restores discovery and plugins", () => {
  const { dir, cli } = fixture("tracked-history");
  const yaml = join(dir, "office.yaml");
  write(yaml, "name: history\npackages: []\n");
  cli(0, "sync", "--packages");
  const packages = join(dir, ".office/packages");
  const current = join(dir, ".office/current");
  const before = readlinkSync(current);
  const saved = join(packages, "artifact-share/renderer");
  rmSync(packages);
  write(saved, "tracked renderer");
  write(join(dir, ".gitignore"), read(join(dir, ".gitignore")) + "\n/.office/\n");
  git(["add", "-f", ".office/packages"], dir);
  const legacy = commit(dir);
  git(["rm", "-qr", ".office/packages"], dir);
  commit(dir);
  git(["checkout", "-q", legacy], dir);
  expect(cli(1, "sync", "--packages")).toContain("tracked in Git");
  expect(read(saved)).toBe("tracked renderer");
  expect(readlinkSync(current)).toBe(before);
  git(["checkout", "-q", "-"], dir);
  expect(existsSync(packages)).toBe(false);
  write(yaml, "name: history\npackages: [{name: knowledge}]\n");
  cli(0, "sync", "--packages");
  expect(readlinkSync(packages)).toBe("current/packages");
  expect(realpathSync(join(dir, ".opencode/plugins/knowledge"))).toBe(realpathSync(join(packages, "knowledge/plugin")));
});

test("a symlinked office resolves public imports after it moves, and a definition reads assets beside it", () => {
  const { dir, run, select } = fixture("alias-seed");
  select("  - name: consumer\n  - name: provider\n");

  const definition = definitionText(`{commands:{"consumer show":{summary:"show",run(){console.log(requirements.id,token)}}}}`, `import {requirements} from "@office/tooling/requirements"; import {token} from "@office/provider/token";`);

  writePackage(join(dir, "packages/consumer/office.ts"), definition, { dependencies: ["provider", "tooling"] });
  writePackage(join(dir, "packages/provider/office.ts"), definitionText('{}'), { exports: { "./token": "./lib/token.ts" } });
  write(join(dir, "packages/provider/lib/token.ts"), 'import {readFileSync} from "node:fs"; export const token=readFileSync(new URL("../asset",import.meta.url),"utf8");');
  write(join(dir, "packages/provider/asset"), "source-relative");
  const nested = join(root, "deep/a/b");
  mkdirSync(dirname(nested), { recursive: true });
  renameSync(dir, nested);
  symlinkSync(nested, dir);
  run(exe, 0, "--office", dir, "sync", "--packages");
  const show = (path: string, status = 0) => run(exe, status, "--office", path, "consumer", "show");
  expect(show(dir)).toContain("tooling.requirements source-relative");
  // Help runs in the reader too, so a package that imports another's public export is listed.
  expect(run(exe, 0, "--office", dir, "--help")).toContain("consumer show    show");
  expect(run(exe, 0, "--office", dir)).toContain("consumer show    show");
  // A consumer that fails to load is named in help, and its command is unknown.
  const source = join(dir, "packages/consumer/office.ts");
  write(source, definition.replace("@office/tooling/requirements", "@office/tooling/private"));
  expect(show(dir, 2)).toContain("package consumer: ");
  expect(run(exe, 0, "--office", dir, "--help")).toMatch(/package consumer: .*@office\/tooling/);
  write(source, definition);
  rmSync(dir);
  renameSync(nested, dir);
  expect(show(dir)).toContain("tooling.requirements source-relative");
});

// src/reference-snapshot.test.ts covers reading and rewriting the previous release's saved file.
test("a new CLI runs a set whose built-in copies another executable wrote, until its own sync replaces them", () => {
  const f = fixture("executable-skew");
  f.newer(0, "sync", "--packages");
  // Each copy matches its own record, so the other executable's references package runs.
  expect(f.cli(0, "references", "list")).toContain("variant package handler");
  expect(f.cli(0, "--help")).toContain("references list");
  f.cli(0, "sync", "--packages");
  expect(f.cli(0, "references", "list")).not.toContain("variant package handler");
}, 60_000);

test("a package command runs from the packages as they are now: edits, settings, renames and aliases show without a sync", () => {
  const { dir, cli, select } = fixture("live");
  const ink = join(dir, "packages/ink");
  const repo = join(root, "press-source");
  const saved = join(dir, ".office/resolved/references.json");
  // The handler prints the setting it is given: office.yaml's value in this run.
  const route = (name: string, aliases: string[]) => `${JSON.stringify(name)}:{aliases:${JSON.stringify(aliases)}, summary:"Print edition", run:({settings}) => print(settings.label)}`;

  const module = (commands: string, body = "") => definitionText(`{
    settings:{type:"object",additionalProperties:false,properties:{label:{type:"string",default:"old"},paper:{type:"boolean",default:true}}},
    commands:{${commands}},
    setup(ctx) {if (ctx.settings.paper) ctx.add({id:"references.repository",parse:e=>e},{name:"paper",url:"local"}); ${body}}}`, `import {print} from "./edition.ts";`);

  writePackage(join(ink, "office.ts"), module(route("folio show", ["folio read"])));
  write(join(ink, "edition.ts"), 'export function print(label: string) { console.log("first:" + label) }');
  git(["init", "-q", repo]);
  writePackage(join(repo, "pkg/office.ts"), definitionText('{commands:{"issue read":{summary:"Print issue",run:edition}}}', 'import {edition} from "./edition.ts";'), { name: "press" });
  write(join(repo, "pkg/edition.ts"), 'export function edition(){console.log("from Git")}');
  const press = `  - {name: press, repo: ${repo}, ref: ${commit(repo)}, path: pkg}\n`;
  select(`${press}  - name: ink\n`);
  cli(0, "sync", "--packages");
  expect(cli(0, "issue", "read")).toContain("from Git");
  expect(cli(0, "--help")).toContain("folio show | folio read    Print edition");
  expect(cli(0, "references", "list")).toContain("paper\tlocal\tpackage ink");

  // Settings as office.yaml has them now, and the handler as edited.
  select(`${press}  - {name: ink, settings: {label: new, paper: false}}\n`);
  write(join(ink, "edition.ts"), 'export function print(label: string){console.log("edited:" + label)}');
  expect(cli(0, "folio", "read")).toContain("edited:new");
  expect(cli(0, "references", "list")).not.toContain("paper");

  // A renamed command, a new alias and a new entry; the old name is gone.
  select(`${press}  - {name: ink, settings: {label: new}}\n`);
  writePackage(join(ink, "office.ts"), module(route("folio print", ["folio out"]), 'ctx.add({id:"references.repository",parse:e=>e},{name:"ink-new",url:"added"});'));
  expect(cli(0, "references", "list")).toContain("ink-new\tadded\tpackage ink");
  expect(cli(0, "folio", "print")).toContain("edited:new");
  expect(cli(0, "folio", "out")).toContain("edited:new");
  expect(cli(2, "folio", "show")).toContain("Unknown command or options: folio show; see office --help\n");
  // A word with whitespace is never dispatched.
  expect(cli(2, "folio print")).toContain("Unknown command or options: folio print");

  // The saved file holds no command input: text that isn't JSON changes neither help nor a command.
  const listing = cli(0, "references", "list");
  const help = cli(0, "--help");
  const synced = read(saved);
  write(saved, "not json");
  expect(cli(0, "references", "list")).toBe(listing);
  expect(cli(0, "--help")).toBe(help);
  expect(cli(0)).toBe(help);
  write(saved, synced);

  // A failed package fails every command and is named; an unknown command names it too.
  writePackage(join(ink, "office.ts"), module(route("folio print", []), 'throw Error("ink setup failed")'));
  const failed = cli(1, "issue", "read");
  expect(failed).toMatch(/package ink: .*ink setup failed/);
  expect(failed).not.toContain("from Git");
  // Its own declared command is found, and fails the same way.
  expect(cli(1, "folio", "print")).toMatch(/package ink: .*ink setup failed/);
  expect(cli(0, "--help")).toMatch(/issue read    Print issue\n[\s\S]*package ink: .*ink setup failed/);

  // A package that isn't always selected: deselected, its command is unknown at once.
  writePackage(join(ink, "office.ts"), module(route("folio print", [])));
  select("  - name: ink\n");
  expect(cli(2, "issue", "read")).toContain("Unknown command or options: issue read");
}, 60_000);

test("an edited pulled-in copy, or a file it imports, is refused before any of its code runs", () => {
  const { dir, cli, select, probe } = fixture("edited-copies");
  const repo = join(root, "edited-source");
  git(["init", "-q", repo]);
  writePackage(join(repo, "pkg/office.ts"), definitionText('{commands:{"press show":{summary:"Show",run:edition}}}', 'import {edition} from "./edition.ts";'), { name: "press" });
  write(join(repo, "pkg/edition.ts"), 'export function edition(){console.log("edition A")}');
  select(`  - {name: press, repo: ${repo}, ref: ${commit(repo)}, path: pkg}\n`);
  cli(0, "sync", "--packages");
  expect(cli(0, "press", "show")).toContain("edition A");

  const builtin = join(dir, ".office/packages/knowledge/office.ts");
  const imported = join(dir, ".office/packages/press/edition.ts");

  for (const [file, name, edited] of [[builtin, "knowledge", "office.ts (edited)"], [imported, "press", "edition.ts (edited)"]]) {
    const original = read(file);
    write(file, `${marker} ${original}`);
    const refused = cli(1, "references", "list");
    expect(refused).toContain(`package ${name}: `);
    expect(refused).toContain(`package files edited: ${edited}; office sync restores them`);
    expect(existsSync(probe)).toBe(false);
    write(file, original);
  }

  expect(cli(0, "press", "show")).toContain("edition A");
}, 60_000);

test("a name is the CLI's own or has one owner, on every run: such a command never runs", () => {
  const { dir, cli, select, probe } = fixture("names");
  const pkg = (name: string, route: string) => writePackage(join(dir, "packages", name, "office.ts"), definitionText(`{commands:{"${route}":{summary:"Run",run(){appendFileSync(process.env.PROBE,"ran ${name}\\n")}}}}`, `import {appendFileSync} from "node:fs";`));
  select("  - name: alpha\n  - name: beta\n");
  pkg("alpha", "demo run");
  pkg("beta", "beta run");
  cli(0, "sync", "--packages");
  const saved = join(dir, ".office/resolved/references.json");

  // Edited after the last sync to take a built-in's first word, which the CLI would otherwise pass on.
  pkg("beta", "apps extra");
  expect(cli(1, "apps", "extra")).toContain("package beta: command apps extra is reserved");
  // Help lists the command as the package provides it, then its problem.
  expect(cli(0, "--help")).toMatch(/ {2}apps extra {4}Run\n[\s\S]* {2}package beta: command apps extra is reserved/);
  pkg("beta", "demo run");
  expect(cli(1, "demo", "run")).toContain("command demo run claimed by both package alpha and package beta");
  expect(existsSync(probe)).toBe(false);

  // opencode inspect is the CLI's: a package's claim doesn't run, and an unreadable saved file doesn't matter.
  pkg("beta", "opencode inspect");
  write(saved, "not json");
  expect(cli(0, "opencode", "inspect")).toContain("OpenCode sources for");
  expect(cli(0, "--help")).toContain("package beta: command opencode inspect is reserved");
  expect(existsSync(probe)).toBe(false);

  // Help still prints the usage when office.yaml is invalid, then names the error and fails.
  write(join(dir, "office.yaml"), "name: names\npackages: 3\n");
  const help = cli(1, "--help");
  expect(help).toStartWith("usage: office <command>");
  expect(help).toContain("office: office.yaml is not valid:\n  packages: must be a list");
}, 60_000);

test("nothing loads without a published package set: a fresh clone, or a first sync that stopped before publishing", () => {
  const { dir, cli, select, probe, run } = fixture("unpublished");
  select("  - name: notes\n");
  const definition = join(dir, "packages/notes/office.ts");
  writePackage(definition, definitionText(`{commands:{"notes show":{summary:"Show",run(){}}}}`, `${marker}`));
  rmSync(join(dir, ".office"), { recursive: true });
  const builtins = cli(0, "--help");

  for (const stage of ["fresh clone", "unpublished first sync"]) {
    expect(cli(0, "--help"), stage).toBe(builtins);
    expect(cli(0), stage).toBe(builtins);
    expect(builtins).not.toContain("notes show");
    expect(builtins).not.toContain("references list");
    expect(cli(2, "references", "list")).toContain("Package commands load once office sync publishes a package set: run office sync");
    // A reserved first word can never be a package command, so syncing wouldn't help.
    expect(cli(2, "packages", "bogus"), stage).toBe("Unknown command or options: packages bogus; see office --help\n");
    expect(existsSync(probe), stage).toBe(false);

    // A first sync that refuses its candidate leaves an adopted, empty set.
    writePackage(definition, definitionText(`{commands:{"sync extra":{summary:"Show",run(){}}}}`, `${marker}`));
    expect(cli(1, "sync", "--packages")).toContain("command sync extra is reserved");
    expect(existsSync(join(dir, ".office/current"))).toBe(true);
    rmSync(probe);
  }

  // Outside any office: the built-in commands, and the plain unknown-command message.
  expect(run(exe, 0, "--help")).toBe(builtins);
  expect(run(exe, 2, "folio", "show")).toBe("Unknown command or options: folio show; see office --help\n");
}, 60_000);
