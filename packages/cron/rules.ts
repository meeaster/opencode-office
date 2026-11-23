// What makes a job well formed, shared by the registry's parser and the office's own jobs in the
// cron package's settings.
import { validSchedule } from "./schedule.ts";

/** A settings value as the cron package's commands and functions get it, and as the office CLI passes it: plain data. */
export type Given = null | undefined | boolean | number | string | readonly Given[] | { readonly [key: string]: Given };

/** The cron package's settings, unchecked: `jobs` and `overrides`, and anything else, which is refused. */
export type GivenSettings = { readonly [key: string]: Given };

/** Where a job runs: `host` covers a managed host too. Without `when`, in every mode. */
export type When = "host" | "managed-host" | "container";

/** A job as a package declares it: `script` is a `.sh` file in the package, run from the office folder. */
export type Job = { name: string; schedule: string; script: string; when?: When };

/** A job name: it becomes part of a systemd unit's name, so it is short and plain. */
export const jobName = /^[a-z0-9][a-z0-9-]*$/;

/** The longest job name, leaving room for the office's and the package's names in a unit's. */
export const jobNameLength = 48;

/** A relative `.sh` path with no `..`, `.` or empty part, and nothing a shell would read. */
export const scriptPath = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*\.sh$/;

const reservedNames = ["constructor", "prototype", "__proto__"];

const whens: readonly string[] = ["host", "managed-host", "container"] satisfies When[];

/** The problem with a job's name, schedule and script as written, or undefined; `what` names it. */
export function jobProblem(what: string, schedule: Given, script: Given): string | undefined {
  if (typeof schedule !== "string" || !validSchedule(schedule)) return `${what}: schedule must be five UTC cron fields or a macro such as @daily, not ${JSON.stringify(schedule)}`;

  if (typeof script !== "string" || !scriptPath.test(script)) return `${what}: script must be a relative .sh path inside its folder, such as scripts/digest.sh, not ${JSON.stringify(script)}`;
}

/** The problem with a job name, or undefined. */
export function nameProblem(name: Given): string | undefined {
  if (typeof name !== "string" || !jobName.test(name) || name.length > jobNameLength || reservedNames.includes(name)) {
    return `job name ${JSON.stringify(name)} must be at most ${jobNameLength} lowercase letters, digits and dashes, starting with a letter or digit`;
  }
}

/** Whether `value` is one of the modes a job can be for. */
export function isWhen(value: Given): value is When {
  return typeof value === "string" && whens.includes(value);
}
