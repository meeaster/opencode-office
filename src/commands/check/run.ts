import { machineReport } from "../../features/machine/machine.ts";
import { matchesServerUnit, requireServerConsent } from "../../features/opencode/server-units.ts";
import { planServer, serverReport } from "../../features/opencode/host-server.ts";
import { unitStatus } from "../../features/systemd/units.ts";
import { type Gathered, gatherPackages } from "../../gather.ts";
import type { Office } from "../../office.ts";
import type { Stage } from "../../report/index.ts";
import { context, type Report } from "./context.ts";
import { firewallChecks, officeToolChecks, shellCheck, toolsNotes } from "./host.ts";
import { drift, packageChecks, panelChecks, withdrawnClones } from "./packages.ts";
import { outsideSection, versionChecks } from "./repository.ts";
import { runtime } from "./runtime.ts";
import { spawnChecks } from "./services.ts";

/**
 * Without a terminal stage, keep each original plain-text line for scripts and setup. Gathers the
 * packages once, unless the caller (the reader that finishes setup or refresh) passes its gathering.
 */
export async function check(office: Office, stage?: Stage, verbose = false, gathered?: Gathered): Promise<boolean> {
  let passed = 0;
  let warnings = 0;
  let failed = 0;

  const report: Report = (ok, name, detail) => {
    const line = `${ok === "warn" ? "WARN" : ok ? "ok  " : "FAIL"} ${name}: ${detail}`;

    if (ok === "warn") warnings++;
    else if (ok) passed++;
    else failed++;

    if (!stage) console.log(line);
    else if (ok === "warn") stage.warn(line);
    else if (!ok) stage.error(line);
    else if (verbose) stage.note(line);
  };

  stage?.detail("office folders and packages");
  const run = context(office, gathered ?? await gatherPackages(office, { machine: true }));
  const problems = await drift(office, run);

  report(problems.length === 0, "office.yaml and folders", problems.length === 0 ? "in sync" : `${problems.length} problems`);

  for (const problem of problems) {
    if (stage) stage.error(problem);
    else console.log(`     - ${problem}`);
  }

  await packageChecks(office, report, run);
  withdrawnClones(office, report);
  spawnChecks(office, report);

  stage?.detail("host tools and machine settings");
  officeToolChecks(office, report);

  for (const note of toolsNotes(office)) report("warn", "tools", note);

  firewallChecks(office, report);

  for (const line of machineReport(office, run.claims)) report(line.ok, line.name, line.detail);

  if (office.opencode.managed !== undefined) {
    try {
      requireServerConsent(office);

      const plan = planServer(office);
      const status = await serverReport(office, plan, matchesServerUnit(office, plan));

      report(status.ok, "managed OpenCode", status.detail);
    } catch (error) {
      report(false, "managed OpenCode", error instanceof Error ? error.message : String(error));
    }
  }

  // Packages' native units run on the host whether or not any container does.
  if (run.gathered.complete) await unitStatus(office, run.gathered, report);

  if (office.opencode.mode === "host") shellCheck(report);

  panelChecks(office, report, run);

  versionChecks(office, report);
  const root = await runtime(office, report, run, stage);

  stage?.detail("outside skills and plugins");
  outsideSection(office, report, root, line => {
    if (!stage) console.log(line);
    else if (verbose) stage.note(line);
  }, run);

  const summary = `${passed} passed, ${warnings} warnings, ${failed} failed`;

  if (failed) stage?.fail(summary);
  else stage?.done(summary);

  return failed === 0;
}
