import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import * as v from "valibot";
import { parse } from "yaml";

import { loadOffice } from "../../src/office.ts";
import { recordRequiredFixtures } from "../../src/test-builtin-record.ts";
import { check, officeSchema } from "../../src/schema.ts";
import { unitDirVariable } from "../../src/systemd.ts";
import { catchUpJob, supercronicInput } from "./container.ts";
import { namedJob, requireJobs } from "./discovery.ts";
import { cronTimers, installTimers, removeTimers, staleTimerUnits } from "./host.ts";
import { executeJob } from "./jobs.ts";

let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "office-cron-test-")); });

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function write(relative: string, text: string): void {
  const path = join(root, relative);

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const host = "opencode: { mode: host, url: 'http://127.0.0.1:49374' }\n";
const managed = "opencode: { mode: host, managed: true, url: 'http://127.0.0.1:49374' }\n";
const cron = "cron:\n  digest: { schedule: '0 6 * * *', script: cron/office.sh }\n";
const packageEntry = "  - name: demo\n";

function config(mode = "", packages = ""): void {
  write("office.yaml", `name: test\n${mode}${cron}${packages === "" ? "" : `packages:\n${packages}`}`);
}

function fixtures(): void {
  write("cron/office.sh", "printf '%s\\n' \"$PWD\" >> office-runs");
  write("cron/crontab", "0 6 * * * touch obsolete-input-ran\n");
  write(".office/packages/office/package.yaml", [
    "name: office", "description: Required package", "cron:",
    "  update: { schedule: '30 7 * * *', script: updater.sh, when: managed-host }",
  ].join("\n"));
  write(".office/packages/office/updater.sh", "true");
  recordRequiredFixtures(join(root, ".office/packages/office"));
  write("packages/demo/package.yaml", [
    "name: demo", "description: Demo", "cron:",
    "  digest: { schedule: '15 6 * * *', script: digest.sh }",
    "  container: { schedule: '@daily', script: digest.sh, when: container }",
    "  host: { schedule: '*/20 * * * MON', script: digest.sh, when: host }",
  ].join("\n"));
  write("packages/demo/digest.sh", "printf '%s\\n' \"$PWD\" >> package-runs");
}

test("collects both owners, applies predicates, and handles enabling, removal and required-package defaults", async () => {
  fixtures();
  config("", packageEntry);

  let office = loadOffice(root);
  let jobs = requireJobs(office);

  expect(supercronicInput(jobs)).toBe([
    "0 6 * * * office cron run office.digest",
    "15 6 * * * office cron run package.demo.digest",
    "0 0 * * * office cron run package.demo.container",
  ].join("\n"));
  expect(await executeJob(office, jobs[1])).toBe(0);
  expect(readFileSync(join(root, "package-runs"), "utf8")).toBe(`${root}\n`);
  expect(existsSync(join(root, "obsolete-input-ran"))).toBe(false);

  config(host, `${packageEntry}    cron: { digest: { enabled: false } }\n  - name: office\n    cron: { update: { enabled: true } }\n`);
  office = loadOffice(root);
  jobs = requireJobs(office);
  expect(cronTimers(office, jobs).map((timer) => [timer.description, timer.calendar])).toEqual([
    ["office.digest", "*-*-* 06:00:00 UTC"],
    ["package.demo.host", "Mon *-*-* *:00,20,40:00 UTC"],
  ]);

  config(managed, "  - name: office\n    cron: { update: { schedule: '15 9 * * *' } }\n");
  office = loadOffice(root);
  expect(cronTimers(office, requireJobs(office)).map((timer) => [timer.description, timer.calendar])).toEqual([
    ["office.digest", "*-*-* 06:00:00 UTC"], ["package.office.update", "*-*-* 09:15:00 UTC"],
  ]);
  config(managed, "  - name: office\n    cron: { update: { enabled: false } }\n");
  expect(requireJobs(loadOffice(root)).map((job) => job.id)).toEqual(["office.digest"]);
  config(managed);
  office = loadOffice(root);
  expect(cronTimers(office, requireJobs(office))[1].calendar).toBe("*-*-* 07:30:00 UTC");
});

test("refuses malformed declarations and unknown overrides, even when the job would not run", () => {
  fixtures();
  config("", "  - name: office\n    cron: { typo: { enabled: false } }\n");
  expect(() => requireJobs(loadOffice(root))).toThrow("packages.office.cron.typo: no such job");

  for (const entry of [
    "cron: { job: { schedule: '*/0 * * * *', script: run.sh } }",
    "cron: { job: { schedule: '0 99 * * *', script: run.sh } }",
    "cron: { job: { schedule: '0 0 * * *', script: ../run.sh } }",
    "cron: { job: { schedule: '0 0 * * *', script: /tmp/run.sh } }",
    "cron: { job: { schedule: '0 0 * * *', script: 'run.sh; id' } }",
    "cron: { constructor: { schedule: '@daily', script: run.sh } }",
    "packages: [{ name: office }, { name: office }]",
    "packages: [{ name: office, repo: repo, path: path, ref: ref }]",
    "packages: [{ name: office, cron: { update: { when: host } } }]",
    "packages: [{ name: office, cron: { update: { script: run.sh } } }]",
    "packages: [{ name: office, cron: { update: { enabled: 'false' } } }]",
  ]) {
    expect(check(v.safeParse(officeSchema, parse(`name: test\n${entry}`))).ok).toBe(false);
  }

  write(".office/packages/office/package.yaml", "name: office\ndescription: test\ncron: {update: {schedule: '@daily', script: updater.sh, when: external}}\n");
  recordRequiredFixtures(join(root, ".office/packages/office"));
  config();
  expect(() => requireJobs(loadOffice(root))).toThrow("cron.update.when");
});

test("validates files inside their declaring root and rejects schedules systemd can't represent", () => {
  fixtures();
  config(host, packageEntry);
  rmSync(join(root, "packages/demo/digest.sh"));
  symlinkSync(join(root, "cron/office.sh"), join(root, "packages/demo/digest.sh"));
  expect(() => requireJobs(loadOffice(root))).toThrow("package.demo.digest: digest.sh must be an existing regular script");
  expect(() => namedJob(loadOffice(root), "package.demo.digest")).toThrow("package.demo.digest: digest.sh must be an existing regular script");

  write("office.yaml", `name: test\n${host}cron: {digest: {schedule: '0 1 1 * MON', script: cron/office.sh}}\n`);
  expect(() => requireJobs(loadOffice(root))).toThrow("restricts both the day of the month and the weekday");
});

test("catch-up is UTC, stamps qualified IDs on success and keeps a stamp through a script rename", async () => {
  const oldState = process.env.XDG_STATE_HOME;
  const oldTz = process.env.TZ;

  try {
    process.env.XDG_STATE_HOME = join(root, "xdg-state");
    process.env.TZ = "Pacific/Honolulu";
    fixtures();
    config("", packageEntry);
    write("packages/demo/digest.sh", "exit 3");

    let office = loadOffice(root);
    const now = new Date("2026-11-17T06:10:00Z");

    await catchUpJob(office, "office.digest", now);
    await catchUpJob(office, "package.demo.digest", now);
    expect(readFileSync(join(root, "xdg-state/office/cron/test/office.digest.stamp"), "utf8")).toBe("2026-11-17T06:10:00.000Z\n");
    expect(existsSync(join(root, "xdg-state/office/cron/test/package.demo.digest.stamp"))).toBe(false);
    expect(readFileSync(join(root, "office-runs"), "utf8")).toBe(`${root}\n`);

    write("office.yaml", `name: test\n${cron.replace("office.sh", "new.sh")}`);
    write("cron/new.sh", "printf '%s\\n' ran >> renamed-runs");
    office = loadOffice(root);
    await catchUpJob(office, "office.digest", new Date("2026-11-17T06:20:00Z"));
    expect(existsSync(join(root, "renamed-runs"))).toBe(false);
    await catchUpJob(office, "office.digest", new Date("2026-11-18T06:00:00Z"));
    expect(readFileSync(join(root, "renamed-runs"), "utf8")).toBe("ran\n");
  } finally {
    if (oldState === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = oldState;

    if (oldTz === undefined) delete process.env.TZ;
    else process.env.TZ = oldTz;
  }
});

test("retires legacy and removed timers before enabling new units and never modifies unrelated names", () => {
  const path = process.env.PATH;
  const units = process.env[unitDirVariable];
  const log = join(root, "systemctl.log");
  const unitDir = join(root, "units");

  try {
    process.env.PATH = `${root}/bin:${path ?? "/usr/bin:/bin"}`;
    process.env[unitDirVariable] = unitDir;
    write("bin/systemctl", `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`);
    Bun.spawnSync(["chmod", "+x", join(root, "bin/systemctl")]);
    fixtures();
    config(host, packageEntry);
    write("units/office-test-office.timer", "# Generated by `office up` for the test office. Don't edit\n");
    write("units/office-test-office.service", "# Generated by `office up` for the test office. Don't edit\n");
    write("units/office-test-unrelated.timer", "# Generated by `office up` for the test office-other office. Don't edit\n");
    write("units/office-test-opencode.service", "# Generated by office for test: managed OpenCode. Do not edit.\n");

    let office = loadOffice(root);
    let wanted = cronTimers(office, requireJobs(office));
    const first = wanted[0].unit;

    expect(staleTimerUnits(office, wanted).sort()).toEqual(["office-test-office.service", "office-test-office.timer"]);
    installTimers(office, wanted);
    const calls = readFileSync(log, "utf8");

    expect(calls).toContain("--user disable --now office-test-office.timer");
    expect(calls.indexOf("--user stop office-test-office.service")).toBeLessThan(calls.indexOf("--user enable --now"));
    expect(readFileSync(join(unitDir, `${first}.timer`), "utf8")).toContain("OnCalendar=*-*-* 06:00:00 UTC\nPersistent=true");
    expect(readFileSync(join(unitDir, `${first}.service`), "utf8")).toContain('"cron" "run" "office.digest"');
    expect(staleTimerUnits(office, wanted)).toEqual([]);

    config(host);
    office = loadOffice(root);
    wanted = cronTimers(office, requireJobs(office));
    installTimers(office, wanted);
    expect(existsSync(join(unitDir, "office-test-cron-package.demo.host.timer"))).toBe(false);

    removeTimers(office);
    expect(existsSync(join(unitDir, `${first}.timer`))).toBe(false);
    expect(existsSync(join(unitDir, "office-test-unrelated.timer"))).toBe(true);
    expect(existsSync(join(unitDir, "office-test-opencode.service"))).toBe(true);

    write(`units/${first}.timer`, "operator's file\n");
    expect(() => installTimers(office, wanted)).toThrow("not an office-generated cron unit");
    expect(readFileSync(join(unitDir, `${first}.timer`), "utf8")).toBe("operator's file\n");
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;

    if (units === undefined) delete process.env[unitDirVariable];
    else process.env[unitDirVariable] = units;
  }
});
