// What sync does with what packages register in its run, in the compiled office: a package that
// fails to load stops package sync and changes nothing a package set applies; a package that fails to
// fetch doesn't stop the others, but freezes every package's tools and machine files.
import { expect, test } from "bun:test";
import { existsSync, lstatSync, readlinkSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../src/git.ts";
import { definitionFixture } from "../support/package-definition.fixture.ts";
import { definitionText, pluginDefinition, writePackage } from "../support/test-package.ts";

const { root, write, read, commit, fixture } = definitionFixture({ second: false });

const imports = 'import {opencode} from "@office/opencode"; import {repositories} from "@office/references/repositories"; import {requirements} from "@office/tooling/requirements"; import {tasks} from "@office/mise-integration/claims"; import {mkdirSync, writeFileSync} from "node:fs"; import {join} from "node:path";';
const dependencies = ["opencode", "references", "tooling", "mise-integration"];

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
  writePackage(join(first, "office.ts"), claims({ tool: "jq@1.7.1", task: "Say hello", reference: "first-docs", extra: 'opencode.plugins.add(c, {directory: "plugin"});', file: "first.md", mark: "first\n" }), { dependencies });
  write(join(first, "hello.sh"), "echo hello\n");
  write(join(first, "plugin/index.ts"), "export default { id: \"first\", async setup() {} };\n");
  writePackage(second, definitionText("{setup(){}}"));
  writePackage(join(third, "office.ts"), pluginDefinition(), { dependencies: ["opencode"] });
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
  // No package declares a tool there any more: the office package's are shared tools.
  expect(existsSync(join(dir, "machine.packages.toml"))).toBe(false);
  expect(existsSync(join(dir, ".office/mise/first.toml"))).toBe(false);
}, 60_000);

test("a Git package that can't be fetched doesn't stop the others, but no package's tools or machine files are reconciled; the others' plugins still are", () => {
  const { dir, cli } = fixture("fetch-fails");
  const yaml = join(dir, "office.yaml");
  const repo = join(root, "unreachable-source");
  const local = join(dir, "packages/local");
  git(["init", "-qb", "main", repo]);
  writePackage(join(repo, "remote/office.ts"), definitionText('{setup(c){c.registry({id:"remote.items",parse:i=>i}); c.add(tasks,{name:"hello",script:"hello.sh",description:"Remote hello"}); opencode.plugins.add(c, {directory: "plugin"})}}', 'import {tasks} from "@office/mise-integration/claims"; import {opencode} from "@office/opencode";'), { name: "remote", dependencies: ["mise-integration", "opencode"] });
  write(join(repo, "remote/hello.sh"), "echo hello\n");
  write(join(repo, "remote/plugin/index.ts"), "export default { id: \"remote\", async setup() {} };\n");
  const pinned = commit(repo);
  writePackage(join(local, "office.ts"), claims({ tool: "jq@1.7.1", task: "Local hello", reference: "local-docs", file: "local.md", mark: "v1\n" }), { dependencies });
  write(join(local, "hello.sh"), "echo hello\n");
  writePackage(join(dir, "packages/leaving/office.ts"), pluginDefinition(), { dependencies: ["opencode"] });
  write(join(dir, "packages/leaving/plugin/index.ts"), "export default { id: \"leaving\", async setup() {} };\n");
  write(yaml, host(`  - {name: remote, repo: ${repo}, path: remote, ref: ${pinned}}\n  - name: local\n  - name: leaving\n`));
  cli(0, "sync", "--packages");
  expect(readlinkSync(join(dir, ".opencode/plugins/leaving"))).toBe("../../packages/leaving/plugin");
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
    c.add(tasks,{name:"more",script:"hello.sh",description:"Local more"});
    opencode.plugins.add(c, {directory: "plugin"});`, file: "local.md", mark: "v2\n" }), { dependencies });
  write(join(local, "plugin/index.ts"), "export default { id: \"local\", async setup() {} };\n");
  // Leaving stops registering its plugin.
  writePackage(join(dir, "packages/leaving/office.ts"), definitionText("{}"));

  const output = cli(1, "sync", "--packages");
  expect(output).toContain("FAILED .office/packages/remote");
  expect(output).toContain("not reconciling any package's tools or machine files: what package remote claims is unknown");
  // OpenCode delivery of the packages that read goes on: a new link, a withdrawn one, remote's kept.
  expect(readlinkSync(join(dir, ".opencode/plugins/local"))).toBe("../../packages/local/plugin");
  expect(lstatSync(join(dir, ".opencode/plugins/leaving"), { throwIfNoEntry: false })).toBeUndefined();
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

test("while a Git package can't be fetched, another's changed copy is still admitted only with OpenCode registrations naming its own files", () => {
  const { dir, cli } = fixture("unread-admission");
  const gone = join(root, "unread-admission-gone");
  const moving = join(root, "unread-admission-moving");

  for (const repo of [gone, moving]) git(["init", "-qb", "main", repo]);
  writePackage(join(gone, "gone/office.ts"), definitionText("{}"), { name: "gone" });
  writePackage(join(moving, "moving/office.ts"), pluginDefinition(), { name: "moving", dependencies: ["opencode"] });
  write(join(moving, "moving/plugin/index.ts"), "export default { id: \"moving\", async setup() {} };\n");
  const [kept, first] = [commit(gone), commit(moving)];
  const select = (ref: string) => write(join(dir, "office.yaml"), host(`  - {name: gone, repo: ${gone}, path: gone, ref: ${kept}}\n  - {name: moving, repo: ${moving}, path: moving, ref: ${ref}}\n`));

  select(first);
  cli(0, "sync", "--packages");
  const plugin = readlinkSync(join(dir, ".opencode/plugins/moving"));
  rmSync(gone, { recursive: true });
  rmSync(join(dir, ".office/packages/gone"), { recursive: true });
  writePackage(join(moving, "moving/office.ts"), pluginDefinition("missing"), { name: "moving", dependencies: ["opencode"] });
  select(commit(moving));
  const current = readlinkSync(join(dir, ".office/current"));

  const output = cli(1, "sync", "--packages");
  expect(output).toContain("FAILED package moving: OpenCode registration: OpenCode server asset must be an existing directory inside the package");
  expect(output).toContain("no package set was published");
  expect(readlinkSync(join(dir, ".office/current"))).toBe(current);
  expect(readlinkSync(join(dir, ".opencode/plugins/moving"))).toBe(plugin);
}, 60_000);
