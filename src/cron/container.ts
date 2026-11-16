// The office's cron jobs: cron/crontab lists them as "<schedule> <command>", and the commands
// know nothing of the runner. This module adds what supercronic lacks: each run that succeeds
// stamps the time in the container's home volume, and on container start a job whose last
// scheduled time has passed since its stamp (or that never succeeded) runs once. That is
// systemd's Persistent=true, which host mode uses instead: cron/host.ts turns the same entries
// into timers whose services call `office cron run`.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const stampDir = join(homedir(), ".local/state/office/cron");

const macros = new Map(Object.entries({
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
  "@monthly": "0 0 1 * *",
  "@weekly": "0 0 * * 0",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@hourly": "0 * * * *",
}));

const names = {
  month: ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"],
  weekday: ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"],
};

/** One cron field: its range, and the names it accepts with the number of the first. */
type Field = { min: number; max: number; names?: string[]; offset?: number };

/** The values each field allows; undefined allows every value. Sunday is 0. */
export type ScheduleFields = { minute?: Set<number>; hour?: Set<number>; day?: Set<number>; month?: Set<number>; weekday?: Set<number> };

const fields: Field[] = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: names.month, offset: 1 },
  { min: 0, max: 7, names: names.weekday, offset: 0 },
];

function value(token: string, field: Field): number {
  const index = field.names?.indexOf(token.toUpperCase()) ?? -1;

  return index === -1 ? Number(token) : index + (field.offset ?? 0);
}

/** The set of values one cron field allows, or undefined when it allows every value. */
function parseField(text: string, field: Field): Set<number> | undefined {
  if (text === "*" || text === "?") return undefined;

  const allowed = new Set<number>();

  for (const part of text.split(",")) {
    const [range, step = "1"] = part.split("/");
    const [from, to] = range === "*" ? [field.min, field.max] : range.split("-").map((token) => value(token, field));
    const last = to ?? (part.includes("/") ? field.max : from);

    if (![from, last, Number(step)].every(Number.isInteger)) throw new Error(`can't read "${text}"`);

    for (let current = from; current <= last; current += Number(step)) allowed.add(current);
  }

  return allowed;
}

/**
 * The values each field of a five-field expression or a macro such as @daily allows (undefined:
 * every value), with Sunday always 0; undefined for other forms such as @reboot.
 */
export function scheduleFields(expression: string): ScheduleFields | undefined {
  const parts = (macros.get(expression) ?? expression).split(/\s+/);

  if (parts.length !== 5) return undefined;

  const [minute, hour, day, month, weekday] = parts.map((part, index) => parseField(part, fields[index]));

  if (weekday?.has(7)) {
    weekday.delete(7);
    weekday.add(0);
  }

  return { minute, hour, day, month, weekday };
}

/** A matcher for a five-field expression or a macro such as @daily; undefined for other forms. */
export function schedule(expression: string): ((date: Date) => boolean) | undefined {
  const parsed = scheduleFields(expression);

  if (parsed === undefined) return undefined;

  const { minute, hour, day, month, weekday } = parsed;

  // Cron's rule: when both day fields are restricted, either one matching is enough.

  return (date: Date) => {
    const dayMatches = day === undefined || day.has(date.getDate());
    const weekdayMatches = weekday === undefined || weekday.has(date.getDay());

    return (
      (minute === undefined || minute.has(date.getMinutes())) &&
      (hour === undefined || hour.has(date.getHours())) &&
      (month === undefined || month.has(date.getMonth() + 1)) &&
      (day !== undefined && weekday !== undefined ? dayMatches || weekdayMatches : dayMatches && weekdayMatches)
    );
  };
}

/** The latest minute at or before `now` that the schedule matches, within the last year. */
export function lastDue(matches: (date: Date) => boolean, now: Date): Date | undefined {
  const minute = new Date(now);

  minute.setSeconds(0, 0);

  for (let step = 0; step < 366 * 24 * 60; step++) {
    if (matches(minute)) return minute;

    minute.setMinutes(minute.getMinutes() - 1);
  }

  return undefined;
}

/** The jobs in a crontab: each line's schedule and command. Comments and blank lines are skipped. */
export function jobs(crontab: string): { expression: string; command: string }[] {
  return crontab
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const words = line.split(/\s+/);
      const length = words[0].startsWith("@") ? 1 : 5;

      return { expression: words.slice(0, length).join(" "), command: words.slice(length).join(" ") };
    });
}

function stampPath(command: string): string {
  return join(stampDir, `${command.replace(/[^A-Za-z0-9._-]+/g, "_")}.stamp`);
}

function lastSuccess(command: string): Date | undefined {
  const path = stampPath(command);

  return existsSync(path) ? new Date(readFileSync(path, "utf8").trim()) : undefined;
}

/** Runs a job's command from the office root; stamps the time when it exits 0. Returns its exit code. */
export function runJob(officeDir: string, command: string): number {
  const started = new Date();
  const result = spawnSync("sh", ["-c", command], { cwd: officeDir, stdio: "inherit" });
  const code = result.status ?? 1;

  if (code === 0) {
    mkdirSync(stampDir, { recursive: true });
    writeFileSync(stampPath(command), `${started.toISOString()}\n`);
  }

  console.log(`office cron: ${command} exited ${code}`);

  return code;
}

function quote(text: string): string {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

/** The crontab supercronic runs: the office's, with each command wrapped so a success is stamped. */
export function wrappedCrontab(crontab: string): string {
  return jobs(crontab)
    .map((job) => `${job.expression} office cron run ${quote(job.command)}`)
    .join("\n");
}

/** Runs, one after another, every job whose last scheduled time has passed since its last success. */
export function catchUp(officeDir: string, crontab: string, now = new Date()): void {
  for (const job of jobs(crontab)) {
    const matches = schedule(job.expression);

    if (matches === undefined) {
      console.log(`office cron: no catch-up for "${job.expression} ${job.command}": only five-field schedules and @macros are read`);
      continue;
    }

    const due = lastDue(matches, now);
    const success = lastSuccess(job.command);

    if (due === undefined || (success !== undefined && success >= due)) {
      console.log(`office cron: ${job.command} is current (last success ${success?.toISOString() ?? "never"})`);
      continue;
    }

    console.log(`office cron: catching up ${job.command} (due ${due.toISOString()}, last success ${success?.toISOString() ?? "never"})`);
    runJob(officeDir, job.command);
  }
}
