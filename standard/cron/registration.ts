import * as v from "valibot";
import type { CronContext } from "../../packages/office/package-context.ts";
import type { Office } from "../../src/office.ts";
import type { InstalledPackage } from "../../src/packages.ts";
import { check, registeredJob, registeredJobName, type PackageManifest, type Parsed } from "../../src/schema.ts";

type Declaration = PackageManifest["cron"][string];

/** Read only this owner's current data. A thrown or invalid hook yields no runnable jobs. */
export function jobDeclarations(office: Office, item: InstalledPackage): Parsed<Map<string, Declaration | false>> {
  const jobs = new Map<string, Declaration | false>(Object.entries(item.manifest.cron));

  if (!item.manifest.registerCron) return { ok: true, value: jobs };

  const errors: string[] = [];

  const cron: CronContext["cron"] = {
    mode: office.opencode.managed ? "managed-host" : office.opencode.mode,
    job(name, definition) {
      const key = check(v.safeParse(registeredJobName, name));

      if (!key.ok) {
        errors.push(`package ${item.entry.name}: cron job name: ${key.errors.join("; ")}`);

        return;
      }

      if (jobs.has(name)) errors.push(`duplicate cron job package.${item.entry.name}.${name}`);
      else if (definition === false) jobs.set(name, false);
      else {
        const read = check(v.safeParse(registeredJob, definition));

        if (read.ok) jobs.set(name, read.value);
        else errors.push(`cron package.${item.entry.name}.${name}: ${read.errors.join("; ")}`);
      }
    },
  };

  try {
    const result = item.manifest.registerCron({ cron, settings: structuredClone(item.settings) });

    if (result !== undefined) {
      // An untyped synchronous function can still return a promise. Discard the whole batch.
      Promise.resolve(result).catch(() => {});
      errors.push(`package ${item.entry.name}: registerCron must register jobs synchronously and return nothing`);
    }
  } catch (error) {
    errors.push(`package ${item.entry.name}: registerCron: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const key of Object.keys(item.entry.cron)) {
    if (!jobs.has(key)) errors.push(`packages.${item.entry.name}.cron.${key}: no such job`);
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: jobs };
}
