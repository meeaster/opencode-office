import { type Office, OfficeError } from "../../src/office.ts";
import { catchUp, catchUpJob, runContainerJob, supercronicInput } from "./container.ts";
import { namedJob, requireJobs } from "./discovery.ts";
import { executeJob } from "./jobs.ts";

export async function cronCommand(office: Office, args: string[]): Promise<void> {
  const [action, id] = args;

  if (action === "run" && id !== undefined && args.length === 2) {
    const job = namedJob(office, id);

    process.exitCode = office.opencode.mode === "container" ? await runContainerJob(office, job) : await executeJob(office, job);
  } else if (action === "list" && args.length === 1) {
    for (const job of requireJobs(office)) console.log(job.id);
  } else if (office.opencode.mode === "container" && args.length === 1 && action === "supercronic") {
    const jobs = requireJobs(office);

    if (jobs.length > 0) console.log(supercronicInput(jobs));
  } else if (office.opencode.mode === "container" && args.length === 1 && action === "catch-up") {
    process.exitCode = await catchUp(office);
  } else if (action === "catch-up-job" && args.length === 3) {
    if (office.dir === process.cwd() && office.name === args[1] && office.opencode.mode === "container") await catchUpJob(office, args[2]);
  } else {
    throw new OfficeError("usage: office cron list | run <job-id>");
  }
}
