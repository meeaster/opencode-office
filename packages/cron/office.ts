import { type CommandInputs, type Lifecycle, Package, type Problem } from "@office/sdk";
import { timerUnit } from "./effective.ts";
import { crontab, effectiveJobs, type EffectiveJob, jobs } from "./handles.ts";
import { type GivenSettings, jobName, jobNameLength, scriptPath } from "./rules.ts";
import { catchUp, catchUpJob, runJob } from "./runner.ts";
import { scheduleCharacters } from "./schedule.ts";

const schedule = { type: "string", pattern: scheduleCharacters } as const;

const script = { type: "string", pattern: scriptPath.source } as const;

const settings = {
  type: "object",
  additionalProperties: false,
  properties: {
    jobs: {
      description: "The office's own jobs, by name: each a schedule and a script in the office folder. Their ids are office.<name>.",
      type: "object",
      propertyNames: { pattern: jobName.source, maxLength: jobNameLength, not: { enum: ["constructor", "prototype"] } },
      additionalProperties: { type: "object", additionalProperties: false, required: ["schedule", "script"], properties: { schedule, script } },
    },
    overrides: {
      description: "Changes to packages' jobs, by id (package.<package>.<job>, as office cron list prints): a new schedule, or enabled: false.",
      type: "object",
      propertyNames: { pattern: "^[a-z0-9][a-z0-9-]*(\\.[a-z0-9][a-z0-9-]*){1,2}$" },
      additionalProperties: { type: "object", additionalProperties: false, properties: { schedule, enabled: { type: "boolean" } } },
    },
  },
} as const;

/** The jobs that apply now. */
function current({ office, entries, settings }: Lifecycle<GivenSettings>): EffectiveJob[] {
  return effectiveJobs(office, entries(jobs), settings);
}

/** Refuses extra words, and outside the OpenCode container a command only it runs. */
function requireArgs({ office, args }: CommandInputs<object>, words: number, usage: string, { container = false } = {}): void {
  if (args.length !== words) throw new Error(`usage: office ${usage}`);

  if (container && office.mode !== "container") throw new Error(`office ${usage.split(" ").slice(0, 2).join(" ")} runs only in the OpenCode container`);
}

export default Package.define({
  settings,
  commands: {
    "cron list": {
      summary: "List the jobs that apply in this office, by id",
      result(inputs) {
        requireArgs(inputs, 0, "cron list");

        return current(inputs).map(job => job.id).join("\n");
      },
    },
    "cron run": {
      summary: "Run a job now, by its id, as its timer does; exits with its script's status",
      usage: "<job-id>",
      async run(inputs) {
        requireArgs(inputs, 1, "cron run <job-id>");
        const [id] = inputs.args;
        const job = current(inputs).find(each => each.id === id);

        if (job === undefined) throw new Error(`cron ${id}: not enabled for this office; see office cron list`);

        process.exitCode = await runJob(inputs.office, job);
      },
    },
    "cron supercronic": {
      summary: "In the OpenCode container: print the crontab of the jobs that apply, for Supercronic",
      result(inputs) {
        requireArgs(inputs, 0, "cron supercronic", { container: true });

        return crontab(current(inputs));
      },
    },
    "cron catch-up": {
      summary: "In the OpenCode container: run each job that was due while it was stopped",
      async run(inputs) {
        requireArgs(inputs, 0, "cron catch-up", { container: true });
        process.exitCode = await catchUp(inputs.office, current(inputs).map(job => job.id));
      },
    },
    "cron catch-up-job": {
      summary: "In the OpenCode container: run one job if it was due while it was stopped; cron catch-up starts it",
      usage: "<office> <job-id>",
      async run(inputs) {
        requireArgs(inputs, 2, "cron catch-up-job <office> <job-id>");
        const { office, args: [name, id] } = inputs;

        // Started by catch-up from the office folder, for this office in its container; otherwise nothing.
        if (office.dir !== process.cwd() || office.name !== name || office.mode !== "container") return;

        await catchUpJob(office, current(inputs).find(job => job.id === id));
      },
    },
  },
  setup(ctx) {
    ctx.registry(jobs);
  },
  sync(inputs) {
    current(inputs);
  },
  check(inputs) {
    const { office, host } = inputs;

    // In the container the office CLI checks the running scheduler.
    if (office.mode === "container") return [];
    const wanted = new Map(current(inputs).map(job => [job.id, job]));
    const installed = new Map(host.timers.status().map(timer => [timer.id, timer]));
    const problems: Problem[] = [];

    for (const [id, job] of wanted) {
      const timer = installed.get(id);
      const unit = `${timerUnit(office, id)}.timer`;

      if (timer === undefined || timer.files === "service") problems.push({ level: "failed", message: `${unit} is missing (run office up)` });
      else if (timer.files === "timer") problems.push({ level: "failed", message: `${timerUnit(office, id)}.service is missing (run office up)` });
      else if (!timer.active) problems.push({ level: "failed", message: `${unit} is inactive (run office up)` });
      else if (timer.calendar !== job.calendar || !timer.persistent) problems.push({ level: "failed", message: `${unit}: its installed schedule differs from ${job.calendar} (run office up)` });
    }

    // Each unit file of a job no longer applying, as it is installed: a pair, or a lone timer or service.
    for (const [id, timer] of installed) {
      if (wanted.has(id)) continue;

      for (const suffix of timer.files === "pair" ? ["timer", "service"] : [timer.files]) {
        problems.push({ level: "failed", message: `${timerUnit(office, id)}.${suffix} is no longer wanted: no job ${id} applies (office up removes it)` });
      }
    }

    return problems;
  },
  up(inputs) {
    const { office, host } = inputs;

    // The OpenCode container runs the jobs itself; office up removed the host's timers before starting it.
    if (office.mode === "container") return [];

    return host.timers.set(current(inputs).map(job => ({ id: job.id, calendar: job.calendar, run: ["cron", "run", job.id] })));
  },
  down({ host }) {
    return host.timers.clear();
  },
});
