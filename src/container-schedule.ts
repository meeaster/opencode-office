// The OpenCode container's schedule: the one place the office CLI names a package. The container
// is the CLI's until OpenCode leaves the core, and its entrypoint runs the cron package's jobs with
// Supercronic, so `office up` passes the container a revision of that schedule (a changed one
// recreates the container) and `office check` compares it with the running container's. The cron
// package's two plain functions compute it from the gathering's entries and the package's settings.
import { createHash } from "node:crypto";

import { crontab, effectiveJobs, jobs } from "@office/cron";
import type { Entries } from "../sdk/index.ts";
import type { GatheredPackage } from "./gather.ts";
import { officeInfo } from "./lifecycle-inputs.ts";
import type { Office } from "./office.ts";

/** The cron package's name, as office.yaml selects it. */
const scheduler = "cron";

/**
 * The jobs the container runs and the hash of their crontab, whose text holds ids and schedules
 * and no path, so the host and the container compute the same revision wherever the office is
 * mounted. Throws naming a job that is wrong.
 */
export function containerSchedule(office: Office, gathered: { packages: readonly Pick<GatheredPackage, "entry" | "settings">[]; entries: Entries }) {
  const settings = gathered.packages.find(item => item.entry.name === scheduler)?.settings ?? {};
  const applying = effectiveJobs(officeInfo(office), gathered.entries(jobs), settings);

  return { jobs: applying.length, revision: createHash("sha256").update(crontab(applying)).digest("hex") };
}
