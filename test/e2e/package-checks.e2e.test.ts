// The check before loading, in the compiled office: with any problem in the selection, no
// package's code runs, and a command, help and sync each name it.
import { expect, test } from "bun:test";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../src/git.ts";
import { definitionFixture } from "../support/package-definition.fixture.ts";
import { definitionText, writePackage } from "../support/test-package.ts";

const { root, exe, marker, write, commit, fixture } = definitionFixture();

test("a consumer earlier in the selection never runs a pulled-in provider's edited module", () => {
  const { dir, probe, cli, select } = fixture("edited-provider");
  const repo = join(root, "edited-provider-source");
  git(["init", "-q", "-b", "main", repo]);
  writePackage(join(repo, "provider/office.ts"), definitionText('{}'), { exports: { ".": "./index.ts" } });
  write(join(repo, "provider/index.ts"), 'export const value = "clean";');
  commit(repo);
  select(`  - name: consumer\n  - {name: provider, repo: ${repo}, path: provider, ref: main}\n`);
  writePackage(join(dir, "packages/consumer/office.ts"), definitionText(`{commands:{"consumer show":{summary:"show",run(){console.log(value)}}}}`, `import {value} from "@office/provider";`), { dependencies: ["provider"] });
  cli(0, "sync", "--packages");
  expect(cli(0, "consumer", "show")).toContain("clean");

  write(join(dir, ".office/packages/provider/index.ts"), `${marker} export const value = "edited";`);
  expect(cli(1, "consumer", "show")).toContain("package provider: package files edited: index.ts (edited)");
  const help = cli(0, "--help");
  expect(help).toContain("package provider: package files edited: index.ts (edited)");
  expect(help).not.toContain("consumer show");
  // Every other reader of definitions checks the whole selection first too.
  const checked = cli(1, "check");
  expect(existsSync(probe)).toBe(false);
  expect(checked).toContain("FAIL package provider: package files edited: index.ts (edited)");
  expect(checked).toContain("FAIL package consumer: not loaded");
  expect(cli(1, "cron", "list")).toContain("package provider: package files edited: index.ts (edited)");
  expect(existsSync(probe)).toBe(false);
  // Sync restores the copy before anything loads it.
  expect(cli(0, "sync", "--packages")).toContain("restored .office/packages/provider to its copy of main");
  expect(existsSync(probe)).toBe(false);
  expect(cli(0, "consumer", "show")).toContain("clean");
});

test("a declared dependency that isn't selected stops sync and commands before any package loads", () => {
  const { dir, probe, cli, select } = fixture("absent-dependency");
  const installed = join(dir, ".office/packages/office");
  const before = lstatSync(installed).ino;
  // A valid package earlier in the selection doesn't load either.
  select("  - name: early\n  - name: needy\n");
  writePackage(join(dir, "packages/early/office.ts"), definitionText('{}', 'import {appendFileSync} from "node:fs"; appendFileSync(process.env.PROBE + "-early", "imported\\n");'));
  writePackage(join(dir, "packages/needy/office.ts"), definitionText(`{commands:{"needy run":{summary:"run",run(){}}}}`, `${marker}`), { dependencies: ["absent", "references"] });
  const problem = "package needy: depends on @office/absent, which isn't selected; add it to office.yaml";

  expect(cli(1, "sync", "--packages")).toContain(problem);
  expect(lstatSync(installed).ino).toBe(before);
  expect(readdirSync(join(dir, ".office/tmp"))).toEqual([]);
  const blocked = cli(1, "needy", "run");
  expect(blocked).toContain(problem);
  expect(blocked).toContain("needy run: unknown command, or a package command that can't run");
  expect(existsSync(probe)).toBe(false);
  expect(existsSync(`${probe}-early`)).toBe(false);
});

test("an office never synced loads no package: the required built-ins aren't there yet", () => {
  const { env } = fixture("never-synced-runner");
  const dir = join(root, "never-synced");
  write(join(dir, "office.yaml"), "name: never-synced\npackages:\n  - name: early\n");
  writePackage(join(dir, "packages/early/office.ts"), definitionText(`{}`, `${marker}`));
  const result = Bun.spawnSync([exe, "--office", dir, "check"], { cwd: root, env });
  const output = result.stdout.toString() + result.stderr.toString();

  expect(result.exitCode, output).toBe(1);
  expect(output).toContain("package tooling: not synced yet; run office sync");
  expect(existsSync(env.PROBE)).toBe(false);
});

test("check reports a package's applied settings that differ, are missing or malformed, and an entry for a package no longer selected, without writing", () => {
  const { dir, cli, select } = fixture("applied-settings-drift");
  const snapshot = join(dir, ".office/runtime/settings.json");

  writePackage(join(dir, "packages/blocked/office.ts"), definitionText("{}"));
  writePackage(join(dir, "packages/healthy/office.ts"), definitionText("{}"));
  select("  - name: blocked\n  - name: healthy\n");
  cli(0, "sync", "--packages");
  const published = JSON.parse(readFileSync(snapshot, "utf8"));

  expect(published.packages).toMatchObject({ blocked: {}, healthy: {} });
  writeFileSync(snapshot, JSON.stringify({ packages: { ...published.packages, blocked: { stale: true }, gone: {} } }));
  const edited = readFileSync(snapshot, "utf8");
  let checked = cli(1, "check");

  expect(checked).toMatch(/^FAIL\s+package blocked: .*settings valid, but \.office\/runtime\/settings\.json holds other settings for it; office sync publishes them/m);
  expect(checked).toMatch(/^ok\s+package healthy: .*settings valid and applied/m);
  expect(checked).toContain(".office/runtime/settings.json holds settings for package gone, which office.yaml no longer selects (office sync removes them)");
  expect(readFileSync(snapshot, "utf8")).toBe(edited);

  writeFileSync(snapshot, "{");
  checked = cli(1, "check");
  expect(checked).toMatch(/^FAIL\s+package healthy: .*settings\.json is malformed: .*run office sync to publish it again/m);
  expect(readFileSync(snapshot, "utf8")).toBe("{");

  rmSync(snapshot);
  expect(cli(1, "check")).toMatch(/^FAIL\s+package healthy: .*settings valid, but no applied settings at .*settings\.json/m);
  expect(existsSync(snapshot)).toBe(false);

  cli(0, "sync", "--packages");
  expect(cli(0, "check")).toMatch(/^ok\s+package blocked: .*settings valid and applied/m);
});
