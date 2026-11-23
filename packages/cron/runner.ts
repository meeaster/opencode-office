// Running a job, and catching up in the OpenCode container. A job's script runs as a file with
// /bin/sh from the office folder, never as an interpolated command. In the container each success
// is stamped under $XDG_STATE_HOME/office/cron/<office>/<id>.stamp, and at start catch-up runs each
// job whose stamp isn't at or after its latest due minute, each in a fresh process, so a job that
// changes the packages is seen by the next one. A failed script leaves no stamp.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { EffectiveJob, JobOffice } from "./effective.ts";
import { lastDue, schedule, scheduleFields } from "./schedule.ts";

/** The office as running a job needs it: also the command that runs office, for scripts and catch-up's children. */
export type RunOffice = JobOffice & { readonly launcher: string };

function stamps(office: Pick<JobOffice, "name">): string {
  return join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "office/cron", office.name);
}

function stampFile(office: Pick<JobOffice, "name">, id: string): string {
  return join(stamps(office), `${id}.stamp`);
}

/** Runs the job's script; in the container a success is stamped with `started`. Returns the script's exit status. */
export async function runJob(office: RunOffice, job: Pick<EffectiveJob, "id" | "script">, started = new Date()): Promise<number> {
  const code = await new Promise<number>((done, fail) => {
    const child = spawn("/bin/sh", [job.script], {
      cwd: office.dir,
      stdio: "inherit",
      env: { ...process.env, OFFICE_CRON_COMMAND: office.launcher },
    });

    child.on("error", fail);
    child.on("exit", status => done(status ?? 1));
  });

  console.log(`office cron: ${job.id} exited ${code}`);

  if (code === 0 && office.mode === "container") {
    mkdirSync(stamps(office), { recursive: true });
    writeFileSync(stampFile(office, job.id), `${started.toISOString()}\n`);
  }

  return code;
}

/** The minute the job was last due at `now`, when that is later than its last stamped success; else undefined. */
export function missedRun(office: Pick<JobOffice, "name">, job: Pick<EffectiveJob, "id" | "schedule">, now: Date): Date | undefined {
  const fields = scheduleFields(job.schedule);
  const due = fields === undefined ? undefined : lastDue(schedule(fields), now);
  const path = stampFile(office, job.id);
  const success = existsSync(path) ? new Date(readFileSync(path, "utf8").trim()) : undefined;

  if (due === undefined) return undefined;

  // Only a success at or after the due minute skips it: a stamp that doesn't read as a time leaves the job due.
  return success !== undefined && success >= due ? undefined : due;
}

/**
 * Starts `office cron catch-up-job <office> <id>` for each id in turn, from the office folder. The
 * ids are taken once; each child reads the packages as they are then. A child that fails stops the
 * traversal with its status; a job's failed script doesn't, since the child still exits 0.
 */
export async function catchUp(office: RunOffice, ids: readonly string[]): Promise<number> {
  for (const id of ids) {
    const child = Bun.spawn([office.launcher, "cron", "catch-up-job", office.name, id], {
      cwd: office.dir, stdin: "inherit", stdout: "inherit", stderr: "inherit",
    });

    const code = await child.exited;

    if (code !== 0) return code;
  }

  return 0;
}

/** Runs `job` when it missed a run at `now`; a job no longer enabled or applicable is `undefined` and skipped. */
export async function catchUpJob(office: RunOffice, job: EffectiveJob | undefined, now = new Date()): Promise<void> {
  const due = job === undefined ? undefined : missedRun(office, job, now);

  if (job === undefined || due === undefined) return;

  console.log(`office cron: catching up ${job.id} (due ${due.toISOString()})`);
  await runJob(office, job, now);
}
