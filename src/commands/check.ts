// `office check`: drift between office.yaml, the tool and the folders, the packages and their
// panels on the desktop app's machine, then, when this office's
// containers are running, whether Executor is ready, each desk loads what it should on the OpenCode
// server of the office's mode, the container runs the host's `office`, the cron jobs are
// scheduled (supercronic, or the host's timers), and in container mode the image refresh timer is
// active and the image's Debian packages are recent. Last, for information, what sessions load from
// outside the office (the session's home, folders above the office).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { claudeFiles } from "../claude.ts";
import { cronRevision } from "../cron/container.ts";
import { cronTimers, hasSystemd, refreshTimer, staleTimerUnits, timerStates } from "../cron/host.ts";
import { collectJobs } from "../cron/jobs.ts";
import { configFile, installedPanelNames, locate, panelDir, panelId, panelState, readPanelRecord, removalNote } from "../desktop.ts";
import { ghConfigDir, ghLogin, githubHosts, gitHelper, isGhHelper, loginProblem, unshareable } from "../github.ts";
import { hookNote, hookState } from "../hook.ts";
import { planServer, serverReport } from "../host-server.ts";
import { officeCommands, officePins, officeTool, officeToolNamed, required } from "../host-tools.ts";
import { clones, installedPackages, library, oldKnowledgePlugin, pluginLinks, skillSelections } from "../layout.ts";
import { editedOfficeSkill, executorEntryState, hasOldOfficePlugin, officeSkillState, oldMiseFiles, pulledLocalFolders, versionsLackSfw } from "../migrate.ts";
import { oldExecutorAppDirs } from "../executor-app-layout.ts";
import { executorEnvFile, type Office, readEnvFile, skillGroups } from "../office.ts";
import { isCurrent, readSkillRecord, skillDir } from "../skill-copies.ts";
import { packageComposeFile, serviceStatus, sharedNamespaces } from "../package-services.ts";
import { hostServiceStatus } from "../package-host-services.ts";
import { envFilePath, hostWrappers, sourceLine, sourcedBy } from "../host-env.ts";
import { claim, machineReport, matchesServerUnit, requireServerConsent } from "../machine.ts";
import { wrappedCommands } from "../sfw.ts";
import { toolPins } from "../mise-toml.ts";
import { fragmentNotes, machineFile, orphanFragments, strayFragments } from "../package-tools.ts";
import { describeRecord, fileHashes, localEdits, localFolders, officeFile, officeText, pulledFolders, readOnlyNote, readRecord, resolvePackages, settingsFile, settingsText, sourceFile } from "../packages.ts";
import { describeIgnoredSkills, ignoredSkills, readIgnoredFolders } from "../../packages/office/plugin/ignored-skills.ts";
import { describeOutside, type Loaded, type Provided, scanOutside, sessionPlaces, shadowing, withLoaded } from "../outside.ts";
import { pinnedTools } from "../schema.ts";
import { builtinFiles, builtinPackages, version } from "../tool.ts";
import { changes, defaultPins, describeMove, executorImage, isTested, lockFile, lockLacksSfw, readApplied, tested, toolsFor, wantedPins } from "../versions.ts";
import { appFolders, deployedFrameworks } from "./apps.ts";
import { compose, officeImage, ports, runningPins } from "./compose.ts";
import { keyOrganization } from "./executor.ts";
import type { Stage } from "../report/index.ts";

/** Prints one check; "warn" is shown but doesn't fail `office check`. */
type Report = (ok: boolean | "warn", name: string, detail: string) => void;

async function drift(office: Office): Promise<string[]> {
  const problems: string[] = [];
  const libraryIds = library(office);
  const declared = new Set(office.desks.map((desk) => desk.name));

  problems.push(...claudeFiles(office.dir));

  for (const old of oldExecutorAppDirs(office)) problems.push(`${old}/ uses the previous Executor app layout; run office sync`);

  for (const desk of office.desks) {
    const app = `executor-apps/${desk.name}`;

    for (const path of ["AGENTS.md", ".opencode/opencode.jsonc", ...(desk.app ? [`${app}/index.ts`] : [])]) {
      if (!existsSync(join(office.dir, desk.name, path))) problems.push(`desk ${desk.name}: ${desk.name}/${path} is missing`);
    }

    // `office apps deploy` deploys every app folder, so a leftover one would still go out.
    if (!desk.app && existsSync(join(office.dir, desk.name, app))) {
      problems.push(`desk ${desk.name}: has app: false but ${desk.name}/${app}/ exists; delete it, and the ${desk.name} app in Executor if it was deployed`);
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

  // What an office laid out by an earlier release still holds; `office sync` moves it on.
  if (hasOldOfficePlugin(office)) problems.push(".opencode/plugins/office/ is the copy of the tool's plugin earlier releases wrote (office sync replaces it with the office package's plugin)");

  const skill = officeSkillState(office);

  if (skill === "shipped") problems.push("skills/office/ is the copy of the office skill earlier releases wrote, which the office package provides now (office sync removes it)");
  else if (skill === "edited") problems.push(editedOfficeSkill);

  const executor = executorEntryState(office);

  if (executor.state === "template") problems.push(".opencode/opencode.jsonc declares the office-executor MCP server, which the office package registers now (office sync removes the entry)");
  else if (executor.state === "differs") problems.push(".opencode/opencode.jsonc declares office-executor differently from the entry office init wrote; the office package registers that server now, so remove the entry yourself");
  else if (executor.state === "unreadable") problems.push(`.opencode/opencode.jsonc can't be read: ${executor.error}`);

  const pulledLocal = pulledLocalFolders(office);

  for (const name of pulledLocal) problems.push(`packages/${name}/ was pulled in from a repository (office sync moves it to .office/packages/${name}/)`);

  if (oldKnowledgePlugin(office)) problems.push(".opencode/plugins/knowledge/ is the knowledge plugin earlier releases of office wrote, which the knowledge package replaced (office sync removes it)");

  const plugins = pluginLinks(office);

  for (const [name, target] of plugins.links) {
    if (plugins.wanted.get(name) !== target) problems.push(`.opencode/plugins/${name} links to ${target}, the plugin of no declared package (office sync removes it)`);
  }

  for (const group of skillGroups(office)) {
    for (const skill of group.skills) {
      if (!libraryIds.includes(skill.name)) problems.push(`copied skill skills/${skill.name} is missing`);
      else if (group.grouped && !isCurrent(readSkillRecord(skillDir(office, skill.name)), skill, group.ref)) problems.push(`copied skill skills/${skill.name} isn't the copy of ${skill.path} at ${group.ref} that office.yaml pins (office sync copies it, unless it was edited)`);
    }
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

  const { packages } = resolvePackages(office);
  const builtins = builtinPackages();

  for (const folder of localFolders(office)) {
    if (pulledLocal.includes(folder)) continue;

    if (builtins.includes(folder)) problems.push(`packages/${folder}/ has the name of a built-in package, which an entry without repo always means; rename the folder, its package.yaml and its entry`);
    else if (!packages.some((item) => item.kind === "local" && item.entry.name === folder)) problems.push(`packages/${folder}/ is not a package in office.yaml, so its plugin isn't linked`);
  }

  for (const folder of pulledFolders(office)) {
    if (!packages.some((item) => item.kind !== "local" && item.entry.name === folder)) problems.push(`.office/packages/${folder}/ is a package office.yaml no longer lists (office sync removes it)`);
  }

  problems.push(...orphanFragments(office, packages.map((item) => item.entry.name)), ...strayFragments(office));

  if (versionsLackSfw(office)) problems.push("office.yaml's versions don't pin sfw (Socket Firewall), which earlier releases didn't pin, so the tool's default applies (office sync pins it)");
  else if (office.versions?.sfw === defaultPins.sfw.version && lockLacksSfw(office.dir)) problems.push(`${lockFile} has no sfw entry, as earlier releases wrote it (office sync adds it)`);

  for (const { from, to } of oldMiseFiles(office)) {
    problems.push(`${relative(office.dir, from)} is where earlier releases kept it, and mise loads it there as the office's project config (office sync moves it to ${relative(office.dir, to)})`);
  }

  return problems;
}

/**
 * Whether a pulled-in package's files are the copy office sync put there, and for a built-in one,
 * this executable's copy. Each note is added to `notes`; returns whether the copy is as it should be.
 */
async function pulledCopy(dir: string, kind: "built-in" | "remote", name: string, notes: string[]): Promise<boolean> {
  const record = readRecord(dir);

  if (record === undefined) {
    notes.push(`no readable ${sourceFile} (office sync replaces the copy)`);

    return false;
  }

  notes.push(`from ${describeRecord(record)}`);

  const edits = localEdits(dir, record);

  if (edits.length > 0) {
    notes.push(`package files edited: ${edits.join(", ")}; office sync restores them, as ${readOnlyNote}`);

    return false;
  }

  if (kind === "built-in") {
    const wanted = new Map([...(await builtinFiles(name))].map(([file, content]) => [file, new Bun.CryptoHasher("sha256").update(content).digest("hex")]));

    if (!Bun.deepEquals(fileHashes(dir), Object.fromEntries(wanted))) {
      notes.push("differs from this office executable's copy (office sync updates it)");

      return false;
    }
  }

  notes.push("package files as copied");

  return true;
}

/**
 * One line per package: its kind and where it came from, whether a pulled-in copy was edited,
 * whether its settings are valid and written, its mise tools, and the plugin it links.
 */
async function packageChecks(office: Office, report: Report): Promise<void> {
  const { installed, plugins, problems } = installedPackages(office);
  const shared = sharedNamespaces(installed);
  const links = pluginLinks(office);
  const { packages } = resolvePackages(office);
  const reported = new Set<string>();
  let running: string[] | undefined;

  // Asked of Docker once, and only when a package has services; without Docker, nothing runs.
  const runningServices = () => {
    try {
      running ??= servicesRunning(office);
    } catch {
      running = [];
    }

    return running;
  };

  for (const { entry, kind, dir } of packages) {
    reported.add(entry.name);

    const item = installed.find((candidate) => candidate.entry.name === entry.name);
    const own = problems.filter((problem) => problem.packages.includes(entry.name)).map((problem) => problem.message);

    if (item === undefined) {
      report(false, `package ${entry.name}`, own.join("; "));

      continue;
    }

    const notes: string[] = [kind === "local" ? `the office's own, in ${relative(office.dir, dir)}/` : `${kind}, in ${relative(office.dir, dir)}/`];
    let ok = own.length === 0;

    if (kind !== "local") {
      ok = (await pulledCopy(dir, kind, entry.name, notes)) && ok;

      const record = readRecord(dir);

      if (kind === "remote" && entry.source !== undefined && record !== undefined && !("repo" in record && record.repo === entry.source.repo && record.path === entry.source.path && record.ref === entry.source.ref)) {
        notes.push(`office.yaml asks for ${entry.source.ref}; office sync updates it`);
        ok = false;
      }
    }

    const settingsPath = join(item.dir, settingsFile);
    const written = existsSync(settingsPath) && readFileSync(settingsPath, "utf8") === settingsText(item);

    notes.push(written ? `settings valid and written to ${relative(office.dir, settingsPath)}` : `settings valid, but ${relative(office.dir, settingsPath)} doesn't hold them; office sync writes it`);

    if (!written) ok = false;

    const officePath = join(item.dir, officeFile);

    if (!existsSync(officePath) || readFileSync(officePath, "utf8") !== officeText(office)) {
      ok = false;
      notes.push(`${relative(office.dir, officePath)} doesn't say opencode: ${office.opencode.mode}; office sync writes it`);
    }

    // Skills reach OpenCode only through the package's plugin; earlier releases linked them.
    if (item.skills.length > 0 && !item.plugin) {
      ok = false;
      notes.push(`skills ${item.skills.join(", ")} don't load: the package has no plugin to register them${kind === "remote" ? " (move ref to a version that has one)" : ""}`);
    }

    const services = serviceStatus(office, item);
    const sharing = shared.get(entry.name);

    if (sharing !== undefined) {
      ok = false;
      notes.push(`its namespace ${item.manifest.namespace} is also package ${sharing.join(" and ")}'s, so office up refuses both; give one another namespace: in its package.yaml`);
    }

    if (services.services.length > 0 || services.problems.length > 0) {
      const running = runningServices().filter((service) => services.services.includes(service));
      const state = running.length > 0 ? ` (running: ${running.join(", ")})` : runningServices().length > 0 && services.problems.length === 0 ? " (not running; office up starts them)" : "";

      notes.push(`${packageComposeFile} contributes services ${services.services.join(", ") || "none"}${item.manifest.namespace === entry.name ? "" : ` in namespace ${item.manifest.namespace}`}${state}`);
    }

    if (services.problems.length > 0) {
      ok = false;
      notes.push(`${packageComposeFile} problems, so office up won't apply it: ${services.problems.join("; ")}`);
    }

    if (services.pending) notes.push(`its ${packageComposeFile} changed since office up applied it; office up --upgrade applies it`);

    // A version the office changed is its own pin, not drift: only a missing or extra tool is.
    const tools = fragmentNotes(office, item);

    notes.push(...tools.notes);

    if (!tools.ok) ok = false;

    if (plugins.has(entry.name)) {
      const pluginLinked = links.links.get(entry.name) === links.wanted.get(entry.name);

      notes.push(pluginLinked ? `plugin linked as .opencode/plugins/${entry.name} (root, so every desk loads it)` : `plugin not linked; office sync links it as .opencode/plugins/${entry.name}`);

      if (!pluginLinked) ok = false;
    }

    notes.push(...own);
    report(ok, `package ${entry.name}`, notes.join("; "));
  }

  // Entries that resolve to no package, such as a required built-in listed by name.
  for (const problem of problems) {
    for (const name of problem.packages) {
      if (!reported.has(name)) report(false, `package ${name}`, problem.message);
    }
  }
}

/**
 * One line per package panel: installed on the desktop app's machine, registered in its config, and
 * the office's copy, naming the office that installed another (the install is per machine, so the
 * last sync wins). Also one line for each panel this office installed whose package it no longer lists.
 */
function panelChecks(office: Office, report: Report): void {
  const panels = installedPackages(office).installed.flatMap((item) => (item.panel === undefined ? [] : [{ name: item.entry.name, bundle: item.panel }]));
  const where = locate();

  if (where.kind === "container") {
    for (const panel of panels) report("warn", `panel ${panelId(panel.name)}`, "not checked from the container: panels install on the desktop app's machine, so run office check on the host");

    return;
  }

  if (where.kind === "unreachable") {
    for (const panel of panels) report("warn", `panel ${panelId(panel.name)}`, `not checked: ${where.reason}`);

    return;
  }

  const { machine } = where;
  const config = configFile(machine);

  for (const panel of panels) {
    const state = panelState(machine, panel);
    const notes: string[] = [];
    let ok: boolean | "warn" = true;

    if (state.record === undefined && !state.current) {
      ok = false;
      notes.push(`not installed on ${machine.label} (office sync installs it in ${panelDir(machine, panel.name)})`);
    } else if (state.current) {
      notes.push(`installed on ${machine.label} in ${panelDir(machine, panel.name)}, matching this office's bundle${state.record !== undefined && state.record.dir !== office.dir ? ` (last synced by office ${state.record.office})` : ""}`);
    } else {
      ok = "warn";
      notes.push(
        state.record !== undefined && state.record.dir !== office.dir
          ? `${machine.label} has another bundle, installed by office ${state.record.office} (${state.record.dir}); the last sync wins, so office sync here installs this office's`
          : `${machine.label} has another bundle than this office's; office sync installs this office's`,
      );
    }

    if (state.registered === undefined) {
      ok = false;
      notes.push(`${config} can't be read`);
    } else if (state.registered) {
      notes.push(`registered in ${config}`);
    } else {
      ok = false;
      notes.push(`not in plugins in ${config} (office sync adds ${machine.url(panel.name)})`);
    }

    report(ok, `panel ${panelId(panel.name)}`, notes.join("; "));
  }

  for (const name of installedPanelNames(machine)) {
    if (panels.some((panel) => panel.name === name) || readPanelRecord(machine, name)?.dir !== office.dir) continue;

    report("warn", `panel ${panelId(name)}`, `this office installed it, but none of its packages has that panel now. ${removalNote(machine, name)}`);
  }
}

// OpenCode's list responses, with only the fields the check reads.
type Listing<Item> = { data: Item[] };

type McpServer = { name: string; status: { status: string; error?: string } };

type LoadedPlugin = { id: string; source: { type: string; path?: string }; state: { status: string; error?: string } };

/** The root session's skills and plugins as the server listed them. */
type RootAnswer = { skills: { id: string; path: string }[]; plugins: LoadedPlugin[] };

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

/**
 * Skill IDs a session in `desk` (undefined: the root) must load, and the office's others it must
 * not. Package plugins register their skills in every session.
 */
function expectedSkills(office: Office, desk: string | undefined) {
  const selections = skillSelections(office);
  const own = (selection: { enabled: string[]; folders: string[] } | undefined) => (selection === undefined ? [] : [...selection.enabled, ...selection.folders]);
  const root = selections.find((selection) => selection.desk === undefined);
  const mine = desk === undefined ? [] : own(selections.find((selection) => selection.desk === desk));
  const packaged = installedPackages(office).installed.flatMap((item) => (item.plugin ? item.skills : []));
  const expected = new Set([...own(root), ...mine, ...packaged]);
  const everything = new Set([...library(office), ...selections.flatMap(own)]);

  return { expected: [...expected], forbidden: [...everything].filter((skill) => !expected.has(skill)) };
}

function cron(office: Office, report: Report, running: string[]): void {
  const jobs = collectJobs(office);

  if (!jobs.ok) {
    for (const error of jobs.errors) report(false, "cron", error);

    return;
  }

  const timers = office.opencode.mode === "host" ? cronTimers(office, jobs.value) : [refreshTimer(office)];
  const stale = staleTimerUnits(office, timers);

  if (stale.length > 0) report(false, "cron", `obsolete units: ${stale.join(", ")} (office up removes them)`);

  if (office.opencode.mode === "host" || hasSystemd()) {
    for (const timer of timerStates(timers)) {
      const detail = !timer.active ? "not active" : !timer.matches ? "installed schedule differs" : `${timer.calendar}; next ${timer.next || "?"}, last ${timer.last || "never"}`;

      report(timer.active && timer.matches, `timer ${timer.unit}`, timer.active && timer.matches ? detail : `${detail} (run office up)`);
    }
  } else {
    report("warn", "image refresh", "no systemd user manager, so nothing refreshes the opencode image weekly; run office up --refresh yourself");
  }

  if (office.opencode.mode === "host") return;

  imageAge(office, report);

  if (!running.includes("opencode")) return;

  let applied = "";

  try {
    applied = compose(office, ["exec", "-T", "opencode", "printenv", "OFFICE_CRON_REVISION"], { capture: true });
  } catch {
    // Earlier containers do not have a schedule revision.
  }

  if (applied !== cronRevision(jobs.value)) {
    report(false, "cron", "the container's schedule is out of date (run office up)");

    return;
  }

  if (jobs.value.length === 0) return;

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

/**
 * The tools the office CLI runs, the office package's: whether this host has the versions
 * .office/mise/office.toml pins, and which of them the office's own mise files pin too.
 */
function officeToolChecks(office: Office, report: Report): void {
  const install = `office setup --install-deps${office.opencode.mode === "host" ? " or office up" : ""} installs it`;
  const found: string[] = [];

  const pins = officePins(office);

  for (const command of officeCommands) {
    const tool = officeTool(office, command);

    if (tool?.managed === true) {
      found.push(`${command} ${tool.version}`);

      continue;
    }

    const version = pins[command === "age-keygen" ? "age" : command];
    const pin = version === undefined ? `the office package's ${command} isn't in .office/mise/office.toml (office sync writes it)` : `mise hasn't installed ${command} ${version}, the office's pin, on this host`;
    const detail = tool === undefined ? `${pin}, and there is no other copy; ${install}` : `${pin}, so office runs ${command} ${tool.version} from ${tool.path}; ${install}`;

    report(tool === undefined && required.includes(command) ? false : "warn", `office tool ${command}`, detail);
  }

  if (found.length > 0) report(true, "office tools", `${found.join(", ")}: the versions .office/mise/office.toml pins, as mise installed them`);

  const files = ["mise.toml", ...office.desks.map((desk) => join(desk.name, "mise.toml")), machineFile];

  const duplicates = files.flatMap((file) => {
    const path = join(office.dir, file);
    const pins = existsSync(path) ? toolPins(readFileSync(path, "utf8")).filter((pin) => officeToolNamed(pin.tool) !== undefined) : [];

    return pins.length === 0 ? [] : [`${file} pins ${pins.map((pin) => `${pin.tool} ${pin.version}`).join(" and ")}`];
  });

  if (duplicates.length > 0) {
    report("warn", "office tools", `${duplicates.join("; ")}, which the office package now provides in .office/mise/office.toml; you can remove these pins. Where such a pin applies it wins over the package's, so agents can run another version than the office CLI does`);
  }
}

/** The office's services that are running, whichever mode started them. */
function servicesRunning(office: Office): string[] {
  return compose(office, ["ps", "--status", "running", "--format", "{{.Service}}"], { capture: true, profiles: "container" }).split("\n").filter(Boolean);
}

/** The runtime checks; returns the root session's skills and plugins when the server listed them. */
async function runtime(office: Office, report: Report, stage?: Stage): Promise<RootAnswer | undefined> {
  stage?.detail("containers and Executor");
  const running = servicesRunning(office);
  let root: RootAnswer | undefined;

  if (!running.includes("opencode") && !running.includes("executor")) {
    report(true, "containers", `not running (start them with office up)`);
    gitChecks(office, report, false);

    return undefined;
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

  if (health === 200) await executorKey(office, report);

  const password = readEnvFile(join(office.state, "secrets.env")).OPENCODE_PASSWORD;
  const auth = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
  const opencode = office.opencode.url ?? `http://127.0.0.1:${port.opencode}`;
  const base = office.opencode.directory;
  const hasToken = readEnvFile(executorEnvFile(office)).EXECUTOR_TOKEN !== undefined;

  for (const desk of [undefined, ...office.desks.map((entry) => entry.name)]) {
    const where = desk ?? "root";
    stage?.detail(`${where}: agents, skills, plugins and MCP`);
    const headers = { ...auth, "x-opencode-directory": desk === undefined ? base : `${base}/${desk}` };

    try {
      const agents = await settle(() => getJson<Listing<{ id: string }>>(`${opencode}/api/agent`, headers), (answer) => answer.data.length > 0);

      report(agents.data.length > 0, `${where}: agents`, agents.data.map((agent) => agent.id).join(", "));

      const skills = (await getJson<Listing<{ id: string; path: string }>>(`${opencode}/api/skill`, headers)).data;
      const loaded = new Set(skills.map((skill) => skill.id));
      const { expected, forbidden } = expectedSkills(office, desk);
      const missing = expected.filter((skill) => !loaded.has(skill));
      const leaked = forbidden.filter((skill) => loaded.has(skill));

      report(
        missing.length === 0 && leaked.length === 0,
        `${where}: skills`,
        [`loads ${expected.join(", ") || "none of the office's"}`, ...(missing.length > 0 ? [`MISSING ${missing.join(", ")}`] : []), ...(leaked.length > 0 ? [`SHOULD NOT LOAD ${leaked.join(", ")}`] : [])].join("; "),
      );

      // The root's plugins, which every desk loads: each package's, the office package's
      // included. A folder still loading lists none of them yet.
      const plugins = [...installedPackages(office).plugins.keys()];
      const folder = `${base}/.opencode/plugins/`;

      // Each plugin OpenCode loaded from the root's .opencode/plugins/, by folder name.
      const byName = (answer: Listing<LoadedPlugin>) =>
        new Map(answer.data.flatMap(({ source, state }) => (source.type === "local" && source.path?.startsWith(folder) ? [[source.path.slice(folder.length), state] as const] : [])));

      const pluginAnswer = await settle(() => getJson<Listing<LoadedPlugin>>(`${opencode}/api/plugin`, headers), (answer) => plugins.every((name) => byName(answer).has(name)));
      const states = byName(pluginAnswer);

      // What loads from outside is the same in every desk, so the root's answer stands for all.
      if (desk === undefined) root = { skills, plugins: pluginAnswer.data };

      const pluginProblems = plugins.flatMap((name) => {
        const state = states.get(name);

        return state === undefined ? [`${name} not loaded`] : state.status === "active" ? [] : [`${name} failed: ${state.error ?? "no error given"}`];
      });

      report(pluginProblems.length === 0, `${where}: plugins`, pluginProblems.length === 0 ? `${plugins.join(", ")} active` : pluginProblems.join("; "));

      const mcp = await settle(
        () => getJson<Listing<McpServer>>(`${opencode}/api/mcp`, headers),
        (answer) => !hasToken || answer.data.some((entry) => entry.name === "office-executor" && entry.status.status === "connected"),
      );

      const executor = mcp.data.find((entry) => entry.name === "office-executor");
      const status = executor?.status.status ?? "missing";

      report(
        status === "connected" || !hasToken,
        `${where}: office-executor MCP`,
        hasToken ? `${status}${executor?.status.error === undefined ? "" : ` ${executor.status.error}`}` : `no token yet: office setup saves one in ${executorEnvFile(office)}`,
      );
    } catch (error) {
      report(false, `${where}: OpenCode`, String(error));
    }
  }

  await opencodeVersion(office, report, auth, opencode);

  if (hasToken && health === 200) await appFrameworks(office, report);

  stage?.detail("services and timers");
  hostServiceStatus(office, report);
  cron(office, report, running);

  return root;
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

/** Whether Socket Firewall is on, and where it applies in the office's mode. */
function firewallChecks(office: Office, report: Report): void {
  if (!office.socketFirewall) {
    report("warn", "Socket Firewall", "off (socket_firewall: false in office.yaml): package downloads aren't checked; package managers still take only releases at least three days old");

    return;
  }

  if (office.opencode.mode === "host" && claim(office).kind !== "ours") {
    report("warn", "Socket Firewall", "on in office.yaml, but nothing is installed on this machine until the office may manage it (see the machine line), so package downloads here aren't checked");

    return;
  }

  report(
    true,
    "Socket Firewall",
    office.opencode.mode === "host"
      ? `on: ${wrappedCommands.join(", ")} and mise installs go through sfw, from ${hostWrappers()} first on PATH in ${envFilePath()} (each file is on its machine line below)`
      : `on: the image's sfw, with ${wrappedCommands.join(", ")} and mise wrapped, first on PATH in the container (office env --container shows the file); office up rebuilds the image when the pin moves`,
  );
}

/**
 * Whether the user's shell startup sources the environment file: a note, never a failure, since
 * office never edits those files and can't see every way a shell could source it.
 */
function shellCheck(report: Report): void {
  const where = sourcedBy();

  report(
    where === undefined ? "warn" : true,
    "shell environment",
    where === undefined ? `no shell startup file sources ${envFilePath()} that office can see, so your terminal's package managers bypass Socket Firewall; add after mise activate in ~/.zshrc: ${sourceLine()}` : `sourced from ${where}`,
  );
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
    report(true, "OpenCode version", `the host's server runs ${info.version} (not pinned by office)${isTested("opencode", info.version) ? "" : `; tested with ${tested.opencode.from}–${tested.opencode.to}`}`);

    return;
  }

  const applied = runningPins(office).opencode.version;

  report(info.version === applied, "OpenCode version", info.version === applied ? `${info.version}` : `the server runs ${info.version}, not the applied ${applied}; run office up`);
}

/** Every app in the office, in its folder and as deployed, must name the apps framework Executor serves. */
async function appFrameworks(office: Office, report: Report): Promise<void> {
  try {
    const { version: served, apps, catalog } = await deployedFrameworks(office);

    for (const item of catalog) {
      report(!!item.existing, `catalog app ${item.id}`, item.existing ? `installed from ${item.pkg} (${item.existing.id})` : "missing; run office apps deploy");
    }

    const folders = appFolders(office).filter(folder => !folder.adopted);
    // A package's app is read-only; deploy sends it with the served version.
    const local = folders.filter((folder) => folder.fromPackage === undefined && JSON.parse(readFileSync(join(folder.dir, "package.json"), "utf8")).dependencies?.apps !== served);
    const deployed = apps.filter((app) => app.apps !== served);
    const missing = folders.filter((folder) => !apps.some((app) => app.slug === folder.slug));

    const problems = [
      ...local.map((folder) => `${relative(office.dir, folder.dir)} names another apps version`),
      ...deployed.map((app) => `${app.slug} is deployed with apps@${app.apps ?? "?"}`),
      ...missing.map((folder) => `${folder.slug} isn't deployed`),
    ];

    report(problems.length === 0, "app frameworks", problems.length === 0 ? `office-authored apps are deployed for apps@${served}` : `Executor serves apps@${served}: ${problems.join("; ")}; run office apps deploy`);
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

  const hook = hookNote(hookState(office));

  report(hook.warn ? "warn" : true, "pre-commit hook", hook.detail);

  if (office.git?.credentials !== "gh") {
    report(true, "GitHub", "office.yaml doesn't use the host's gh login; only sources that read without a login clone, and agents can't push over HTTPS (add credentials: gh under git: to use it)");

    return;
  }

  const gh = officeTool(office, "gh");

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

  const pin = officePins(office).gh;

  report(pin !== undefined, "GitHub: container gh", pin === undefined ? ".office/mise/office.toml doesn't hold the office package's gh, so the container can't use the login (office sync writes it)" : `gh ${pin} from .office/mise/office.toml, the office package's tools`);

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

/**
 * What sessions load from outside the office, for information: never a failure. Skills and plugins
 * come from the server's answer when there is one, the rest from reading the session's home. The
 * one warning is an outside skill or plugin with the name of one the office provides.
 */
function outsideSection(office: Office, report: Report, root: RootAnswer | undefined, info: (line: string) => void): void {
  const places = sessionPlaces(office);
  const onHost = (path: string) => places.fromSession(path);

  const loaded: Loaded | undefined =
    root === undefined
      ? undefined
      : {
          // Built-in and plugin-embedded skills have skill:// paths.
          skills: new Map(
            root.skills.flatMap((skill) => {
              const path = skill.path.includes("://") ? undefined : onHost(skill.path);

              return path === undefined ? [] : [[skill.id, path] as const];
            }),
          ),
          plugins: root.plugins.flatMap(({ id, source, state }) => {
            const path = source.type === "local" && source.path !== undefined ? onHost(source.path) : undefined;

            return path === undefined ? [] : [{ id, path, active: state.status === "active" }];
          }),
        };

  const scanned = scanOutside(places);
  const items = loaded === undefined ? scanned : withLoaded(scanned, loaded, office.dir);
  const lines = describeOutside(items, places.home);
  const source = loaded === undefined ? "read from the folders" : "skills and plugins as the server reports loading them, the rest read from the folders";

  if (lines.length === 0) info(`info outside the office: nothing in ${places.label} or above the office that sessions here load`);
  else info(`info outside the office: sessions here also load these from ${places.label} or above the office (${source}); listed for information`);

  for (const line of lines) info(`     - ${line}`);

  const installed = installedPackages(office);

  const provided: Provided = {
    skills: new Map([
      ...skillSelections(office).flatMap((selection) => selection.folders.map((id) => [id, `the office's skill ${relative(office.dir, join(selection.folder, id))}`] as const)),
      ...library(office).map((id) => [id, `the office's library skill skills/${id}`] as const),
      ...installed.installed.flatMap((item) => (item.plugin ? item.skills.map((id) => [id, `package ${item.entry.name}'s skill`] as const) : [])),
    ]),
    plugins: new Map([...installed.plugins.keys()].map((name) => [name, `package ${name}'s plugin`])),
  };

  for (const warning of shadowing(items, provided, places.home, loaded)) report("warn", "outside the office", warning);

  // What the office package's skill-folder settings hide from sessions, and what it can't.
  const officePackage = installed.installed.find((item) => item.entry.name === "office");
  const ignored = officePackage === undefined ? [] : readIgnoredFolders(officePackage.dir);

  if (ignored.length === 0) return;

  for (const line of describeIgnoredSkills(ignoredSkills(office.dir, ignored, places.home), places.home)) report(line.ok ? true : "warn", "ignored skill folders", line.text);
}

/** Without a terminal stage, keep each original plain-text line for scripts and setup. */
export async function check(office: Office, stage?: Stage, verbose = false): Promise<boolean> {
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
  const problems = await drift(office);

  report(problems.length === 0, "office.yaml and folders", problems.length === 0 ? "in sync" : `${problems.length} problems`);

  for (const problem of problems) {
    if (stage) stage.error(problem);
    else console.log(`     - ${problem}`);
  }

  await packageChecks(office, report);

  stage?.detail("host tools and machine settings");
  officeToolChecks(office, report);

  firewallChecks(office, report);

  for (const line of machineReport(office)) report(line.ok, line.name, line.detail);

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

  if (office.opencode.mode === "host") shellCheck(report);

  panelChecks(office, report);

  const apps = appFolders(office);

  report(apps.length > 0, "Executor apps", apps.map((app) => relative(office.dir, app.dir)).join(", ") || "none");

  versionChecks(office, report);
  const root = await runtime(office, report, stage);

  stage?.detail("outside skills and plugins");
  outsideSection(office, report, root, line => {
    if (!stage) console.log(line);
    else if (verbose) stage.note(line);
  });

  const summary = `${passed} passed, ${warnings} warnings, ${failed} failed`;

  if (failed) stage?.fail(summary);
  else stage?.done(summary);

  return failed === 0;
}
