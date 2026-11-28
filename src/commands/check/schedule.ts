import { containerSchedule } from "../../features/cron/container-schedule.ts";
import { hasSystemd } from "../../features/systemd/systemd.ts";
import { ownedUnits, packageUnits, refreshOwner, refreshTimer, timerStatus } from "../../features/systemd/timers.ts";
import { readApplied } from "../../features/tools/runtime-pins.ts";
import type { Office } from "../../office.ts";
import { compose } from "../compose.ts";
import type { Context, Report } from "./context.ts";

/**
 * The office's own timer and the container's scheduler; the cron package's check reports host
 * timers. In host mode, a refresh timer left from container mode; in container mode, host timers
 * left from host mode, the weekly refresh timer, the image's age, and in a running container a
 * schedule other than the jobs as they are now, or Supercronic not running.
 */
export function scheduling(office: Office, report: Report, running: string[], { claims }: Context): void {
  const stale = office.opencode.mode === "host" ? ownedUnits(office, refreshOwner) : packageUnits(office);

  if (stale.length > 0) report(false, "timers", `obsolete units: ${stale.join(", ")} (office up removes them)`);

  if (office.opencode.mode === "host") return;

  if (hasSystemd()) {
    const wanted = refreshTimer(office);
    const label = `timer ${wanted.unit}`;

    try {
      const [installed] = timerStatus(office, refreshOwner);

      if (installed === undefined || installed.files !== "pair" || !installed.active) report(false, label, "not active (run office up)");
      else if (installed.calendar !== wanted.calendar || !installed.persistent) report(false, label, "installed schedule differs (run office up)");
      else report(true, label, `${wanted.calendar}; next ${installed.next ?? "?"}, last ${installed.last ?? "never"}`);
    } catch (error) {
      // A unit systemd loaded from a file office didn't write is not the office's refresh timer.
      report(false, label, error instanceof Error ? error.message : String(error));
    }
  } else {
    report("warn", "image refresh", "no systemd user manager, so nothing refreshes the opencode image weekly; run office up --refresh yourself");
  }

  imageAge(office, report);

  // The packages didn't load: the gathering's check names them.
  if (!running.includes("opencode") || claims === undefined) return;
  let schedule: ReturnType<typeof containerSchedule>;

  try {
    schedule = containerSchedule(office, claims);
  } catch (error) {
    report(false, "cron", error instanceof Error ? error.message : String(error));

    return;
  }

  let applied = "";

  try {
    applied = compose(office, ["exec", "-T", "opencode", "printenv", "OFFICE_CRON_REVISION"], { capture: true });
  } catch {
    // Earlier containers do not have a schedule revision.
  }

  if (applied !== schedule.revision) {
    report(false, "cron", "the container's schedule is out of date (run office up)");

    return;
  }

  if (schedule.jobs === 0) return;

  const processes = compose(office, ["top", "opencode"], { capture: true });

  report(processes.includes("supercronic"), "cron", processes.includes("supercronic") ? "supercronic runs in the opencode container" : "supercronic isn't running in the opencode container");
}

/** How old the opencode image's Debian packages are: the weekly refresh keeps them under a week, with a day's grace. */
function imageAge(office: Office, report: Report): void {
  const refreshed = readApplied(office)?.refreshed;

  if (refreshed === undefined) {
    report("warn", "Debian packages", "no refresh recorded; office up --refresh installs current ones");

    return;
  }

  const days = Math.floor((Date.now() - Date.parse(refreshed)) / 86_400_000);

  report(days <= 8 ? true : "warn", "Debian packages", `refreshed ${days === 0 ? "today" : `${days} days ago`}${days <= 8 ? "" : "; office up --refresh installs current ones"}`);
}
