import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Entries, Registry, RegistryEntry } from "../sdk/index.ts";
import { containerSchedule } from "./container-schedule.ts";
import { loadOffice } from "./office.ts";
import type { SettingValue } from "./schema.ts";

let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "office-container-schedule-")); });

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** An office at `dir` with package report's job `digest` and the office's own `mine`, gathered with the cron package's `settings`. */
function gathered(dir: string, settings: Record<string, SettingValue>) {
  mkdirSync(join(dir, "packages/report"), { recursive: true });
  writeFileSync(join(dir, "office.yaml"), "name: box\nopencode: container\n");
  writeFileSync(join(dir, "mine.sh"), "true\n");
  writeFileSync(join(dir, "packages/report/digest.sh"), "true\n");

  const entries: Entries = <Value extends RegistryEntry>(registry: Registry<Value>) =>
    registry.id === "cron.jobs" ? [{ value: registry.parse({ name: "digest", schedule: "0 7 * * MON", script: "digest.sh" }), owner: "report", folder: join(dir, "packages/report"), root: join(dir, "packages/report") }] : [];

  const packages = [{ entry: { name: "cron", settings, source: undefined }, settings }];

  return { office: loadOffice(dir), gathered: { packages, entries } };
}

const own = { jobs: { mine: { schedule: "15 6 * * *", script: "mine.sh" } } };

test("the revision is the hash of the crontab, the same wherever the office is, and changes with a schedule", () => {
  const here = gathered(join(root, "here"), own);
  const crontab = "15 6 * * * office cron run office.mine\n0 7 * * 1 office cron run package.report.digest";

  expect(containerSchedule(here.office, here.gathered)).toEqual({ jobs: 2, revision: createHash("sha256").update(crontab).digest("hex") });

  const there = gathered(join(root, "mounted/elsewhere"), own);

  expect(containerSchedule(there.office, there.gathered)).toEqual(containerSchedule(here.office, here.gathered));

  const moved = gathered(join(root, "here"), { ...own, overrides: { "package.report.digest": { schedule: "0 8 * * MON" } } });

  expect(containerSchedule(moved.office, moved.gathered).revision).not.toBe(containerSchedule(here.office, here.gathered).revision);

  const none = gathered(join(root, "here"), { overrides: { "package.report.digest": { enabled: false } } });

  expect(containerSchedule(none.office, none.gathered)).toEqual({ jobs: 0, revision: createHash("sha256").update("").digest("hex") });
  expect(() => containerSchedule(here.office, gathered(join(root, "here"), { jobs: { mine: { schedule: "@daily", script: "absent.sh" } } }).gathered)).toThrow("cron office.mine: absent.sh must be an existing regular script");
});
