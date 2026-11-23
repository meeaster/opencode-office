// What other packages import: the jobs registry and `cron.add`, which a package's `setup` calls to
// declare a job; and, for the office CLI's OpenCode container, `effectiveJobs` and `crontab`.
import { Registry, type RegistryEntry, type SetupContext } from "@office/sdk";
import { isWhen, type Job, jobProblem, nameProblem } from "./rules.ts";

export { crontab, effectiveJobs, type EffectiveJob, type JobOffice } from "./effective.ts";

export type { GivenSettings, Job, When } from "./rules.ts";

const fields = new Set(["name", "schedule", "script", "when"]);

/** Checks a declared job: its shape, name, schedule and script path. The script's file is checked at sync. */
function parse(input: RegistryEntry): Job {
  const { name, schedule, script, when } = input;
  const named = nameProblem(name);

  if (named !== undefined || typeof name !== "string") throw new Error(`cron: ${named}`);
  const unknown = Object.keys(input).filter(key => !fields.has(key));

  if (unknown.length) throw new Error(`cron job ${name}: unknown key ${unknown.join(", ")}; a job has name, schedule, script and when`);
  const problem = jobProblem(`cron job ${name}`, schedule, script);

  if (problem !== undefined || typeof schedule !== "string" || typeof script !== "string") throw new Error(problem);

  if (when === undefined) return { name, schedule, script };

  if (!isWhen(when)) throw new Error(`cron job ${name}: when must be host, managed-host or container, not ${JSON.stringify(when)}`);

  return { name, schedule, script, when };
}

/** The jobs packages declare; a name is unique within each package. */
export const jobs = Registry.define<Job>({ id: "cron.jobs", key: job => job.name, keyScope: "package", parse });

/** Declares jobs from a package's `setup`. */
export const cron = {
  /** Declares one job of the calling package; its id is `package.<package>.<name>`. */
  add(ctx: Pick<SetupContext, "add">, job: Job): void {
    ctx.add(jobs, job);
  },
};
