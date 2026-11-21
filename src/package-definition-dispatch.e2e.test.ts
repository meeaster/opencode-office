import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git } from "./git.ts";
import { definitionFixture } from "./package-definition.fixture.ts";

const { root, bin, exe, variant, marker, write, read, commit, fixture, collector } = definitionFixture();

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

test("a legacy writer replacing the references bridge cannot publish or serve a stale index", () => {
  const { dir, cli, select } = fixture("legacy-writer");
  const bridge = join(dir, ".office/resolved/references.json");
  const current = join(dir, ".office/current");
  const before = readlinkSync(current);
  const config = join(dir, ".office/tsconfig.contracts.json");
  const pkg = join(dir, "packages/notes/office.ts");
  const command = 'ctx.command({name:"notes bye",summary:"bye",run(){console.log("updated")}})';
  select("  - name: notes\n");
  // Simulate the old executable's atomic replacement during collection, after reservation.
  write(pkg, `import {renameSync,writeFileSync} from "node:fs"; export default {name:"notes",description:"notes",setup(ctx){
    writeFileSync(${JSON.stringify(`${bridge}.tmp`)}, "owner bytes"); renameSync(${JSON.stringify(`${bridge}.tmp`)}, ${JSON.stringify(bridge)}); ${command}}}`);
  expect(cli(1, "sync", "--packages")).toContain(bridge);
  expect(readlinkSync(current)).toBe(before);
  rmSync(config);
  expect(cli(1, "notes", "bye")).toContain("move the conflicting entry aside");
  expect(existsSync(config)).toBe(false);
  expect(read(bridge)).toBe("owner bytes");
  renameSync(bridge, `${bridge}.saved`);
  symlinkSync(`${bridge}.saved`, bridge);
  expect(cli(1, "sync", "--packages")).toContain(bridge);
  expect(readlinkSync(current)).toBe(before);
  rmSync(bridge);
  write(pkg, `export default {name:"notes",description:"notes",setup(ctx){${command}}}`);
  cli(0, "sync", "--packages");
  expect(readlinkSync(bridge)).toBe("../current/references.json");
  expect(readlinkSync(config)).toBe("current/tsconfig.contracts.json");
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
  const config = join(dir, ".office/tsconfig.contracts.json");
  rmSync(config);
  write(join(config, "mine"), "keep");
  const packages = join(dir, ".office/packages");
  rmSync(packages);
  expect(cli(1, "sync", "--packages")).toContain(config);
  expect(readlinkSync(current)).toBe(`generations/${previous}`);
  expect(existsSync(packages)).toBe(false);
  expect(existsSync(journal)).toBe(true);
  renameSync(config, `${config}.saved`);
  cli(0, "references", "list");
  expect(readlinkSync(config)).toBe("current/tsconfig.contracts.json");
  expect(readlinkSync(packages)).toBe("current/packages");
  cli(0, "sync", "--packages");
  expect(read(join(current, "previous"))).toBe(candidate);
  expect(existsSync(journal)).toBe(false);
  expect(read(join(`${config}.saved`, "mine"))).toBe("keep");
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

test("a symlinked office publishes relocatable public imports and rejects private and relative bypasses", () => {
  const { dir, run, select } = fixture("alias-seed");
  select("  - name: consumer\n  - name: provider\n");

  const definition = `import {requirements} from "@office/tooling/requirements"; import {token} from "@office/provider/token";
    export default {name:"consumer",description:"consumer",setup(ctx){ctx.command({name:"consumer show",summary:"show",run(){console.log(requirements.id,token)}})}}`;

  write(join(dir, "packages/consumer/office.ts"), definition);
  write(join(dir, "packages/provider/office.ts"), 'export default {name:"provider",description:"provider"}');
  write(join(dir, "packages/provider/exports/token.ts"), 'import {readFileSync} from "node:fs"; export const token=readFileSync(new URL("../asset",import.meta.url),"utf8");');
  write(join(dir, "packages/provider/asset"), "source-relative");
  const nested = join(root, "deep/a/b");
  mkdirSync(dirname(nested), { recursive: true });
  renameSync(dir, nested);
  symlinkSync(nested, dir);
  run(exe, 0, "--office", dir, "sync", "--packages");
  const show = (path: string, status = 0) => run(exe, status, "--office", path, "consumer", "show");
  expect(show(dir)).toContain("tooling.requirements source-relative");
  const office = join(dir, ".office");
  const map = JSON.parse(read(join(office, "tsconfig.contracts.json")));
  expect(realpathSync(join(office, map.compilerOptions.paths["@office/provider/token"][0]))).toBe(join(nested, "packages/provider/exports/token.ts"));

  for (const include of map.include) expect(existsSync(join(office, include))).toBe(true);
  const source = join(dir, "packages/consumer/office.ts");
  write(source, definition.replace("@office/tooling/requirements", "../../.office/packages/tooling/exports/requirements.ts"));
  expect(show(dir, 1)).toContain("import the selected public module as @office/tooling/requirements");
  write(source, definition.replace("@office/tooling/requirements", "@office/tooling/private"));
  expect(show(dir, 1)).toContain("not a public export");
  write(source, definition);
  select("  - name: consumer\n");
  expect(show(dir, 1)).toContain("selection of imported package provider differs");
  select("  - name: consumer\n  - name: provider\n");
  rmSync(dir);
  renameSync(nested, dir);
  expect(show(dir)).toContain("tooling.requirements source-relative");
});

test("indexed references execute the installed author's registration; legacy listing only bootstraps", () => {
  const f = fixture("command-upgrade");
  const path = join(f.dir, ".office/resolved/references.json");
  const installed = join(f.dir, ".office/packages/references");
  write(path, JSON.stringify({ version: 2, inputs: "", owner: [{ name: "previous", url: "old" }], contributors: [] }));
  rmSync(installed, { recursive: true });
  expect(f.newer(0, "references", "list")).toContain("previous\told\toffice.yaml");
  f.newer(0, "sync", "--packages");
  expect(f.newer(0, "references", "list")).toContain("variant package handler");
  expect(f.cli(1, "references", "list")).toContain("changed source/revision");
  rmSync(installed, { recursive: true });
  expect(f.newer(0, "--help")).toContain("references list");
  expect(f.newer(1, "references", "list")).toContain("office sync --packages");
  f.newer(0, "sync", "--packages");
  expect(f.newer(0, "references", "list")).toContain("variant package handler");
}, 60_000);

test("independent command authors share one publication; failed collection cannot lend a stale callable", () => {
  const { dir, probe, cli, select } = fixture("direct");
  const ink = join(dir, "packages/ink");
  const repo = join(root, "press-source");
  const path = join(dir, ".office/resolved/references.json");
  const route = `ctx.command({name:"folio show", aliases:["folio read"], summary:"Print edition", run:() => print(ctx.settings.label)});`;

  const module = (extra = "") => `import {print} from "./edition.ts"; export default {
    name:"ink",description:"Ink",settings:{label:{description:"Label",default:"old"}},
    setup(ctx) {ctx.add({registry:"references.repository",value:{name:"paper",url:"local"}}); ${route} ${extra}}}`;

  write(join(ink, "office.ts"), module());
  write(join(ink, "edition.ts"), 'export function print(label: string) { console.log("first:" + label) }');
  git(["init", "-q", repo]);
  write(join(repo, "pkg/office.ts"), `${marker} import {edition} from "./edition.ts"; export default {name:"press",description:"Press",setup({command}){command({name:"issue read",summary:"Print issue",run:edition})}}`);
  write(join(repo, "pkg/edition.ts"), 'export function edition(){console.log("from Git")}');
  const press = `  - {name: press, repo: ${repo}, ref: ${commit(repo)}, path: pkg}\n`;
  select(`${press}  - name: ink\n`);
  cli(0, "sync", "--packages");
  expect(cli(0, "issue", "read")).toContain("from Git");
  rmSync(probe);
  expect(cli(0, "--help")).toContain("folio read");
  select(`${press}  - {name: ink, settings: {label: new}}\n`);
  write(join(ink, "edition.ts"), 'export function print(label: string){console.log("edited:" + label)}');
  expect(cli(0, "folio", "read")).toContain("edited:old");
  expect(existsSync(probe)).toBe(false);
  const synced = read(path);

  for (const alias of ["issue read", "sync", "sync --packages", "--help"]) {
    write(join(ink, "office.ts"), module(`ctx.command({name:"draft show",aliases:["${alias}"],summary:"Draft",run:print})`));
    expect(cli(1, "sync", "--packages")).toContain(alias);
    expect(read(path)).toBe(synced);
    expect(cli(0, "--help")).not.toContain("draft show");
  }

  write(join(ink, "office.ts"), module('throw Error("ink collector failed")'));
  expect(cli(1, "sync", "--packages")).toContain("ink collector failed");
  write(join(ink, "office.ts"), module());
  expect(cli(0, "references", "list")).toContain("package ink (stale)");
  expect(cli(0, "--help")).not.toContain("folio read");
  expect(cli(2, "folio", "read")).not.toContain("edited:");
  cli(0, "sync", "--packages");
  expect(cli(0, "folio", "read")).toContain("edited:new");
}, 60_000);

test("indexed dispatch validates the selected source without requiring unrelated live config", () => {
  const { dir, cli, probe } = fixture("dispatch-selection");
  const yaml = join(dir, "office.yaml");
  const ink = { name: "ink", settings: { label: "saved" } };
  const atlas = { name: "atlas" };
  const config = { name: "paper", packages: [ink, atlas], references: [{ name: "old", url: "old-url" }] };
  write(yaml, JSON.stringify(config));
  write(join(dir, "packages/ink/office.ts"), `${marker} export default {name:"ink",description:"Ink",
    settings:{label:{description:"Label",required:true}},setup(ctx){ctx.command({name:"folio show",summary:"Show",run:()=>console.log("label="+ctx.settings.label)})}}`);
  const other = join(dir, "packages/atlas/office.ts");
  write(other, `export default {name:"atlas",description:"Atlas"}`);
  cli(0, "sync", "--packages");
  write(other, `${marker} throw Error("unrelated author imported")`);
  rmSync(probe);

  for (const edit of [
    { executor: { catalog_apps: false } }, { tools: { mise: { version: [] } } },
    { packages: [ink, { name: "atlas", path: "no-repo" }] },
    { packages: [{ name: "ink", settings: false }, atlas] }, { references: 42 },
  ]) {
    write(yaml, JSON.stringify({ ...config, references: [{ name: "changed", url: "unsynced" }], ...edit }));
    expect(cli(1, "sync", "--packages")).toContain("office.yaml is not valid");
    expect(cli(0, "--help")).toContain("folio show");
    const listing = cli(0, "references", "list");
    expect(listing).toContain("old\told-url\toffice.yaml");
    expect(listing).not.toContain("unsynced");
    expect(listing).toMatch(/cannot be compared|changed since collection/);
    expect(existsSync(probe)).toBe(false);
    expect(cli(0, "folio", "show")).toContain("label=saved");
    expect(read(probe)).toBe("imported\n");
    rmSync(probe);
  }

  for (const packages of [[atlas], [ink, ink], [atlas, { name: "ink", path: "partial" }],
    [atlas, { name: "ink", repo: "elsewhere", ref: "other", path: "pkg" }], {}, [ink, {}]]) {
    write(yaml, JSON.stringify({ ...config, packages }));
    expect(cli(1, "folio", "show")).toContain("office sync --packages");
    expect(existsSync(probe)).toBe(false);
  }
}, 60_000);

test("all readers reject a Git command owner missing its files binding before fetching or importing", () => {
  const { dir, home, cli, probe } = fixture("command-digest");
  const repo = join(root, "digest-origin");
  git(["init", "-qb", "main", repo]);

  const module = `export default {name:"press",description:"Press", setup(ctx){
    ctx.add({registry:"references.repository",value:{name:"manual",url:${JSON.stringify(repo)}}});
    ctx.command({name:"press show",summary:"Show",run:()=>console.log("edition A")})}}`;

  write(join(repo, "pkg/office.ts"), `${marker} ${module}`);
  write(join(dir, "office.yaml"), JSON.stringify({ name: "paper", packages: [{ name: "press", repo, ref: commit(repo), path: "pkg" }] }));
  cli(0, "sync", "--packages");
  const path = join(dir, ".office/resolved/references.json");
  const generation = JSON.parse(read(path));
  const checkout = join(dir, "references/manual");
  const transfers = join(home, "git-transfers");
  write(join(home, "bin/git"), `#!/bin/sh\ncase "$1" in clone|fetch|ls-remote) echo "$1" >> "$HOME/git-transfers";; esac\nexec "${bin}/git" "$@"\n`, 0o755);
  const bad = JSON.stringify(generation, (key, value) => key === "files" ? undefined : value);
  write(path, bad);
  rmSync(probe);
  const error = "Git command owner press is missing its commands.files digest";
  const help = cli(0, "--help");
  expect(help).toContain(error);
  expect(help).not.toContain("press show");

  for (const args of [["press", "show"], ["references", "list"], ["sync", "--references"], ["sync", "--packages"]]) {
    expect(cli(1, ...args)).toContain(error);
  }

  expect(read(path)).toBe(bad);
  expect(existsSync(probe)).toBe(false);
  expect(existsSync(checkout)).toBe(false);
  expect(existsSync(transfers)).toBe(false);

  // Only Git owners of commands need this binding. Both data-only formats remain usable.
  for (const version of [2, 3]) {
    const contributors = generation.contributors.map(({ entries, ...group }: { entries: { id: string; value: { name: string; url: string } }[] }) =>
      ({ ...group, references: entries.flatMap(entry => entry.id === "references.repository" ? [entry.value] : []) }));

    write(path, JSON.stringify({ ...generation, contributors, version }, (key, value) =>
      key === "commands" && (version === 2 || value.files) ? undefined : value));
    expect(cli(0, "references", "list")).toContain(`manual\t${repo}\tpackage press`);
  }

  cli(0, "sync", "--references");
  expect(read(transfers)).toMatch(/fetch|clone/);
  expect(existsSync(join(checkout, ".git"))).toBe(true);
  write(path, JSON.stringify(generation));
  write(join(dir, ".office/packages/press/office.ts"), `${marker} throw Error("changed copy imported");`);
  expect(cli(0, "--help")).toContain("press show");
  expect(cli(1, "press", "show")).toContain("package files edited");
  expect(existsSync(probe)).toBe(false);
}, 60_000);
