import { type Office, OfficeError } from "../../src/office.ts";
import { catchUp, runContainerJob, supercronicInput } from "./container.ts";
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
    await catchUp(office, requireJobs(office));
  } else {
    throw new OfficeError("usage: office cron list | run <job-id>");
  }
}
