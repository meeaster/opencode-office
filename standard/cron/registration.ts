import * as v from "valibot";
import type { PackageContext } from "../../packages/office/package-context.ts";
import type { Office } from "../../src/office.ts";
import type { InstalledPackage } from "../../src/packages.ts";
import { check, registeredJob, registeredJobName, type PackageManifest, type Parsed } from "../../src/schema.ts";

type Declaration = PackageManifest["cron"][string];

/** The reference/command pass does not observe a scheduler mode or collect jobs. */
export function inactiveCron(manifest: PackageManifest): PackageContext["cron"] {
  return {
    mode: undefined,
    job(name) {
      if (!manifest.cron_setup) throw new Error(`${manifest.name}: set cron_setup: true to register cron job ${name}`);
    },
  };
}

/** Read only this owner's current data. A thrown or invalid setup yields no runnable jobs. */
export function jobDeclarations(office: Office, item: InstalledPackage): Parsed<Map<string, Declaration | false>> {
  const jobs = new Map<string, Declaration | false>(Object.entries(item.manifest.cron));

  if (!item.manifest.cron_setup) return { ok: true, value: jobs };

  const errors: string[] = [];

  const cron: PackageContext["cron"] = {
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
    const result = item.manifest.setup?.({ cron, settings: structuredClone(item.settings), command() {}, add() {} });

    if (result !== undefined) {
      // The batch is discarded immediately, including registrations made before the first await.
      Promise.resolve(result).catch(() => {});
      errors.push(`package ${item.entry.name}: cron setup must register jobs synchronously`);
    }
  } catch (error) {
    errors.push(`package ${item.entry.name}: cron setup: ${error instanceof Error ? error.message : String(error)}`);
  }

  for (const key of Object.keys(item.entry.cron)) {
    if (!jobs.has(key)) errors.push(`packages.${item.entry.name}.cron.${key}: no such job`);
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: jobs };
}
