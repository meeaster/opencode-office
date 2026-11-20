import { spawn } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";

import type { InstalledPackages } from "../../src/layout.ts";
import { type Office, OfficeError } from "../../src/office.ts";
import type { PackageManifest, Parsed } from "../../src/schema.ts";
import { officeCommand } from "../../src/tool.ts";
import { type ScheduleFields, scheduleFields } from "./schedule.ts";

export type CronJob = { id: string; fields: ScheduleFields; script: string };

type Predicate = PackageManifest["cron"][string]["when"];

function applies(office: Office, when: Predicate): boolean {
  if (when === undefined) return true;

  if (when === "managed-host") return office.opencode.mode === "host" && office.opencode.managed !== undefined;

  return office.opencode.mode === when;
}

function scriptPath(dir: string, script: string): string | undefined {
  try {
    const candidate = join(realpathSync(dir), script);

    if (lstatSync(candidate).isFile() && realpathSync(candidate) === candidate) return candidate;
  } catch {
    return;
  }
}

/** Both runners and manual execution use the same declarations, overrides and applicability. */
export function collectJobs(office: Office, packages: Pick<InstalledPackages, "installed" | "problems">, only?: string): Parsed<CronJob[]> {
  const jobs: CronJob[] = [];
  const errors = packages.problems.map((problem) => `package ${problem.packages.join(", ")}: ${problem.message}`);

  function collect(id: string, dir: string, script: string, expression: string, enabled: boolean): void {
    if (only !== undefined && id !== only) return;
    const path = scriptPath(dir, script);

    if (path === undefined) errors.push(`cron ${id}: ${script} must be an existing regular script inside its declaring folder (no symlinks)`);

    if (!enabled) return;

    const fields = scheduleFields(expression);

    if (fields === undefined) throw new OfficeError(`cron ${id}: invalid schedule "${expression}"`);

    if (office.opencode.mode === "host" && fields.day !== undefined && fields.weekday !== undefined) {
      errors.push(`cron ${id}: "${expression}" restricts both the day of the month and the weekday, which a systemd timer can't express`);
    } else if (path !== undefined) {
      jobs.push({ id, fields, script: path });
    }
  }

  for (const [name, job] of Object.entries(office.cron)) collect(`office.${name}`, office.dir, job.script, job.schedule, true);

  for (const item of packages.installed) {
    for (const [name, job] of Object.entries(item.manifest.cron)) {
      const override = item.entry.cron[name];

      collect(`package.${item.entry.name}.${name}`, item.dir, job.script, override?.schedule ?? job.schedule, override?.enabled !== false && applies(office, job.when));
    }
  }

  return errors.length === 0 ? { ok: true, value: jobs } : { ok: false, errors };
}

/** Run the script as a file, never as an interpolated command. */
export async function executeJob(office: Office, job: CronJob): Promise<number> {
  const code = await new Promise<number>((done, fail) => {
    const child = spawn("/bin/sh", [job.script], {
      cwd: office.dir,
      stdio: "inherit",
      env: { ...process.env, OFFICE_CRON_COMMAND: officeCommand() },
    });

    child.on("error", fail);
    child.on("exit", (status) => done(status ?? 1));
  });

  console.log(`office cron: ${job.id} exited ${code}`);

  return code;
}
