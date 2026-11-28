import { join } from "node:path";

import { hostServiceStatus } from "../../features/systemd/package-host-services.ts";
import { executorImage, toolsFor } from "../../features/tools/runtime-pins.ts";
import { ports } from "../../lib/ports.ts";
import { executorEnvFile, type Office, readEnvFile } from "../../office.ts";
import type { Stage } from "../../report/index.ts";
import { version } from "../../tool.ts";
import { isTested, tested } from "../../versions.ts";
import { compose, officeImage, runningPins } from "../compose.ts";
import { keyOrganization } from "../executor.ts";
import type { Context, Report, RootAnswer } from "./context.ts";
import { accessChecks, gitChecks } from "./repository.ts";
import { scheduling } from "./schedule.ts";
import { getJson, rootSession, settle } from "./server.ts";
import { servicesRunning } from "./services.ts";

/** The runtime checks; returns the root session's skills and plugins when the server listed them. */
export async function runtime(office: Office, report: Report, run: Context, stage?: Stage): Promise<RootAnswer | undefined> {
  stage?.detail("containers and Executor");
  const running = servicesRunning(office);
  // Only a shared gh login has hosts to check, the ones packages' declared repositories are on included.
  const declared = office.git?.credentials === "gh" ? await accessChecks(office, report) : [];

  if (!running.includes("opencode") && !running.includes("executor")) {
    report(true, "containers", `not running (start them with office up)`);
    gitChecks(office, report, false, run.references, declared);

    return undefined;
  }

  report(office.opencode.mode === "container" || !running.includes("opencode"), "containers", `running: ${running.join(", ")}${office.opencode.mode === "host" ? ` (OpenCode on the host at ${office.opencode.url})` : ""}`);
  gitChecks(office, report, office.opencode.mode === "container" && running.includes("opencode"), run.references, declared);

  if (office.opencode.mode === "container" && running.includes("opencode")) officeVersions(office, report);

  runningImages(office, report);

  const port = ports();

  const health = await settle(
    () => fetch(`http://127.0.0.1:${port.executor}/health`, { signal: AbortSignal.timeout(5_000) }).then((response) => response.status),
    (status) => status === 200,
  ).catch(String);

  report(health === 200, "Executor", health === 200 ? "ready" : `not ready (${health})`);

  if (health === 200) await executorKey(office, report);

  const password = readEnvFile(join(office.state, "secrets.env")).OPENCODE_PASSWORD;
  const auth = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
  const opencode = office.opencode.url ?? `http://127.0.0.1:${port.opencode}`;
  const hasToken = readEnvFile(executorEnvFile(office)).EXECUTOR_TOKEN !== undefined;
  const root = await rootSession(office, report, run, { auth, opencode, hasToken }, stage);

  await opencodeVersion(office, report, auth, opencode);

  stage?.detail("services and timers");
  hostServiceStatus(office, report, run.gathered.inventory);
  scheduling(office, report, running, run);

  return root;
}

/** Whether the running containers use the images of the applied versions. */
function runningImages(office: Office, report: Report): void {
  const pins = runningPins(office);

  const images = new Map(
    compose(office, ["ps", "--status", "running", "--format", "{{.Service}}\t{{.Image}}"], { capture: true, profiles: "container" })
      .split("\n")
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf("\t")), line.slice(line.indexOf("\t") + 1)]),
  );

  const expected = new Map([["executor", executorImage(pins.executor)], ...(office.opencode.mode === "container" ? [["opencode", officeImage(office, pins)] as const] : [])]);
  const behind = [...expected].filter(([service, image]) => images.has(service) && images.get(service) !== image);

  report(
    behind.length === 0,
    "running versions",
    behind.length === 0 ? `the containers run the applied versions (${toolsFor(office).map((tool) => `${tool} ${pins[tool].version}`).join(", ")})` : `${behind.map(([service, image]) => (images.get(service)?.startsWith("sha256:") ? `${service} runs an older build of ${image}` : `${service} runs ${images.get(service)}, not ${image}`)).join("; ")}; run office up`,
  );
}

/** The container's `office` must be the host's, or the image predates the host's executable. */
function officeVersions(office: Office, report: Report): void {
  const host = version();
  let container;

  try {
    container = compose(office, ["exec", "-T", "opencode", "office", "--version"], { capture: true });
  } catch (error) {
    report(false, "office versions", `couldn't run office --version in the opencode container: ${error instanceof Error ? error.message.trim() : String(error)}`);

    return;
  }

  report(container === host, "office versions", container === host ? `host and container run ${host}` : `host runs ${host}, the container ${container} (rebuild the image with office up)`);
}

/** Whether Executor accepts the office's key, which OpenCode and the office's services use. */
async function executorKey(office: Office, report: Report): Promise<void> {
  try {
    const organization = await keyOrganization(office);

    report(organization !== undefined, "Executor key", organization === undefined ? `Executor accepts no key in ${executorEnvFile(office)}; office setup creates one` : `works, saved in ${executorEnvFile(office)}`);
  } catch (error) {
    report(false, "Executor key", error instanceof Error ? error.message : String(error));
  }
}

/** OpenCode's own version: the applied one in the container, within the tested range on the host. */
async function opencodeVersion(office: Office, report: Report, auth: Record<string, string>, url: string): Promise<void> {
  let info;

  try {
    info = await getJson<{ version: string }>(`${url}/api/info`, auth);
  } catch (error) {
    report(false, "OpenCode version", String(error));

    return;
  }

  if (office.opencode.mode === "host") {
    report(true, "OpenCode version", `the host's server runs ${info.version} (not pinned by office)${isTested("opencode", info.version) ? "" : `; tested with ${tested.opencode.from}–${tested.opencode.to}`}`);

    return;
  }

  const applied = runningPins(office).opencode.version;

  report(info.version === applied, "OpenCode version", info.version === applied ? `${info.version}` : `the server runs ${info.version}, not the applied ${applied}; run office up`);
}
