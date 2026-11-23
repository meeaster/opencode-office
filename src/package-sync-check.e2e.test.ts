// office check and the readers that finish setup and refresh, in the compiled office: one gathering
// per run, claims from the packages as they are now, and what check still checks while one fails.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.ts";
import { definitionFixture } from "./package-definition.fixture.ts";
import { definitionText, writePackage } from "./test-package.ts";

const { root, exe, write, read, commit, fixture } = definitionFixture({ second: false });

/** A package whose setup appends a line to $PROBE each time it runs: `finish` in the reader that finishes refresh. */
const counted = (extra = "") => definitionText(`{setup(){appendFileSync(process.env.PROBE, (process.argv.includes("--finish-refresh") ? "finish" : "run") + "\\n"); ${extra}}}`, 'import {appendFileSync} from "node:fs";');

/** An office.yaml reference to a local repository. */
function upstream(name: string) {
  const repo = join(root, name);
  git(["init", "-qb", "main", repo]);
  write(join(repo, "document"), name);
  commit(repo);

  return repo;
}

test("check and the reader that finishes refresh each run every setup once; standalone up and a named cron run none", () => {
  const { dir, env, probe, cli, select } = fixture("counted");
  writePackage(join(dir, "packages/counter/office.ts"), counted());
  select("  - name: counter\n");
  cli(0, "sync");
  rmSync(probe, { force: true });
  const lines = () => { try { return read(probe); } catch { return ""; } };

  cli(0, "check");
  expect(lines()).toBe("run\n");
  rmSync(probe);

  for (const args of [["up"], ["cron", "run", "package.office.update-references"]]) Bun.spawnSync([exe, "--office", dir, ...args], { cwd: root, env });
  expect(lines()).toBe("");

  // Refresh syncs (admission gathers too), then its finishing reader gathers once for up and check.
  Bun.spawnSync([exe, "--office", dir, "refresh"], { cwd: root, env });
  expect(lines().split("\n").filter(line => line === "finish")).toEqual(["finish"]);
}, 60_000);

test("a broken package in check: a failed line naming it, one line for the skipped claim checks, and every other check still runs", () => {
  const { dir, cli, select } = fixture("broken-check");
  const repo = upstream("check-origin");
  const pkg = join(dir, "packages/broken");
  writePackage(join(pkg, "office.ts"), definitionText('{setup(c){c.add(requirements,{name:"jq",minimumVersion:"1.7.1"})}}', 'import {requirements} from "@office/tooling/requirements";'), { dependencies: ["tooling"] });
  write(join(pkg, "seed/notes/broken.md"), "seed\n");
  select("  - name: broken\n");
  write(join(dir, "office.yaml"), read(join(dir, "office.yaml")).replace("references: []", `references: [{name: docs, url: ${repo}}]`));
  cli(0, "sync");
  cli(0, "check");

  // A requirement added since the last sync shows in check, which says to sync.
  writePackage(join(pkg, "office.ts"), definitionText('{setup(c){c.add(requirements,{name:"jq",minimumVersion:"1.7.1"});c.add(requirements,{name:"yq",minimumVersion:"4.44.1"})}}', 'import {requirements} from "@office/tooling/requirements";'), { dependencies: ["tooling"] });
  expect(cli(1, "check")).toMatch(/FAIL package broken: .*machine\.packages\.toml lacks yq; office sync adds it/);

  writePackage(join(pkg, "office.ts"), definitionText('{setup(){throw Error("broken setup")}}'));
  // The stored seed the receipt names no longer hashes to it.
  const stored = readdirSync(join(dir, ".office/seeds"), { recursive: true, withFileTypes: true }).filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).filter(path => read(path) === "seed\n");
  expect(stored).toHaveLength(1);
  write(stored[0], "corrupted\n");
  rmSync(join(dir, "references/docs"), { recursive: true });
  const output = cli(1, "check");
  expect(output).toMatch(/^FAIL package broken: .*broken setup/m);
  expect(output.match(/^WARN package claims: not checked while a package doesn't load/gm)).toHaveLength(1);
  expect(output).toMatch(/^WARN seeds: notes\/broken\.md: its seed .* doesn't hash to its name/m);
  expect(output).toContain("reference references/docs is not cloned");
}, 60_000);

test("the applied file is not check's input: an invalid one is its own problem, and the checkout and GitHub host lines stay", () => {
  const { dir, home, cli, select } = fixture("applied-check");
  const repo = upstream("applied-origin");
  // A package's reference on a second GitHub host, which Git fetches from a local repository.
  const contributed = "https://ghe.example.test/org/docs.git";
  const mirror = upstream("contributed-origin");
  const applied = git(["rev-parse", "HEAD"], mirror);
  write(join(home, ".gitconfig"), `[url "${mirror}"]\n\tinsteadOf = ${contributed}\n`);
  // gh knows both hosts: only the gathered reference narrows the hosts check looks at to its own.
  write(join(home, ".config/gh/hosts.yml"), "github.com: {}\nghe.example.test: {}\n");
  writePackage(join(dir, "packages/contrib/office.ts"), definitionText(`{setup(c){c.add(repositories,{name:"contrib-docs",url:"${contributed}"})}}`, 'import {repositories} from "@office/references/repositories";'), { dependencies: ["references"] });
  select("  - name: contrib\n");
  write(join(home, "bin/gh"), `#!/bin/sh
case "$1" in
  --version) echo "gh version 2.104.0 (fixture)";;
  auth) echo '{"hosts":{"github.com":[{"state":"success","active":true,"login":"fixture","tokenSource":"keyring"}]}}';;
  *) exit 1;;
esac
`, 0o755);
  write(join(dir, "office.yaml"), `${read(join(dir, "office.yaml")).replace("references: []", `references: [{name: docs, url: ${repo}}]`)}git: {credentials: gh}\n`);
  cli(0, "sync");
  // The contributed checkout drifts from what sync applied.
  const checkout = join(dir, "references/contrib-docs");
  write(join(checkout, "document"), "drifted");
  const drifted = commit(checkout);
  const relevant = (text: string) => text.split("\n").filter(line => /reference|GitHub/.test(line));
  const before = relevant(cli(1, "check"));
  expect(before).toContainEqual(expect.stringContaining(`expected applied commit ${applied}, found HEAD ${drifted}`));
  expect(before).toContainEqual(expect.stringMatching(/^(?:ok  |FAIL) GitHub ghe\.example\.test: /));
  expect(before).not.toContainEqual(expect.stringMatching(/GitHub github\.com: /));

  write(join(dir, ".office/resolved/references.json"), "{");
  const after = cli(1, "check");
  expect(after).toContain(".office/resolved/references.json: ");
  expect(relevant(after).filter(line => !line.includes(".office/resolved/references.json"))).toEqual(before);
}, 60_000);

// The plugin's guidance reads the references registry's handle, made with Registry.define: the
// bundle carries its own SDK, so a process that registers nothing, outside the office, loads it.
test("the office plugin's bundle loads in a fresh process and gives the guidance office instructions prints, references with their owners", () => {
  const { dir, env, cli } = fixture("bundle");
  write(join(dir, "office.yaml"), "name: bundle\npackages:\n  - name: aws-emulator\n");
  cli(0, "sync", "--packages");
  expect(read(join(dir, ".opencode/plugins/office/index.js"))).not.toContain("@office/sdk");

  const script = `
    const plugin = (await import(${JSON.stringify(join(dir, ".opencode/plugins/office/index.js"))})).default;
    const hooks = [];
    let text = "";
    const registration = { dispose: async () => {} };
    const close = await plugin.setup({
      location: { directory: ${JSON.stringify(dir)} },
      session: { async hook(_, handler) { hooks.push(handler); return registration; }, instructions: { entry: { async put(entry) { text = entry.value; } } }, compact: async () => ({}) },
      skill: { transform: async () => registration, list: async () => ({ data: [] }), reload: async () => {} },
      mcp: { transform: async () => registration },
      tool: { transform: async () => registration },
    });
    for (const hook of hooks) await hook({ sessionID: "fixture" });
    close?.();
    process.stdout.write(text);
  `;

  const fresh = Bun.spawnSync([process.execPath, "--no-install", "-e", script], { cwd: root, env: { ...env, PATH: `${env.PATH}:${join(process.execPath, "..")}` } });
  const guidance = fresh.stdout.toString();

  expect(fresh.exitCode, fresh.stderr.toString()).toBe(0);
  expect(guidance).toBe(cli(0, "instructions", dir).trimEnd());
  expect(guidance).toMatch(/`references\/floci\/`: .*\(package aws-emulator\)/);
  expect(JSON.parse(readFileSync(join(dir, ".office/resolved/references.json"), "utf8")).references).toContainEqual(expect.objectContaining({ name: "floci", owner: "aws-emulator", ref: "main" }));
}, 60_000);
