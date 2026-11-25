import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOffice } from "../office.ts";
import { defaultPins, writeApplied, writeLock } from "../versions.ts";
import { toolsNotes, versionChecks } from "./check.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-check-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test.each(["2.0.0-beta.64", "2.0.0-beta.48"])("a locked and applied Executor %s passes the pin checks", (version) => {
  writeFileSync(join(dir, "office.yaml"), `name: t\nstate: ./state\ntools:\n  executor: ${version}\n`);

  const office = loadOffice(dir);
  const pins = { ...defaultPins, executor: { ...defaultPins.executor, version } };
  const report = mock();

  writeLock(dir, pins);
  writeApplied(office, pins, undefined);
  versionChecks(office, report);
  expect(report.mock.calls).toEqual([[true, "versions", expect.stringContaining(`executor ${version}`)]]);
});

test("an Executor downgrade stays pending and refused, and other tools retain their tested ranges", () => {
  writeFileSync(join(dir, "office.yaml"), "name: t\nstate: ./state\ntools:\n  executor: 2.0.0-beta.48\n  sfw: 1.0.0\n");

  const office = loadOffice(dir);
  const report = mock();

  writeLock(dir, { ...defaultPins, executor: { ...defaultPins.executor, version: "2.0.0-beta.48" }, sfw: { ...defaultPins.sfw, version: "1.0.0" } });
  writeApplied(office, { ...defaultPins, executor: { ...defaultPins.executor, version: "2.0.0-beta.64" } }, undefined);
  versionChecks(office, report);
  expect(report).toHaveBeenCalledWith("warn", "pending upgrade", expect.stringContaining("executor 2.0.0-beta.64 → 2.0.0-beta.48 (refused: older than the 2.0.0-beta.64 this office has run)"));
  expect(report).toHaveBeenCalledWith("warn", "tested versions", expect.stringMatching(/^sfw 1\.0\.0 is outside/));
});

test("a mise minimum_release_age setting in machine.toml or mise.toml other than the office's is noted, since the environment wins", () => {
  writeFileSync(join(dir, "office.yaml"), "name: t\nminimum_release_age: 1d\n");
  writeFileSync(join(dir, "machine.toml"), '[settings]\nminimum_release_age = "24h"\n');
  writeFileSync(join(dir, "mise.toml"), '[tools]\nnode = "26.13.1"\n');
  expect(toolsNotes(loadOffice(dir))).toEqual([]);

  writeFileSync(join(dir, "mise.toml"), '[settings]\nminimum_release_age = "7d"\n');
  expect(toolsNotes(loadOffice(dir))).toEqual([
    `mise.toml sets minimum_release_age = "7d" under [settings], but the office's environment sets MISE_MINIMUM_RELEASE_AGE=1d (minimum_release_age in office.yaml), which wins wherever it is loaded; remove the setting or change the office's age`,
  ]);
});
