// Packages' full-sync work and session text in the compiled office, with the example `mirrors`
// package. Full-sync work: only a full
// sync runs it, after its own admission and application succeed; one item's failure is named and
// fails the sync while other packages' items and reference work complete; a fatal admission or
// sync function runs none of it.
import { expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.ts";
import { definitionFixture } from "./package-definition.fixture.ts";
import { definitionText, pluginDefinition, writePackage } from "./test-package.ts";
import { toolPath } from "./tool.ts";

const { root, bin, write, commit, fixture, promptEntries } = definitionFixture({ second: false });
const example = toolPath("examples/package-work/packages/mirrors");

/** A bare repository with one commit, as a file URL. */
function upstream(name: string) {
  const work = join(root, `${name}-work`);
  const bare = join(root, `${name}.git`);

  mkdirSync(work, { recursive: true });
  git(["init", "-q", "-b", "main", work]);
  writeFileSync(join(work, "README.md"), `${name}\n`);
  commit(work);
  git(["clone", "-q", "--bare", work, bare]);

  return `file://${bare}`;
}

/** A host-mode office selecting the example and a package whose sync and full-sync work leave a trace in PROBE. */
function office(name: string) {
  const f = fixture(name);
  const log = join(f.home, "git.log");

  cpSync(example, join(f.dir, "packages/mirrors"), { recursive: true });
  writePackage(join(f.dir, "packages/tracer/office.ts"), definitionText(`{
    sync() { appendFileSync(process.env.PROBE, "sync\\n"); },
    fullSync: () => [{ item: "trace", run(output) { output("traced"); appendFileSync(process.env.PROBE, "full\\n"); return { ok: true, summary: "traced" }; } }],
  }`, 'import { appendFileSync } from "node:fs";'));
  // Every Git command of every process, so a test sees which ran.
  write(join(f.home, "bin/git"), `#!/bin/sh\necho "$*" >> "${log}"\nexec "${bin}/git" "$@"\n`, 0o755);

  const manual = upstream(`${name}-manual`);

  const yaml = (mirrors: string, extra = "") => writeFileSync(join(f.dir, "office.yaml"), `name: ${name}\nopencode: {mode: host, url: 'http://127.0.0.1:1'}\ntools: {sfw: {enabled: false}}\nreferences:\n  - {name: manual, url: '${manual}', ref: main, description: A reference}\npackages:\n  - name: mirrors\n    settings:\n      mirrors:\n${mirrors}  - name: tracer\n${extra}`);

  const trace = () => existsSync(f.probe) ? readFileSync(f.probe, "utf8").trim().split("\n") : [];

  // The mirrors' checks: ls-remote of a mirror's repository, not of a package's or a reference's.
  const lsRemotes = () => existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(line => /^ls-remote .*(healthy|absent)\.git HEAD$/.test(line)).length : 0;

  return { ...f, yaml, trace, lsRemotes };
}

test("only a full sync runs packages' full-sync work; a failed item is named and fails the sync while other items and references complete", () => {
  const o = office("full-work");
  const healthy = upstream("healthy");

  // A Git package that follows a branch, so `office packages update` has something to apply.
  const remote = join(root, "remote-work");

  mkdirSync(remote);
  git(["init", "-q", "-b", "main", remote]);
  writePackage(join(remote, "pkg/office.ts"), definitionText("{}"), { name: "remote-kit" });
  const first = commit(remote);
  const selected = `  - name: remote-kit\n    repo: 'file://${remote}'\n    path: pkg\n    ref: ${first}\n    track: main\n`;

  o.yaml(`        - {name: healthy, description: Reachable mirror, url: '${healthy}'}\n        - {name: gone, description: Missing mirror, url: 'file://${root}/absent.git'}\n        - {name: notes, description: Local only}\n`, selected);

  const full = o.cli(1, "sync");

  expect(full).toContain("mirrors: gone: FAILED: fatal: '");
  expect(full).toMatch(/FAILED: 1 cloned, \d+ other changes, 1 failed/);
  expect(full).toMatch(/mirrors: healthy[^\n]*reachable/);
  expect(full).toMatch(/tracer: trace[^\n]*traced/);
  expect(existsSync(join(o.dir, "references/manual/README.md"))).toBe(true);
  expect(o.trace()).toEqual(["sync", "full"]);
  expect(o.lsRemotes()).toBe(2);

  // Package-only operations run the packages' sync functions but no full-sync work.
  o.cli(0, "sync", "--packages");
  writePackage(join(remote, "pkg/office.ts"), definitionText("{ committed: [] }"), { name: "remote-kit" });
  const second = commit(remote);

  expect(o.cli(0, "packages", "update")).toContain(second);
  expect(readFileSync(join(o.dir, "office.yaml"), "utf8")).toContain(`ref: ${second}`);
  expect(o.trace()).toEqual(["sync", "full", "sync", "sync"]);
  expect(o.lsRemotes()).toBe(2);

  // Without the failing mirror, the same full sync succeeds.
  o.yaml(`        - {name: healthy, description: Reachable mirror, url: '${healthy}'}\n`, selected.replace(first, second));
  o.cli(0, "sync");
  expect(o.lsRemotes()).toBe(3);
});

test("a fatal admission or sync function runs no full-sync work, from this set or the one before", () => {
  const o = office("fatal-work");
  const healthy = upstream("fatal-healthy");

  o.yaml(`        - {name: healthy, description: Reachable mirror, url: '${healthy}'}\n`);
  o.cli(0, "sync");
  expect(o.trace()).toEqual(["sync", "full"]);

  // A setting the schema rejects: admission fails, so the published set's work must not run.
  o.yaml(`        - {name: healthy, url: '${healthy}'}\n`);
  const rejected = o.cli(1, "sync");

  expect(rejected).toContain("no package set was published");
  expect(rejected).toContain("no package's full-sync work ran");
  expect(o.trace()).toEqual(["sync", "full"]);
  expect(o.lsRemotes()).toBe(1);

  // A sync function that throws keeps stopping the sync there, as before.
  o.yaml(`        - {name: healthy, description: Reachable mirror, url: '${healthy}'}\n`, "  - name: breaker\n");
  writePackage(join(o.dir, "packages/breaker/office.ts"), definitionText('{ sync() { throw Error("breaker broke"); } }'));
  const stopped = o.cli(1, "sync");

  expect(stopped).toContain("package breaker: its sync failed: breaker broke; the new package set is active and the rest of this sync did not run");
  expect(o.lsRemotes()).toBe(1);
  expect(o.trace()).toEqual(["sync", "full", "sync"]);
});

test("a package's session text reaches the office plugin from the applied settings, and is gone once a sync withdraws the package", async () => {
  const o = office("session-text");

  o.yaml("        - {name: notes, description: Shared notes, url: 'https://example.invalid/notes.git'}\n        - {name: diary, description: Local only}\n");
  o.cli(0, "sync", "--packages");
  const text = "# Mirrors\n\n- notes: Shared notes (https://example.invalid/notes.git)\n- diary: Local only (local only)\n";

  expect(o.cli(0, "instructions", "--packages")).toEndWith(text);
  expect((await promptEntries(o.dir, join(o.dir, "knowledge"))).packages).toBe(text.trim());

  // An edit sync hasn't applied changes nothing, and a newly selected, unsynced package blocks no other's text.
  o.yaml("        - {name: notes, description: Edited, url: 'https://example.invalid/notes.git'}\n", "  - name: unsynced\n");
  writePackage(join(o.dir, "packages/unsynced/office.ts"), definitionText("{ session: () => 'unsynced' }"));
  expect(o.cli(0, "instructions", "--packages")).toEndWith(text);

  o.yaml("        - {name: notes, description: Edited, url: 'https://example.invalid/notes.git'}\n");
  o.cli(0, "sync", "--packages");
  expect(o.cli(0, "instructions", "--packages")).toContain("- notes: Edited");

  writeFileSync(join(o.dir, "office.yaml"), readFileSync(join(o.dir, "office.yaml"), "utf8").replace(/ {2}- name: mirrors\n[\s\S]*?(?= {2}- name: tracer)/, ""));
  o.cli(0, "sync", "--packages");
  expect(o.cli(0, "instructions", "--packages")).not.toContain("Mirrors");
  expect(await promptEntries(o.dir, o.dir)).not.toHaveProperty("packages");
});

test("a failed step of this sync's application runs no full-sync work, while references still complete", () => {
  const o = office("failed-apply");
  const healthy = upstream("failed-apply-healthy");

  // A package plugin whose link destination holds the owner's own plugin folder: application fails there.
  writePackage(join(o.dir, "packages/plugged/office.ts"), pluginDefinition(), { dependencies: ["opencode"] });
  write(join(o.dir, "packages/plugged/plugin/index.js"), "export default {};\n");
  write(join(o.dir, ".opencode/plugins/plugged/index.js"), "// the owner's own\n");
  o.yaml(`        - {name: healthy, description: Reachable mirror, url: '${healthy}'}\n`, "  - name: plugged\n");

  const output = o.cli(1, "sync");

  expect(output).toContain("not a link office sync made");
  expect(output).toContain("no package's full-sync work ran");
  expect(o.trace()).toEqual(["sync"]);
  expect(o.lsRemotes()).toBe(0);
  expect(existsSync(join(o.dir, "references/manual/README.md"))).toBe(true);
  expect(readFileSync(join(o.dir, ".opencode/plugins/plugged/index.js"), "utf8")).toBe("// the owner's own\n");
});

test("full-sync work that leaves a line sync can't read, or an item unsettled, fails the sync", () => {
  const o = office("unsettled-work");

  writePackage(join(o.dir, "packages/garbler/office.ts"), definitionText(`{
    fullSync: () => [{ item: "garble", run() { writeSync(4, "not an event\\n"); return { ok: true }; } }],
  }`, 'import { writeSync } from "node:fs";'));
  o.yaml("        - {name: diary, description: Local only}\n", "  - name: garbler\n");
  expect(o.cli(1, "sync")).toContain("FAILED packages' full-sync work: the package reader sent a line sync can't read");

  writePackage(join(o.dir, "packages/garbler/office.ts"), definitionText(`{
    fullSync: () => [{ item: "quit", run(output) { output("leaving"); process.exit(0); } }],
  }`));
  expect(o.cli(1, "sync")).toContain("garbler: quit: FAILED: it stopped before it finished");
});

test("a package that doesn't load leaves the other packages' last applied session text", () => {
  const o = office("unread-text");

  o.yaml("        - {name: diary, description: Local only}\n");
  o.cli(0, "sync", "--packages");
  const text = o.cli(0, "instructions", "--packages");

  expect(text).toContain("- diary: Local only");
  // A Git package this sync can't fetch is rejected and stays selected, unread.
  o.yaml("        - {name: diary, description: Local only}\n", `  - name: ghost\n    repo: 'file://${root}/absent.git'\n    path: pkg\n    ref: main\n`);
  o.cli(1, "sync", "--packages");
  const kept = o.cli(0, "instructions", "--packages");

  expect(kept).toContain(text.trim());
  expect(kept).toContain("no session text from package ghost: rejected by the last sync");
});
