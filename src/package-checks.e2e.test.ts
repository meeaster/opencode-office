// The check before loading, in the compiled office: with any problem in the selection, no
// package's code runs, and a command, help and sync each name it.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.ts";
import { definitionFixture } from "./package-definition.fixture.ts";
import { definitionText, writePackage } from "./test-package.ts";

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
  const current = join(dir, ".office/current");
  const before = readlinkSync(current);
  const generations = readdirSync(join(dir, ".office/generations")).length;
  // A valid package earlier in the selection doesn't load either.
  select("  - name: early\n  - name: needy\n");
  writePackage(join(dir, "packages/early/office.ts"), definitionText('{}', 'import {appendFileSync} from "node:fs"; appendFileSync(process.env.PROBE + "-early", "imported\\n");'));
  writePackage(join(dir, "packages/needy/office.ts"), definitionText(`{commands:{"needy run":{summary:"run",run(){}}}}`, `${marker}`), { dependencies: ["absent", "references"] });
  const problem = "package needy: depends on @office/absent, which isn't selected; add it to office.yaml";

  expect(cli(1, "sync", "--packages")).toContain(problem);
  expect(readlinkSync(current)).toBe(before);
  expect(readdirSync(join(dir, ".office/generations")).length).toBe(generations);
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

test("a package whose .settings.json can't be read fails check alone, and the next package is still checked", () => {
  const { dir, cli, select } = fixture("unreadable-settings");

  writePackage(join(dir, "packages/blocked/office.ts"), definitionText("{}"));
  writePackage(join(dir, "packages/healthy/office.ts"), definitionText("{}"));
  select("  - name: blocked\n  - name: healthy\n");
  cli(0, "sync", "--packages");
  rmSync(join(dir, "packages/blocked/.settings.json"));
  mkdirSync(join(dir, "packages/blocked/.settings.json"));

  const checked = cli(1, "check");

  expect(checked).toMatch(/^FAIL\s+package blocked: .*packages\/blocked\/\.settings\.json can't be read: .*EISDIR/m);
  expect(checked).toMatch(/^ok\s+package healthy\b/m);
});
