import { listSpawned, planSweep, sweepIsEmpty } from "../../features/compose/package-spawns.ts";
import { appliedServices, appliedSpawns, parseCompose } from "../../features/compose/services.ts";
import type { Office } from "../../office.ts";
import { compose } from "../compose.ts";
import type { Report } from "./context.ts";

/** The office's services that are running, whichever mode started them. */
export function servicesRunning(office: Office): string[] {
  return compose(office, ["ps", "--status", "running", "--format", "{{.Service}}"], { capture: true, profiles: "container" }).split("\n").filter(Boolean);
}

/**
 * One warning per package whose services are stopped while containers or networks carrying its
 * spawns label remain, which office down removes. Its volumes are expected to stay.
 */
export function spawnChecks(office: Office, report: Report): void {
  const labels = appliedSpawns(office);

  if (labels.size === 0) return;

  let running: string[];

  try {
    running = servicesRunning(office);
  } catch {
    running = [];
  }

  const applied = appliedServices(office);

  for (const [name, label] of labels) {
    const read = parseCompose(applied.get(name) ?? "");

    if (read.ok && Object.keys(read.value.services).some((service) => running.includes(service))) continue;

    const { found, errors } = listSpawned([label]);
    const sweep = planSweep([label], found);
    const left = [...(sweep.containers.length > 0 ? [`containers ${sweep.containers.join(", ")}`] : []), ...(sweep.networks.length > 0 ? [`networks ${sweep.networks.join(", ")}`] : [])];

    if (errors.length > 0) report("warn", `package ${name}: spawned resources`, errors.join("; "));
    else if (!sweepIsEmpty(sweep)) report("warn", `package ${name}: spawned resources`, `its services are stopped, but ${left.join(" and ")} labelled ${label} remain; office down removes them`);
  }
}
