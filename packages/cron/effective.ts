// The jobs that apply to an office now, from the packages' declarations and the cron package's
// settings. Every reader goes through `effectiveJobs`: sync and check, up, each command, and the
// office CLI's container revision. Its inputs are plain data, so the CLI passes nothing of its own.
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";

import { type Given, type GivenSettings, type Job, jobProblem, nameProblem } from "./rules.ts";
import { calendar, numericSchedule, type ScheduleFields, scheduleFields, validSchedule } from "./schedule.ts";

/** The office as `effectiveJobs` needs it: the SDK's office has these and more. */
export type JobOffice = { readonly dir: string; readonly name: string; readonly mode: "host" | "managed-host" | "container" };

/** A declared job as `entries(jobs)` returns it: its value, the package that added it, and that package's folder. */
type DeclaredJob = { readonly value: Job; readonly owner: string; readonly folder: string };

/** A job that applies: its id, its owner (a package, or `office`), its schedule after overrides, the systemd calendar for it, and its script's absolute path. */
export type EffectiveJob = { id: string; owner: string; schedule: string; calendar: string; script: string };

/** A job before the office's mode and overrides decide whether it runs. */
type Candidate = { id: string; owner: string; folder: string; schedule: string; script: string; when?: Job["when"]; enabled: boolean };

type Override = { schedule?: string; enabled?: boolean };

function isRecord(value: Given): value is GivenSettings {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The office's own jobs from the settings, each checked as a declared job is. */
function officeJobs(office: JobOffice, settings: GivenSettings, errors: string[]): Candidate[] {
  const own = settings.jobs ?? {};

  if (!isRecord(own)) {
    errors.push("cron settings: jobs must map job names to a schedule and a script");

    return [];
  }

  return Object.entries(own).flatMap(([name, job]) => {
    const id = `office.${name}`;
    const named = nameProblem(name);

    if (named !== undefined) {
      errors.push(`cron ${id}: ${named}`);

      return [];
    }

    if (!isRecord(job) || Object.keys(job).some(key => key !== "schedule" && key !== "script")) {
      errors.push(`cron ${id}: must have a schedule and a script, and nothing else`);

      return [];
    }

    const problem = jobProblem(`cron ${id}`, job.schedule, job.script);

    if (problem !== undefined || typeof job.schedule !== "string" || typeof job.script !== "string") {
      errors.push(problem ?? `cron ${id}: not a job`);

      return [];
    }

    return [{ id, owner: "office", folder: office.dir, schedule: job.schedule, script: job.script, enabled: true }];
  });
}

/** The overrides from the settings, by job id. */
function overrides(settings: GivenSettings, errors: string[]): Map<string, Override> {
  const read = new Map<string, Override>();
  const given = settings.overrides ?? {};

  if (!isRecord(given)) {
    errors.push("cron settings: overrides must map job ids to a schedule, enabled or both");

    return read;
  }

  for (const [id, override] of Object.entries(given)) {
    if (!isRecord(override) || Object.keys(override).some(key => key !== "schedule" && key !== "enabled")) {
      errors.push(`cron override ${id}: can only set schedule and enabled`);
      continue;
    }

    const { schedule, enabled } = override;

    if (enabled !== undefined && typeof enabled !== "boolean") {
      errors.push(`cron override ${id}: enabled must be true or false`);
      continue;
    }

    if (schedule !== undefined && (typeof schedule !== "string" || !validSchedule(schedule))) {
      errors.push(`cron override ${id}: schedule must be five UTC cron fields or a macro such as @daily, not ${JSON.stringify(schedule)}`);
      continue;
    }

    read.set(id, { schedule, enabled });
  }

  return read;
}

/** The file a script names under `folder`: a regular file, reached through no symlink below the folder. */
function scriptFile(folder: string, script: string): string | undefined {
  try {
    const path = join(realpathSync(folder), script);

    if (lstatSync(path).isFile() && realpathSync(path) === path) return path;
  } catch {
    return undefined;
  }
}

/** The unit name, without its suffix, of the host timer `host.timers` writes for the job: the cron package's timer `id`. */
export function timerUnit(office: Pick<JobOffice, "name">, id: string): string {
  return `office-${office.name}-cron-${id}`;
}

function applies(mode: JobOffice["mode"], when: Job["when"]): boolean {
  if (when === undefined || when === mode) return true;

  return when === "host" && mode === "managed-host";
}

function fieldsOf(expression: string): ScheduleFields | undefined {
  try {
    return scheduleFields(expression);
  } catch {
    return undefined;
  }
}

/**
 * The jobs that apply to `office`, in order: the office's own, then each package's as `entries`
 * lists them. Every job is checked, a disabled one or one for another mode too: its schedule, and a
 * script that is a regular file in its folder. An override names a package's job by id; one naming
 * no declared job, or one of the office's own, is an error. In host mode a schedule restricting
 * both day fields is refused, since a timer can't express cron's either-day rule, as is an id too
 * long for a unit name. Throws naming every problem.
 */
export function effectiveJobs(office: JobOffice, entries: readonly DeclaredJob[], settings: GivenSettings): EffectiveJob[] {
  const errors: string[] = [];
  const changes = overrides(settings, errors);
  const candidates = officeJobs(office, settings, errors);
  const ids = new Set(candidates.map(job => job.id));

  for (const { value, owner, folder } of entries) {
    const id = `package.${owner}.${value.name}`;

    if (ids.has(id)) {
      errors.push(`package ${owner}: declares the job ${value.name} twice`);
      continue;
    }

    ids.add(id);
    const override = changes.get(id);

    candidates.push({ id, owner, folder, schedule: override?.schedule ?? value.schedule, script: value.script, when: value.when, enabled: override?.enabled !== false });
  }

  for (const id of changes.keys()) {
    if (id.startsWith("office.")) errors.push(`cron override ${id}: the office's own jobs have no overrides; change the job under jobs`);
    else if (!ids.has(id)) errors.push(`cron override ${id}: no selected package declares this job; see office cron list`);
  }

  const applying: EffectiveJob[] = [];
  const host = office.mode !== "container";

  for (const job of candidates) {
    const script = scriptFile(job.folder, job.script);
    const fields = fieldsOf(job.schedule);

    if (script === undefined) errors.push(`cron ${job.id}: ${job.script} must be an existing regular script inside ${job.owner === "office" ? "the office folder" : `package ${job.owner}'s folder`}, with no symlink`);

    if (fields === undefined) errors.push(`cron ${job.id}: schedule must be five UTC cron fields or a macro such as @daily, not ${JSON.stringify(job.schedule)}`);

    if (script === undefined || fields === undefined || !job.enabled || !applies(office.mode, job.when)) continue;

    if (host && fields.day !== undefined && fields.weekday !== undefined) {
      errors.push(`cron ${job.id}: "${job.schedule}" restricts both the day of the month and the weekday, which a systemd timer can't express`);
    } else if (host && `${timerUnit(office, job.id)}.service`.length > 255) {
      errors.push(`cron ${job.id}: its systemd unit name is too long; shorten the office or package name`);
    } else {
      applying.push({ id: job.id, owner: job.owner, schedule: job.schedule, calendar: calendar(fields), script });
    }
  }

  if (errors.length) throw new Error(errors.join("\n"));

  return applying;
}

/** Supercronic's input: one line per job, its numeric UTC schedule and `office cron run <id>`, with no path in it. */
export function crontab(jobs: readonly Pick<EffectiveJob, "id" | "schedule">[]): string {
  return jobs.map(job => {
    const fields = scheduleFields(job.schedule);

    if (fields === undefined) throw new Error(`cron ${job.id}: not a schedule: ${job.schedule}`);

    return `${numericSchedule(fields)} office cron run ${job.id}`;
  }).join("\n");
}
