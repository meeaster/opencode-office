// Supercronic input is generated, not configuration. Only successful runs are stamped.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Office } from "../office.ts";
import { type CronJob, executeJob } from "./jobs.ts";
import { lastDue, numericSchedule, schedule } from "./schedule.ts";

function stamps(office: Office): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "office/cron", office.name);
}

function stampPath(office: Office, job: CronJob): string {
  return join(stamps(office), `${job.id}.stamp`);
}

export async function runContainerJob(office: Office, job: CronJob, started = new Date()): Promise<number> {
  const code = await executeJob(office, job);

  if (code === 0) {
    mkdirSync(stamps(office), { recursive: true });
    writeFileSync(stampPath(office, job), `${started.toISOString()}\n`);
  }

  return code;
}

export function supercronicInput(jobs: CronJob[]): string {
  return jobs.map((job) => `${numericSchedule(job.fields)} office cron run ${job.id}`).join("\n");
}

export function cronRevision(jobs: CronJob[]): string {
  return createHash("sha256").update(supercronicInput(jobs)).digest("hex");
}

/** Runs each due job once. The caller starts supercronic afterwards. */
export async function catchUp(office: Office, jobs: CronJob[], now = new Date()): Promise<void> {
  for (const job of jobs) {
    const due = lastDue(schedule(job.fields), now);
    const path = stampPath(office, job);
    const success = existsSync(path) ? new Date(readFileSync(path, "utf8").trim()) : undefined;

    if (due === undefined || (success !== undefined && success >= due)) continue;

    console.log(`office cron: catching up ${job.id} (due ${due.toISOString()})`);
    await runContainerJob(office, job, now);
  }
}
