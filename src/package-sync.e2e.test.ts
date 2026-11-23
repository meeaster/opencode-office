// What sync does with what packages register in its run, in the compiled office: a package that
// fails to load stops package sync and changes nothing a package set applies; a package that fails to
// fetch doesn't stop the others, but freezes every package's tools and machine files.
import { expect, test } from "bun:test";
import { existsSync, lstatSync, readlinkSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.ts";
import { definitionFixture } from "./package-definition.fixture.ts";
import { definitionText, writePackage } from "./test-package.ts";

const { root, write, read, commit, fixture } = definitionFixture({ second: false });

const imports = 'import {repositories} from "@office/references/repositories"; import {requirements} from "@office/tooling/requirements"; import {tasks} from "@office/mise-integration/claims"; import {mkdirSync, writeFileSync} from "node:fs"; import {join} from "node:path";';
const dependencies = ["references", "tooling", "mise-integration"];

/**
 * A definition that requires `tool`, adds the task `task` and the reference `reference`, and whose
 * `sync` writes `mark` to `notes/<file>` when both are given.
 */
function claims({ tool, task, reference, extra = "", file, mark }: { tool: string; task: string; reference: string; extra?: string; file?: string; mark?: string }) {
  const [name, version] = tool.split("@");
  const sync = file === undefined ? "" : `, sync({office}){mkdirSync(join(office.dir, "notes"), {recursive: true}); writeFileSync(join(office.dir, "notes/${file}"), ${JSON.stringify(mark)})}`;

  return definitionText(`{setup(c){
    c.add(requirements,{name:"${name}",minimumVersion:"${version}"});
    c.add(tasks,{name:"hello",script:"hello.sh",description:"${task}"});
    c.add(repositories,{name:"${reference}",url:"https://example.invalid/${reference}.git"});
    ${extra}
  }${sync}}`, imports);
}

/** office.yaml for a host-mode office selecting `packages`. */
const host = (packages: string) => `name: applied\nopencode: {mode: host, url: 'http://127.0.0.1:1'}\ntools: {sfw: {enabled: false}}\npackages:\n${packages}`;

test("a setup that throws stops package sync and changes nothing it applies; fixed, the next sync applies every edit", () => {
  const { dir, cli } = fixture("setup-throws");
  const yaml = join(dir, "office.yaml");
  const first = join(dir, "packages/first");
  const second = join(dir, "packages/second/office.ts");
  const third = join(dir, "packages/third");
  writePackage(join(first, "office.ts"), claims({ tool: "jq@1.7.1", task: "Say hello", reference: "first-docs", file: "first.md", mark: "first\n" }), { dependencies });
  write(join(first, "hello.sh"), "echo hello\n");
  write(join(first, "plugin/index.ts"), "export default { id: \"first\", async setup() {} };\n");
  writePackage(second, definitionText("{setup(){}}"));
  writePackage(join(third, "office.ts"), definitionText("{}"));
  write(join(third, "plugin/index.ts"), "export default { id: \"third\", async setup() {} };\n");
  write(yaml, host("  - name: first\n  - name: second\n  - name: third\n"));
  cli(0, "sync", "--packages");

  const outputs = {
    current: () => readlinkSync(join(dir, ".office/current")),
    tools: () => read(join(dir, "machine.packages.toml")),
    fragment: () => read(join(dir, ".office/mise/first.toml")),
    plugin: () => readlinkSync(join(dir, ".opencode/plugins/first")),
    marker: () => read(join(dir, "notes/first.md")),
    lock: () => read(join(dir, "office.lock")),
    applied: () => read(join(dir, ".office/resolved/references.json")),
    deselected: () => readlinkSync(join(dir, ".opencode/plugins/third")),
  };

  const snapshot = () => Object.fromEntries(Object.entries(outputs).map(([name, output]) => [name, output()]));
  const before = snapshot();
  expect(before.tools).toContain('"jq" = "1.7.1" # first');
  expect(before.fragment).toContain("Say hello");
  expect(before.applied).toContain("first-docs");

  writePackage(second, definitionText('{setup(){throw Error("second is broken")}}'));
  writePackage(join(first, "office.ts"), claims({ tool: "jq@1.8.0", task: "Say goodbye", reference: "first-guide", file: "first.md", mark: "edited\n" }), { dependencies });
  rmSync(join(first, "plugin"), { recursive: true });
  write(yaml, host("  - name: first\n  - name: second\n"));
  expect(cli(1, "sync", "--packages")).toContain("FAILED package second: second is broken");
  expect(snapshot()).toEqual(before);

  writePackage(second, definitionText("{setup(){}}"));
  cli(0, "sync", "--packages");
  expect(outputs.current()).not.toBe(before.current);
  expect(outputs.tools()).toContain('"jq" = "1.8.0" # first');
  expect(outputs.fragment()).toContain("Say goodbye");
  expect(outputs.applied()).toContain("first-guide");
  expect(outputs.applied()).not.toContain("first-docs");
  expect(outputs.marker()).toBe("edited\n");
  expect(lstatSync(join(dir, ".opencode/plugins/first"), { throwIfNoEntry: false })).toBeUndefined();
  expect(lstatSync(join(dir, ".opencode/plugins/third"), { throwIfNoEntry: false })).toBeUndefined();

  // Still selected, first stops requiring its tool and drops its task: both outputs follow.
  writePackage(join(first, "office.ts"), definitionText('{setup(c){c.add(repositories,{name:"first-guide",url:"https://example.invalid/first-guide.git"})}}', imports), { dependencies });
  cli(0, "sync", "--packages");
  expect(outputs.tools()).not.toContain("# first");
  expect(existsSync(join(dir, ".office/mise/first.toml"))).toBe(false);
}, 60_000);

test("a Git package that can't be fetched doesn't stop the others, but no package's tools or machine files are reconciled", () => {
  const { dir, cli } = fixture("fetch-fails");
  const yaml = join(dir, "office.yaml");
  const repo = join(root, "unreachable-source");
  const local = join(dir, "packages/local");
  git(["init", "-qb", "main", repo]);
  writePackage(join(repo, "remote/office.ts"), definitionText('{setup(c){c.registry({id:"remote.items",parse:i=>i}); c.add(tasks,{name:"hello",script:"hello.sh",description:"Remote hello"})}}', 'import {tasks} from "@office/mise-integration/claims";'), { name: "remote", dependencies: ["mise-integration"] });
  write(join(repo, "remote/hello.sh"), "echo hello\n");
  write(join(repo, "remote/plugin/index.ts"), "export default { id: \"remote\", async setup() {} };\n");
  const pinned = commit(repo);
  writePackage(join(local, "office.ts"), claims({ tool: "jq@1.7.1", task: "Local hello", reference: "local-docs", file: "local.md", mark: "v1\n" }), { dependencies });
  write(join(local, "hello.sh"), "echo hello\n");
  write(yaml, host(`  - {name: remote, repo: ${repo}, path: remote, ref: ${pinned}}\n  - name: local\n`));
  cli(0, "sync", "--packages");
  const current = readlinkSync(join(dir, ".office/current"));
  const tools = read(join(dir, "machine.packages.toml"));
  const fragments = ["remote", "local"].map(name => read(join(dir, `.office/mise/${name}.toml`)));
  const lock = read(join(dir, "office.lock"));
  const plugin = join(dir, ".opencode/plugins/remote");
  const target = readlinkSync(plugin);

  renameSync(repo, `${repo}-gone`);
  rmSync(join(dir, ".office/packages/remote"), { recursive: true });
  writePackage(join(local, "office.ts"), claims({ tool: "jq@1.7.1", task: "Local hello", reference: "local-docs", extra: `
    c.add(repositories,{name:"local-guide",url:"https://example.invalid/guide.git"});
    c.add(requirements,{name:"yq",minimumVersion:"4.44.1"});
    c.add(tasks,{name:"more",script:"hello.sh",description:"Local more"});`, file: "local.md", mark: "v2\n" }), { dependencies });

  const output = cli(1, "sync", "--packages");
  expect(output).toContain("FAILED .office/packages/remote");
  expect(output).toContain("not reconciling any package's tools or machine files: what package remote claims is unknown");
  expect(readlinkSync(join(dir, ".office/current"))).not.toBe(current);
  expect(read(join(dir, ".office/resolved/references.json"))).toContain("local-guide");
  expect(read(join(dir, "machine.packages.toml"))).toBe(tools);
  expect(["remote", "local"].map(name => read(join(dir, `.office/mise/${name}.toml`)))).toEqual(fragments);
  expect(output).toContain("not running any package's sync function: what package remote registers is unknown");
  expect(read(join(dir, "notes/local.md"))).toBe("v1\n");
  expect(read(join(dir, "office.lock"))).toBe(lock);
  expect(readlinkSync(plugin)).toBe(target);
  expect(cli(1, "references", "list")).toContain("package remote: rejected by the last sync; run office sync");

  // The unfetched package is the only provider of a registry the local one adds to: nothing publishes.
  const published = readlinkSync(join(dir, ".office/current"));
  writePackage(join(local, "office.ts"), definitionText('{setup(c){c.add({id:"remote.items"},{name:"entry"})}}'));
  expect(cli(1, "sync", "--packages")).toContain("FAILED package local: no provider registered remote.items");
  expect(readlinkSync(join(dir, ".office/current"))).toBe(published);
  expect(existsSync(join(dir, ".office/mise/local.toml"))).toBe(true);
}, 60_000);
