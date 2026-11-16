// `office check`: drift between office.yaml, the tool and the folders, then, when this office's
// containers are running, whether Executor is ready, each desk loads what it should on the OpenCode
// server of the office's mode, the container runs the host's `office`, and the cron jobs are
// scheduled (supercronic, or the host's timers).
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { timerStates } from "../cron/host.ts";
import { clones, library, pluginDrift, skillSelections } from "../layout.ts";
import { type Office, readEnvFile } from "../office.ts";
import { version } from "../tool.ts";
import { appFolders } from "./apps.ts";
import { compose, ports } from "./compose.ts";

type Report = (ok: boolean, name: string, detail: string) => void;

const pluginProblems = {
  missing: "is missing",
  differs: "differs from the tool's copy",
  extra: "is not in the tool's copy",
};

function drift(office: Office): string[] {
  const problems: string[] = [];
  const libraryIds = library(office);
  const declared = new Set(office.desks.map((desk) => desk.name));

  for (const desk of office.desks) {
    for (const path of ["AGENTS.md", ".opencode/opencode.jsonc", `executor/apps/${desk.name}/index.ts`]) {
      if (!existsSync(join(office.dir, desk.name, path))) problems.push(`desk ${desk.name}: ${desk.name}/${path} is missing`);
    }
  }

  // A top-level folder with its own .opencode/ looks like a desk office.yaml doesn't declare.
  for (const entry of readdirSync(office.dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith(".") && !declared.has(entry.name) && existsSync(join(office.dir, entry.name, ".opencode"))) {
      problems.push(`${entry.name}/ has a .opencode/ folder but is not a desk in office.yaml`);
    }
  }

  for (const clone of clones(office)) {
    if (!existsSync(join(clone.dir, ".git"))) problems.push(`${clone.kind} ${relative(office.dir, clone.dir)} is not cloned`);
  }

  // A hand edit, or an office last synced by an older `office`; `office sync` restores the copy.
  for (const file of pluginDrift(office)) problems.push(`${file.path} ${pluginProblems[file.state]} (office sync restores it)`);

  for (const skill of office.skills.copied) {
    if (!libraryIds.includes(skill.name)) problems.push(`copied skill skills/${skill.name} is missing`);
  }

  for (const selection of skillSelections(office)) {
    const where = selection.desk ?? "the root";

    for (const skill of selection.enabled) {
      if (!libraryIds.includes(skill)) problems.push(`${where} enables ${skill}, which is not in skills/`);
      else if (!selection.links.has(skill) && !selection.folders.includes(skill)) problems.push(`${where}: ${skill} is enabled but not linked`);
    }

    for (const [entry, target] of selection.links) {
      const path = relative(office.dir, join(selection.folder, entry));

      if (!selection.enabled.includes(entry)) problems.push(`${path} is linked but nothing enables it`);
      else if (target !== selection.target(entry)) problems.push(`${path} points to ${target}, not ${selection.target(entry)}`);
    }
  }

  return problems;
}

// OpenCode's list responses, with only the fields the check reads.
type Listing<Item> = { data: Item[] };

type McpServer = { name: string; status: { status: string; error?: string } };

async function getJson<Result>(url: string, headers: Record<string, string> = {}): Promise<Result> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });

  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);

  return JSON.parse(await response.text());
}

// Right after `office up`, OpenCode refuses connections, then lists no agents until the folder
// has loaded. Poll until `ready` holds or a minute passes, and return the last answer.
async function settle<Result>(read: () => Promise<Result>, ready: (value: Result) => boolean): Promise<Result> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 30; attempt++) {
    if (attempt > 0) await Bun.sleep(2_000);

    try {
      const value = await read();

      if (ready(value) || attempt === 29) return value;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}

/** Skill IDs a session in `desk` (undefined: the root) must load, and the office's others it must not. */
function expectedSkills(office: Office, desk: string | undefined) {
  const selections = skillSelections(office);
  const own = (selection: { enabled: string[]; folders: string[] } | undefined) => (selection === undefined ? [] : [...selection.enabled, ...selection.folders]);
  const root = selections.find((selection) => selection.desk === undefined);
  const mine = desk === undefined ? [] : own(selections.find((selection) => selection.desk === desk));
  const expected = new Set([...own(root), ...mine]);
  const everything = new Set([...library(office), ...selections.flatMap(own)]);

  return { expected: [...expected], forbidden: [...everything].filter((skill) => !expected.has(skill)) };
}

function cron(office: Office, report: Report, running: string[]): void {
  if (office.opencode.mode === "host") {
    for (const timer of timerStates(office)) {
      report(timer.active, `timer ${timer.unit}`, timer.active ? `${timer.calendar}; next ${timer.next || "?"}, last ${timer.last || "never"}` : "not active (office up installs it)");
    }

    return;
  }

  if (!running.includes("opencode")) return;

  const processes = compose(office, ["top", "opencode"], { capture: true });

  report(processes.includes("supercronic"), "cron", processes.includes("supercronic") ? "supercronic runs in the opencode container" : "supercronic isn't running in the opencode container");
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

async function runtime(office: Office, report: Report): Promise<void> {
  const running = compose(office, ["ps", "--status", "running", "--format", "{{.Service}}"], { capture: true, profiles: "container" }).split("\n").filter(Boolean);

  if (!running.includes("opencode") && !running.includes("executor")) {
    report(true, "containers", `not running (start them with office up)`);

    return;
  }

  report(office.opencode.mode === "container" || !running.includes("opencode"), "containers", `running: ${running.join(", ")}${office.opencode.mode === "host" ? ` (OpenCode on the host at ${office.opencode.url})` : ""}`);

  if (office.opencode.mode === "container" && running.includes("opencode")) officeVersions(office, report);

  const port = ports();

  const health = await settle(
    () => fetch(`http://127.0.0.1:${port.executor}/health`, { signal: AbortSignal.timeout(5_000) }).then((response) => response.status),
    (status) => status === 200,
  ).catch(String);

  report(health === 200, "Executor", health === 200 ? "ready" : `not ready (${health})`);

  const password = readEnvFile(join(office.state, "secrets.env")).OPENCODE_PASSWORD;
  const auth = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
  const opencode = office.opencode.url ?? `http://127.0.0.1:${port.opencode}`;
  const base = office.opencode.directory;
  const hasToken = readEnvFile(join(office.state, "opencode-executor.env")).EXECUTOR_TOKEN !== undefined;

  for (const desk of [undefined, ...office.desks.map((entry) => entry.name)]) {
    const where = desk ?? "root";
    const headers = { ...auth, "x-opencode-directory": desk === undefined ? base : `${base}/${desk}` };

    try {
      const agents = await settle(() => getJson<Listing<{ id: string }>>(`${opencode}/api/agent`, headers), (answer) => answer.data.length > 0);

      report(agents.data.length > 0, `${where}: agents`, agents.data.map((agent) => agent.id).join(", "));

      const loaded = new Set((await getJson<Listing<{ id: string }>>(`${opencode}/api/skill`, headers)).data.map((skill) => skill.id));
      const { expected, forbidden } = expectedSkills(office, desk);
      const missing = expected.filter((skill) => !loaded.has(skill));
      const leaked = forbidden.filter((skill) => loaded.has(skill));

      report(
        missing.length === 0 && leaked.length === 0,
        `${where}: skills`,
        [`loads ${expected.join(", ") || "none of the office's"}`, ...(missing.length > 0 ? [`MISSING ${missing.join(", ")}`] : []), ...(leaked.length > 0 ? [`SHOULD NOT LOAD ${leaked.join(", ")}`] : [])].join("; "),
      );

      const mcp = await settle(
        () => getJson<Listing<McpServer>>(`${opencode}/api/mcp`, headers),
        (answer) => !hasToken || answer.data.some((entry) => entry.name === "office-executor" && entry.status.status === "connected"),
      );

      const executor = mcp.data.find((entry) => entry.name === "office-executor");
      const status = executor?.status.status ?? "missing";

      report(
        status === "connected" || !hasToken,
        `${where}: office-executor MCP`,
        hasToken ? `${status}${executor?.status.error === undefined ? "" : ` ${executor.status.error}`}` : `no token yet: put EXECUTOR_TOKEN in ${join(office.state, "opencode-executor.env")}`,
      );
    } catch (error) {
      report(false, `${where}: OpenCode`, String(error));
    }
  }

  cron(office, report, running);
}

/** Prints each check; returns whether all passed. */
export async function check(office: Office): Promise<boolean> {
  let passed = true;

  const report: Report = (ok, name, detail) => {
    console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
    passed &&= ok;
  };

  const problems = drift(office);

  report(problems.length === 0, "office.yaml and folders", problems.length === 0 ? "in sync" : `${problems.length} problems`);

  for (const problem of problems) console.log(`     - ${problem}`);

  const apps = appFolders(office);

  report(apps.length > 0, "Executor apps", apps.map((app) => relative(office.dir, app.dir)).join(", ") || "none");

  await runtime(office, report);

  return passed;
}
