import { installedPackages, type InstalledPackages } from "../../src/layout.ts";
import { type Office, OfficeError } from "../../src/office.ts";
import { readPackage, requireLoadable, resolvePackages } from "../../src/packages.ts";
import { collectJobs, type CronJob } from "./jobs.ts";

/** An installed timer reads only its job's owner, without loading the other packages; the whole selection is checked first. */
export function enabledJob(office: Office, id: string): CronJob | undefined {
  const [kind, owner] = id.split(".");
  const installed: InstalledPackages["installed"] = [];

  if (kind === "package" && owner) {
    const resolved = resolvePackages(office, owner);
    const [item] = resolved.packages;

    if (resolved.problems.length) throw new OfficeError(resolved.problems.map(problem => problem.message).join("\n"));

    if (item) {
      requireLoadable(office);
      const read = readPackage(office, item);

      if (!read.ok) throw new OfficeError(read.errors.join("\n"));

      installed.push(read.value);
    }
  }

  const jobs = collectJobs(office, { installed, problems: [] }, id);

  if (!jobs.ok) throw new OfficeError(jobs.errors.join("\n"));

  return jobs.value[0];
}

export function namedJob(office: Office, id: string): CronJob {
  const job = enabledJob(office, id);

  if (!job) throw new OfficeError(`cron ${id}: not enabled for this office; see office cron list`);

  return job;
}

/** `inventory` is the caller's packages, read here when it has none. */
export function requireJobs(office: Office, inventory: InstalledPackages = installedPackages(office)): CronJob[] {
  const result = collectJobs(office, inventory);

  if (!result.ok) throw new OfficeError(result.errors.join("\n"));

  return result.value;
}
