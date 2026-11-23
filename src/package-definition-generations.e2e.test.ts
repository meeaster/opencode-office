import { expect, test } from "bun:test";
import { chmodSync, existsSync, readlinkSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.ts";
import { appliedReferences } from "./applied-references.ts";
import { loadOffice } from "./office.ts";
import { definitionFixture } from "./package-definition.fixture.ts";
import { definitionText, writePackage } from "./test-package.ts";

const { root, exe, marker, write, read, commit, fixture, collector, published } = definitionFixture();

test("a built-in's bytes and a Git contributor's resolved commit survive separate executable processes", () => {
  const { dir, env, cli, newer, probe, select } = fixture("reference-repair");
  select("  - {name: aws-emulator, settings: {port: 14566, storage: hybrid}}\n");
  cli(0, "sync", "--packages");
  const delivered = ["office.ts", ".settings.json", ".source.json", "compose.yaml"].map(path => join(dir, ".office/packages/aws-emulator", path));
  const before = delivered.map(read);

  // Exercise setup's real planner, on the references sync recorded, with Git restricted to file
  // transport. The only HTTPS source is contributed, so it must be reported as requiring access, never push access.
  const planning = Bun.spawnSync([process.execPath, "--no-install", "-e", `
    import {planGithub} from ${JSON.stringify(join(import.meta.dir, "github.ts"))};
    import {appliedReferences} from ${JSON.stringify(join(import.meta.dir, "applied-references.ts"))};
    import {loadOffice} from ${JSON.stringify(join(import.meta.dir, "office.ts"))};
    const office = loadOffice(process.cwd());
    const applied = appliedReferences(office.dir, office);
    if (!applied.ok) throw new Error(applied.errors.join("; "));
    console.log(JSON.stringify(await planGithub(office, applied.value)));
  `], { cwd: dir, env });

  expect(planning.exitCode, planning.stderr.toString()).toBe(0);
  expect(JSON.parse(planning.stdout.toString())).toEqual({
    hosts: ["github.com"], private: [{ what: "reference floci", url: "https://github.com/floci-io/floci.git", pushes: false }], pushes: [], needed: true,
  });
  expect(newer(1, "sync", "--packages")).toContain("FAILED package aws-emulator: changed built-in collector");
  // A broken replacement leaves the installed native definition and its delivered settings in place.
  expect(delivered.map(read)).toEqual(before);
  // The set's built-in copies came from the other executable; each matches its own record, so it loads.
  expect(newer(0, "references", "list")).toMatch(/floci\t.*main\tpackage aws-emulator\n/);
  expect(cli(0, "references", "list")).toMatch(/floci\t.*main\tpackage aws-emulator\n/);
  const repo = join(root, "tags");
  const installed = join(dir, ".office/packages/docs");
  git(["init", "-qb", "main", repo]);
  writePackage(join(repo, "pkg/office.ts"), collector("approved:A"), { name: "docs" });
  const first = commit(repo);
  git(["tag", "v1"], repo);
  const pin = (ref: string) => select(`  - {name: docs, repo: ${repo}, path: pkg, ref: ${ref}}\n`);
  pin("v1");
  cli(0, "sync", "--packages");
  writePackage(join(repo, "pkg/office.ts"), `${marker} ${collector("unapproved:B", "main", 'throw Error("refused B");')}`, { name: "docs" });
  git(["tag", "-f", "v1", commit(repo)], repo);
  rmSync(installed, { recursive: true });
  // An update to where the tag points now is refused, and never repairs the lost copy at its commit.
  expect(cli(1, "packages", "update")).toContain("refused B");
  expect(existsSync(installed)).toBe(false);
  rmSync(probe);
  // Sync repairs it at the locked commit, without importing the tag's.
  cli(0, "sync", "--packages");
  expect(JSON.parse(read(join(installed, ".source.json")))).toMatchObject({ commit: first, ref: "v1" });
  expect(cli(0, "references", "list")).toContain("approved:A");
  expect(existsSync(probe)).toBe(false);
  pin(first);
  cli(0, "sync", "--packages");
  rmSync(installed, { recursive: true });
  renameSync(repo, repo + "-offline");
  expect(cli(1, "sync", "--packages")).toContain(`${repo}:pkg @ ${first} (revision ${first})`);
  // The set publishes without the package it couldn't fetch, whose references are then unknown.
  expect(published(dir)).not.toContain("approved:A");
  expect(cli(1, "references", "list")).toContain("package docs: rejected by the last sync; run office sync");
  expect(existsSync(installed)).toBe(false);
}, 60_000);

test("an overlapping or interrupted collector cannot republish an explicitly withdrawn reference", async () => {
  const { dir, cli, env, select } = fixture("overlap");
  const repo = join(root, "overlap-origin");
  git(["init", "-qb", "main", repo]);
  write(join(repo, "document"), "original");
  commit(repo);
  const checkout = join(dir, "references/docs/document");
  const module = join(dir, "packages/docs/office.ts");
  select("  - name: docs\n");
  writePackage(module, collector(repo));
  cli(0, "sync");
  write(checkout, "keep after withdrawal");
  writePackage(module, collector(repo, "main", 'console.log("collection-paused"); await Bun.stdin.text();'));

  const pause = async () => {
    // Its own process group: the collector runs in a child `office` that holds the publication lease.
    const child = Bun.spawn([exe, "--office", dir, "sync", "--packages"], { env, cwd: root, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true });
    const reader = child.stdout.getReader();
    let output = "";

    while (!output.includes("collection-paused")) {
      const chunk = await reader.read();

      if (chunk.done) throw new Error(`collector exited before barrier: ${output}${await new Response(child.stderr).text()}`);
      output += Buffer.from(chunk.value).toString();
    }

    reader.releaseLock();

    return child;
  };

  // Kill the whole command, as a crashed terminal would, and wait until none of its processes (and
  // so no holder of the lease) is left: killing only the parent leaves its collector running.
  const killed = await pause();
  process.kill(-killed.pid, "SIGKILL");
  await killed.exited;

  for (let i = 0; ; i++) {
    try { process.kill(-killed.pid, 0); } catch { break; }

    if (i === 250) throw new Error("the killed sync's processes did not exit");
    await Bun.sleep(20);
  }

  const old = await pause();

  try {
    select("");
    cli(0, "sync", "--packages");
    old.stdin.end();
    expect(await old.exited).toBe(1);
    expect(cli(0, "references", "list")).not.toContain("docs\t");
    cli(0, "sync", "--references");
    expect(read(checkout)).toBe("keep after withdrawal");
  } finally {
    old.kill();
  }

  // Even identical YAML can produce a newer explicit empty result after editing office.ts.
  select("  - name: docs\n");
  const empty = definitionText('{setup(){}}');
  const paused = read(module);
  writePackage(module, empty);
  cli(0, "sync", "--packages");
  const unchanged = read(join(dir, ".office/resolved/references.json"));
  writePackage(module, paused);
  const superseded = await pause();

  try {
    writePackage(module, empty);
    cli(0, "sync", "--packages");
    expect(read(join(dir, ".office/resolved/references.json"))).toBe(unchanged);
    superseded.stdin.end();
    expect(await superseded.exited).toBe(1);
    expect(cli(0, "references", "list")).not.toContain("docs\t");
    cli(0, "sync", "--references");
    expect(read(checkout)).toBe("keep after withdrawal");
  } finally {
    superseded.kill();
  }
}, 60_000);

test.skipIf(process.getuid?.() === 0)("an inaccessible applied file fails its readers closed; genuine absence reads office.yaml; commands never read it", () => {
  const { dir, cli } = fixture("read-errors");
  const folder = join(dir, ".office/resolved");
  const repo = join(root, "legacy-origin");
  git(["init", "-qb", "main", repo]);
  write(join(repo, "document"), "legacy");
  commit(repo);
  write(join(dir, "office.yaml"), `name: legacy\nreferences: [{name: legacy, url: ${repo}}]\n`);
  chmodSync(folder, 0);

  try {
    expect(cli(0, "references", "list")).toContain(`legacy\t${repo}\toffice.yaml`);
    expect(cli(1, "sync", "--references")).toContain("EACCES");
    expect(existsSync(join(dir, "references/legacy"))).toBe(false);
    const applied = appliedReferences(dir, loadOffice(dir));
    expect(applied.ok ? "" : applied.errors.join("\n")).toContain("EACCES");
  } finally {
    chmodSync(folder, 0o700);
  }

  // Package commands never read the applied file: replacing it with text that isn't JSON changes nothing.
  const listing = cli(0, "references", "list");
  expect(listing).toContain(`legacy\t${repo}\toffice.yaml`);
  write(join(folder, "references.json"), "{");
  expect(cli(0, "references", "list")).toBe(listing);
  cli(1, "sync", "--references");
  expect(existsSync(join(dir, "references/legacy"))).toBe(false);
  rmSync(realpathSync(join(folder, "references.json")));
  expect(cli(0, "references", "list")).toBe(listing);
  cli(0, "sync", "--references");
  expect(read(join(dir, "references/legacy/document"))).toBe("legacy");
}, 60_000);

test("the executable syncs mixed definitions and keeps applied state when a selected definition cannot be read", () => {
  const { dir, cli, select } = fixture("mixed");
  const pkg = join(dir, "packages/notes");
  const link = join(dir, ".opencode/plugins/notes");
  const pins = join(dir, "machine.packages.toml");
  const module = definitionText('{ settings: { type: "object", additionalProperties: false, properties: { count: { type: "integer", default: count } } }, tools: { jq: "1.7.1" } }', 'import { count } from "./defaults.ts";');

  select("  - name: legacy\n  - name: notes\n");
  writePackage(join(dir, "packages/legacy/package.yaml"), "# Legacy\nsettings: { type: object, additionalProperties: false, properties: { label: { type: string, default: old } } }\n");
  writePackage(join(pkg, "office.ts"), module);
  write(join(pkg, "defaults.ts"), "export const count: number = 3;");
  write(join(pkg, "plugin/index.ts"), 'export default { id: "notes", setup() {} }');
  write(join(pkg, "compose.yaml"), "services:\n  notes:\n    image: example/notes\n");
  write(join(pkg, "seed/notes/example"), "seed");
  cli(0, "sync");
  expect(read(join(dir, "notes/example"))).toBe("seed");
  expect(JSON.parse(read(join(dir, "packages/legacy/.settings.json")))).toEqual({ label: "old" });
  expect(JSON.parse(read(join(pkg, ".settings.json")))).toEqual({ count: 3 });
  expect(cli(0, "check")).toMatch(/ok   package notes: .*compose.yaml contributes services notes/);
  write(join(pkg, "defaults.ts"), "export const count: number = 7;");
  write(join(dir, "notes/example"), "owner");
  cli(0, "sync", "--packages");
  const applied = read(pins);

  expect(applied).toContain('"jq" = "1.7.1" # notes');

  // Every unreadable definition fails the same way (src/package-definition.test.ts covers the kinds).
  const reason = "packages/notes/office.ts: bad notes import";
  writePackage(join(pkg, "office.ts"), 'throw new Error("bad notes import")');
  expect(cli(1, "sync", "--packages")).toContain(reason);
  expect(cli(1, "check")).toContain(reason);
  expect(readlinkSync(link)).toBe("../../packages/notes/plugin");
  expect(read(pins)).toBe(applied);
  expect(JSON.parse(read(join(pkg, ".settings.json")))).toEqual({ count: 7 });
  expect(read(join(dir, "notes/example"))).toBe("owner");

  select("  - name: legacy\n");
  cli(0, "sync", "--packages");
  expect(existsSync(link)).toBe(false);
  expect(read(pins)).not.toContain('"jq"');
  expect(read(join(dir, "notes/example"))).toBe("owner");
  expect(existsSync(join(dir, "node_modules"))).toBe(false);
}, 60_000);
