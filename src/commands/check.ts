// `office check`: drift between office.yaml, the tool and the folders, then, when this office's
// containers are running, whether Executor is ready, each desk loads what it should on the OpenCode
// server of the office's mode, the container runs the host's `office`, and the cron jobs are
// scheduled (supercronic, or the host's timers).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { timerStates } from "../cron/host.ts";
import { ghConfigDir, ghLogin, ghPin, githubHosts, gitHelper, isGhHelper, loginProblem, unshareable } from "../github.ts";
import { installedTool } from "../host-tools.ts";
import { clones, library, pluginDrift, skillSelections } from "../layout.ts";
import { type Office, readEnvFile } from "../office.ts";
import { pinnedTools } from "../schema.ts";
import { version } from "../tool.ts";
import { changes, defaultPins, describeMove, executorImage, isTested, readApplied, tested, toolsFor, wantedPins } from "../versions.ts";
import { appFolders, deployedFrameworks } from "./apps.ts";
import { compose, officeImage, ports, runningPins } from "./compose.ts";
import { executorKeys, keyOrganization } from "./executor.ts";

/** Prints one check; "warn" is shown but doesn't fail `office check`. */
type Report = (ok: boolean | "warn", name: string, detail: string) => void;

const pluginProblems = {
  missing: "is missing",
  differs: "differs from the tool's copy",
  extra: "is not in the tool's copy",
};

async function drift(office: Office): Promise<string[]> {
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
  for (const file of await pluginDrift(office)) problems.push(`${file.path} ${pluginProblems[file.state]} (office sync restores it)`);

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
    gitChecks(office, report, false);
    await serviceTokens(office, report, false);

    return;
  }

  report(office.opencode.mode === "container" || !running.includes("opencode"), "containers", `running: ${running.join(", ")}${office.opencode.mode === "host" ? ` (OpenCode on the host at ${office.opencode.url})` : ""}`);
  gitChecks(office, report, office.opencode.mode === "container" && running.includes("opencode"));

  if (office.opencode.mode === "container" && running.includes("opencode")) officeVersions(office, report);

  runningImages(office, report);

  const port = ports();

  const health = await settle(
    () => fetch(`http://127.0.0.1:${port.executor}/health`, { signal: AbortSignal.timeout(5_000) }).then((response) => response.status),
    (status) => status === 200,
  ).catch(String);

  report(health === 200, "Executor", health === 200 ? "ready" : `not ready (${health})`);
  await serviceTokens(office, report, health === 200);

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

  await opencodeVersion(office, report, auth, opencode);

  if (hasToken && health === 200) await appFrameworks(office, report);

  cron(office, report, running);
}

/** Each service key office.yaml lists under `executor.tokens`: saved, and when Executor is up, whether it works. */
async function serviceTokens(office: Office, report: Report, reachable: boolean): Promise<void> {
  for (const key of executorKeys(office).filter((item) => item.service)) {
    const name = `Executor token ${key.name}`;
    const saved = readEnvFile(key.path);

    if (saved.EXECUTOR_TOKEN === undefined || saved.EXECUTOR_TOKEN === "") {
      report(false, name, `${key.path} has no EXECUTOR_TOKEN; office setup creates it`);
    } else if (!reachable) {
      report(true, name, `saved in ${key.path}; not tried, Executor isn't running`);
    } else {
      try {
        const organization = await keyOrganization(key);

        if (organization === undefined) report(false, name, `Executor refuses the token in ${key.path}; office setup replaces it`);
        else if (saved.EXECUTOR_ORGANIZATION !== organization) report(false, name, `works, but ${key.path} doesn't name its organization as EXECUTOR_ORGANIZATION; office setup saves it`);
        else report(true, name, `works, saved in ${key.path}`);
      } catch (error) {
        report(false, name, error instanceof Error ? error.message : String(error));
      }
    }
  }
}

/** The versions office.yaml pins, whether office.lock matches, the tested range, and what is pending. */
function versionChecks(office: Office, report: Report): void {
  const tools = toolsFor(office);
  const list = (pins: typeof defaultPins) => tools.map((tool) => `${tool} ${pins[tool].version}`).join(", ");
  let wanted;

  try {
    wanted = wantedPins(office);
  } catch (error) {
    report(false, "versions", error instanceof Error ? error.message : String(error));

    return;
  }

  report(true, "versions", office.versions === undefined ? `office.yaml has no versions block, so the tool's defaults apply: ${list(wanted)}` : `${list(wanted)}, matching office.lock`);

  const untested = tools.filter((tool) => !isTested(tool, wanted[tool].version));

  if (untested.length > 0) {
    report("warn", "tested versions", `${untested.map((tool) => `${tool} ${wanted[tool].version} is outside ${tested[tool].from}–${tested[tool].to}`).join("; ")}, the range this office tool was tested with`);
  }

  const applied = readApplied(office);
  const pending = applied === undefined ? [] : changes(office, applied.pins, wanted);

  if (pending.length > 0) report("warn", "pending upgrade", `${pending.map((move) => describeMove(office, move)).join(", ")}; office up --upgrade applies it`);
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
    report(isTested("opencode", info.version) ? true : "warn", "OpenCode version", `the host's server runs ${info.version}${isTested("opencode", info.version) ? "" : `, outside ${tested.opencode.from}–${tested.opencode.to}, the range this office tool was tested with`}`);

    return;
  }

  const applied = runningPins(office).opencode.version;

  report(info.version === applied, "OpenCode version", info.version === applied ? `${info.version}` : `the server runs ${info.version}, not the applied ${applied}; run office up`);
}

/** Every app in the office, in its folder and as deployed, must name the apps framework Executor serves. */
async function appFrameworks(office: Office, report: Report): Promise<void> {
  try {
    const { version: served, apps } = await deployedFrameworks(office);
    const folders = appFolders(office);
    const local = folders.filter((folder) => JSON.parse(readFileSync(join(folder.dir, "package.json"), "utf8")).dependencies?.apps !== served);
    const deployed = apps.filter((app) => app.apps !== served);
    const missing = folders.filter((folder) => !apps.some((app) => app.slug === folder.slug));

    const problems = [
      ...local.map((folder) => `${relative(office.dir, folder.dir)} names another apps version`),
      ...deployed.map((app) => `${app.slug} is deployed with apps@${app.apps ?? "?"}`),
      ...missing.map((folder) => `${folder.slug} isn't deployed`),
    ];

    report(problems.length === 0, "app frameworks", problems.length === 0 ? `every app is deployed for apps@${served}` : `Executor serves apps@${served}: ${problems.join("; ")}; run office apps deploy`);
  } catch (error) {
    report(false, "app frameworks", error instanceof Error ? error.message : String(error));
  }
}

/**
 * The office's commit identity, and when office.yaml shares the host's gh login, whether it is
 * ready: on the host, and in a running opencode container. An office without it isn't failed.
 */
function gitChecks(office: Office, report: Report, running: boolean): void {
  report(
    true,
    "git identity",
    office.git?.name === undefined
      ? "none in office.yaml: upgrade-tools commits as office cron, other commits use git's own config"
      : `${office.git.name} <${office.git.email}>, the default for ${office.opencode.mode === "container" ? "the container's commits" : "the office's cron jobs (a host server's agents use the host's own git config)"}`,
  );

  if (office.git?.credentials !== "gh") {
    report(true, "GitHub", "office.yaml doesn't use the host's gh login; only sources that read without a login clone, and agents can't push over HTTPS (add credentials: gh under git: to use it)");

    return;
  }

  const gh = installedTool("gh");

  if (gh === undefined) {
    report(false, "GitHub", "office.yaml shares the host's gh login, but gh isn't installed on this host (office setup --install-deps)");

    return;
  }

  const container = office.opencode.mode === "container";
  const hosts = githubHosts(office);

  for (const host of hosts) {
    const login = ghLogin(gh, host);
    const problem = login?.state !== "success" ? `${loginProblem(login)} (office setup guides the login; gh auth status --hostname ${host} shows more)` : container ? unshareable(login) : undefined;

    report(problem === undefined, `GitHub ${host}`, problem ?? `logged in as ${login?.account ?? "?"} with gh ${gh.version}${container ? `, shared read-only from ${ghConfigDir()}` : ""}`);

    const helper = gitHelper(host);

    report(isGhHelper(helper), `GitHub ${host}: host git`, isGhHelper(helper) ? `uses ${helper}` : `doesn't use gh (${helper ?? "no helper"}): run gh auth setup-git --hostname ${host}`);
  }

  if (!container) return;

  const pin = ghPin(office);

  report(pin !== undefined, "GitHub: container gh", pin === undefined ? "mise.toml doesn't pin gh, so the container can't use the login (office setup adds it)" : `gh ${pin} from mise.toml`);

  if (!running) return;

  for (const host of hosts) {
    try {
      // `gh auth status` reads the mounted login and asks the host's API; it never prints the token.
      const helper = compose(office, ["exec", "-T", "opencode", "sh", "-c", `gh auth status --hostname "$1" >/dev/null 2>&1 && git config --get-urlmatch credential.helper "https://$1"`, "sh", host], { capture: true });

      report(helper.endsWith("gh auth git-credential"), `GitHub ${host}: container`, `gh is logged in and git uses ${helper}`);
    } catch {
      report(false, `GitHub ${host}: container`, "gh isn't logged in there, or git doesn't use it; run office up, then office check");
    }
  }
}

/** Prints each check; returns whether all passed. */
export async function check(office: Office): Promise<boolean> {
  let passed = true;

  const report: Report = (ok, name, detail) => {
    console.log(`${ok === "warn" ? "WARN" : ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
    passed &&= ok !== false;
  };

  const problems = await drift(office);

  report(problems.length === 0, "office.yaml and folders", problems.length === 0 ? "in sync" : `${problems.length} problems`);

  for (const problem of problems) console.log(`     - ${problem}`);

  const apps = appFolders(office);

  report(apps.length > 0, "Executor apps", apps.map((app) => relative(office.dir, app.dir)).join(", ") || "none");

  versionChecks(office, report);
  await runtime(office, report);

  return passed;
}
