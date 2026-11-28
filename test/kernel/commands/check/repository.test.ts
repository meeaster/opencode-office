import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Report } from "../../../../src/commands/check/context.ts";
import { versionChecks } from "../../../../src/commands/check/repository.ts";
import { loadOffice } from "../../../../src/office.ts";
import { defaultPins, writeApplied, writeLock } from "../../../../src/versions.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-check-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function versionReports(office: ReturnType<typeof loadOffice>) {
  const reports: Parameters<Report>[] = [];

  versionChecks(office, (...result) => { reports.push(result); });

  return reports;
}

test.each(["2.0.0-beta.64", "2.0.0-beta.48"])("a locked and applied Executor %s passes the pin checks", (version) => {
  writeFileSync(join(dir, "office.yaml"), `name: t\nstate: ./state\ntools:\n  executor: ${version}\n`);

  const office = loadOffice(dir);
  const pins = { ...defaultPins, executor: { ...defaultPins.executor, version } };
  writeLock(dir, pins);
  writeApplied(office, pins, undefined);
  const reports = versionReports(office);

  expect(reports).toEqual([[true, "versions", expect.stringContaining(`executor ${version}`)]]);
});

test("an Executor downgrade stays pending and refused, and other tools retain their tested ranges", () => {
  writeFileSync(join(dir, "office.yaml"), "name: t\nstate: ./state\ntools:\n  executor: 2.0.0-beta.48\n  sfw: 1.0.0\n");

  const office = loadOffice(dir);
  writeLock(dir, { ...defaultPins, executor: { ...defaultPins.executor, version: "2.0.0-beta.48" }, sfw: { ...defaultPins.sfw, version: "1.0.0" } });
  writeApplied(office, { ...defaultPins, executor: { ...defaultPins.executor, version: "2.0.0-beta.64" } }, undefined);
  const reports = versionReports(office);

  expect(reports).toContainEqual(["warn", "pending upgrade", expect.stringContaining("executor 2.0.0-beta.64 → 2.0.0-beta.48 (refused: older than the 2.0.0-beta.64 this office has run)")]);
  expect(reports).toContainEqual(["warn", "tested versions", expect.stringMatching(/^sfw 1\.0\.0 is outside/)]);
});
