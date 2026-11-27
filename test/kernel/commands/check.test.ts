import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOffice } from "../../../src/office.ts";
import { silentStage } from "../../../src/report/index.ts";
import { defaultPins, writeApplied, writeLock } from "../../../src/versions.ts";
import { check } from "../../../src/commands/check.ts";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-check-"));
  path = process.env.PATH ?? "";
  const bin = join(dir, "bin");

  mkdirSync(bin);
  writeFileSync(join(bin, "docker"), '#!/bin/sh\ncase "$*" in "compose "*" ps --status running --format {{.Service}}") exit 0;; *) exit 1;; esac\n', { mode: 0o755 });
  process.env.PATH = `${bin}:${path}`;
});

afterEach(() => {
  process.env.PATH = path;
  rmSync(dir, { recursive: true, force: true });
});

async function checkLines() {
  const lines: string[] = [];
  const collect = (line: string) => { lines.push(line); };

  await check(loadOffice(dir), { ...silentStage, note: collect, warn: collect, error: collect }, true);

  return lines;
}

test.each(["2.0.0-beta.64", "2.0.0-beta.48"])("a locked and applied Executor %s passes the pin checks", async (version) => {
  writeFileSync(join(dir, "office.yaml"), `name: t\nstate: ./state\ntools:\n  executor: ${version}\n`);

  const office = loadOffice(dir);
  const pins = { ...defaultPins, executor: { ...defaultPins.executor, version } };
  writeLock(dir, pins);
  writeApplied(office, pins, undefined);
  const lines = await checkLines();

  expect(lines.find(line => line.startsWith("ok   versions:"))).toContain(`executor ${version}`);
  expect(lines.some(line => /^WARN (tested versions|pending upgrade):/.test(line))).toBe(false);
});

test("an Executor downgrade stays pending and refused, and other tools retain their tested ranges", async () => {
  writeFileSync(join(dir, "office.yaml"), "name: t\nstate: ./state\ntools:\n  executor: 2.0.0-beta.48\n  sfw: 1.0.0\n");

  const office = loadOffice(dir);
  writeLock(dir, { ...defaultPins, executor: { ...defaultPins.executor, version: "2.0.0-beta.48" }, sfw: { ...defaultPins.sfw, version: "1.0.0" } });
  writeApplied(office, { ...defaultPins, executor: { ...defaultPins.executor, version: "2.0.0-beta.64" } }, undefined);
  const lines = await checkLines();

  expect(lines).toContainEqual(expect.stringMatching(/^WARN pending upgrade: .*executor 2\.0\.0-beta\.64 → 2\.0\.0-beta\.48 \(refused: older than the 2\.0\.0-beta\.64 this office has run\)/));
  expect(lines).toContainEqual(expect.stringMatching(/^WARN tested versions: sfw 1\.0\.0 is outside/));
});

test("a mise minimum_release_age setting in machine.toml or mise.toml other than the office's is noted, since the environment wins", async () => {
  writeFileSync(join(dir, "office.yaml"), "name: t\nminimum_release_age: 1d\n");
  writeFileSync(join(dir, "machine.toml"), '[settings]\nminimum_release_age = "24h"\n');
  writeFileSync(join(dir, "mise.toml"), '[tools]\nnode = "26.13.1"\n');
  expect((await checkLines()).filter(line => line.startsWith("WARN tools:"))).toEqual([]);

  writeFileSync(join(dir, "mise.toml"), '[settings]\nminimum_release_age = "7d"\n');
  expect((await checkLines()).filter(line => line.startsWith("WARN tools:"))).toEqual([
    `WARN tools: mise.toml sets minimum_release_age = "7d" under [settings], but the office's environment sets MISE_MINIMUM_RELEASE_AGE=1d (minimum_release_age in office.yaml), which wins wherever it is loaded; remove the setting or change the office's age`,
  ]);
});
