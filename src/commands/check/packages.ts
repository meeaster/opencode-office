import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import * as v from "valibot";

import { appliedDifference, staleApplied } from "../../applied-settings.ts";
import { claudeFiles } from "../../features/claude/claude.ts";
import { serviceStatus, sharedNamespaces } from "../../features/compose/package-services.ts";
import { packageComposeFile } from "../../features/compose/services.ts";
import { executorAccess } from "../../features/executor/executor.ts";
import { fragmentNotes, machineBelowFloors, machineFile, orphanFragments, packagesFile, packagesFileProblems, strayFragments } from "../../features/mise-integration/delivery.ts";
import { destinationProblems } from "../../features/mise-integration/projection.ts";
import { cloneTarget, pluginClones, pluginProblem } from "../../features/opencode/delivery.ts";
import { configFile, installedPanelNames, locate, panelDir, panelId, panelState, readPanelRecord, removalNote } from "../../features/opencode/desktop.ts";
import { cloneFolder, entries as pluginEntries, entry as entryAt, pluginFolder, readCopies } from "../../features/opencode/ownership.ts";
import { appliedReferences } from "../../features/references/applied-references.ts";
import type { Gathered } from "../../gather.ts";
import { appliedReferenceProblem, referenceOriginProblem } from "../../git.ts";
import { clones, unignoredFolders } from "../../layout.ts";
import { officeInfo, packageHost } from "../../lifecycle-inputs.ts";
import { packageLockProblems } from "../../loader/publication/publish.ts";
import { sourceDrift } from "../../loader/sources/drift.ts";
import { localFolders, pulledFolders, resolvePackages } from "../../loader/sources/selection.ts";
import type { Office } from "../../office.ts";
import { builtinPackages } from "../../tool.ts";
import type { Context, Report } from "./context.ts";
import { servicesRunning } from "./services.ts";

export async function drift(office: Office, { loaded, claims, references, applied: appliedSettings }: Context): Promise<string[]> {
  const problems: string[] = [];
  problems.push(...claudeFiles(office.dir), ...unignoredFolders(office.dir));

  // The applied file is the plugin's and refresh's input, not check's: an invalid one is its own problem.
  const applied = appliedReferences(office.dir, office);

  if (!applied.ok) problems.push(...applied.errors.map(error => `${error}; office sync writes it again`));

  for (const clone of clones(office, references)) {
    if (!existsSync(join(clone.dir, ".git"))) problems.push(`${clone.kind} ${relative(office.dir, clone.dir)} is not cloned`);
    else if (clone.kind === "reference") {
      const problem = referenceOriginProblem(clone.dir, clone.url) ?? appliedReferenceProblem(clone.dir, clone.url, clone.ref);

      if (problem) problems.push(`reference ${clone.name}: ${problem}`);
    }
  }

  const copies = readCopies(office);
  const cloned = new Set(office.plugins.map(plugin => plugin.name));

  for (const name of copies) {
    if (!loaded.unread.has(name) && !loaded.plugins.has(name)) problems.push(`${pluginFolder}/${name} is a copy of no declared package plugin (office sync removes it)`);
  }

  for (const { name, office: owned, target, copied } of pluginEntries(office, copies)) {
    if (copied || !owned || target === undefined || loaded.unread.has(name) || loaded.plugins.has(name) || (cloned.has(name) && target === cloneTarget(name))) continue;
    problems.push(`${pluginFolder}/${name} links to ${target}, the plugin of no declared package or clone (office sync removes it)`);
  }

  for (const clone of pluginClones(office)) {
    const link = entryAt(office, clone.name, copies);

    if (existsSync(join(clone.dir, ".git")) && !(link?.office && !link.copied && link.target === cloneTarget(clone.name))) problems.push(`plugin ${clone.name} is cloned but ${pluginFolder}/${clone.name} doesn't link to it${link && !link.office ? " (an entry of the office's own is there)" : " (office sync links it)"}`);
  }

  const { packages } = resolvePackages(office);
  const builtins = builtinPackages();

  for (const folder of localFolders(office)) {
    if (builtins.includes(folder)) problems.push(`packages/${folder}/ has the name of a built-in package, which an entry without repo always means; rename the folder and the package name in its definition and office.yaml`);
    else if (!packages.some((item) => item.kind === "local" && item.entry.name === folder)) problems.push(`packages/${folder}/ is not a package in office.yaml, so its plugin isn't linked`);
  }

  for (const folder of pulledFolders(office)) {
    if (!loaded.unread.has(folder) && !packages.some((item) => item.kind !== "local" && item.entry.name === folder)) problems.push(`.office/packages/${folder}/ is a package office.yaml no longer lists (office sync removes it)`);
  }

  const listed = [...loaded.selected];

  problems.push(...orphanFragments(office, listed), ...strayFragments(office), ...(claims ? packagesFileProblems(office, claims.packages, listed) : []));

  problems.push(...packageLockProblems(office), ...staleApplied(appliedSettings, loaded.selected));

  return problems;
}

/**
 * Clones in `.office/plugins/` that no `plugins:` entry declares, such as a withdrawn one. Sync
 * never deletes them, since a checkout may hold local work, so check says where they are.
 */
export function withdrawnClones(office: Office, report: Report): void {
  const folder = join(office.dir, cloneFolder);

  if (!existsSync(folder)) return;
  const declared = new Set(office.plugins.map((plugin) => plugin.name));

  for (const name of readdirSync(folder).filter((item) => !item.startsWith(".") && !declared.has(item)).sort()) {
    report("warn", `plugin clone ${name}`, `${cloneFolder}/${name} is a checkout no plugins: entry declares, so nothing loads it; office sync keeps it, as it may hold local work. If you don't want it, remove ${cloneFolder}/${name}`);
  }
}

/**
 * One line per package: its kind and where it came from, whether a pulled-in copy was edited,
 * whether its settings are valid and applied, its mise tools, and its delivered plugin.
 */
export async function packageChecks(office: Office, report: Report, { gathered, loaded, claims, applied }: Context): Promise<void> {
  const { installed, plugins } = loaded;
  const problems = [...gathered.problems, ...loaded.problems.filter(problem => !gathered.problems.some(known => known.message === problem.message))];
  const shared = sharedNamespaces(installed);
  const copies = readCopies(office);
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

  for (const resolved of packages) {
    const { entry, kind, dir } = resolved;

    reported.add(entry.name);

    const item = installed.find((candidate) => candidate.entry.name === entry.name);
    const own = problems.flatMap(problem => problem.packages.includes(entry.name) ? [problem.message] : []);

    if (item === undefined) {
      report(false, `package ${entry.name}`, own.join("; ") || (loaded.blocked ? "not loaded: other selected packages failed the checks before loading" : ""));

      continue;
    }

    const notes: string[] = [kind === "local" ? `the office's own, in ${relative(office.dir, dir)}/` : `${kind}, in ${relative(office.dir, dir)}/`];
    const { ok: sourceOk, copyNotes, declarationNotes } = await sourceDrift(office, resolved);
    const difference = appliedDifference(applied, item);

    notes.push(...copyNotes, difference === undefined ? "settings valid and applied" : `settings valid, but ${difference}`, ...declarationNotes);
    let ok = sourceOk && own.length === 0 && difference === undefined;

    const services = serviceStatus(office, item);
    const sharing = shared.get(entry.name);

    if (sharing !== undefined) {
      ok = false;
      notes.push(`its namespace ${item.manifest.namespace} is also package ${sharing.join(" and ")}'s, so office up refuses both; give one another namespace in its package definition`);
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

    // A version the office changed is its own pin, not drift: only a missing tool, or one below
    // what the package needs, is.
    const claimed = claims?.packages.find((candidate) => candidate.entry.name === entry.name);

    if (claimed) {
      const tools = fragmentNotes(office, claimed);

      notes.push(...tools.notes);

      if (!tools.ok) ok = false;
    }

    const plugin = plugins.get(entry.name);

    if (plugin) {
      const problem = pluginProblem(office, entry.name, plugin, copies);

      notes.push(problem ?? `plugin ${plugin.kind === "copy" ? "copied to" : "linked as"} ${pluginFolder}/${entry.name} (office-wide discovery)`);

      if (problem) ok = false;
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

  if (!claims) {
    report("warn", "package claims", `not checked while a package doesn't load: the shared ${packagesFile}, the fragments in .office/mise/, machine destinations, the checkouts of packages' references and packages' own check functions; fix the packages above, then office check`);

    return;
  }

  // machine.toml is the office's to hold a tool back, so a pin below a package's version only warns.
  for (const error of destinationProblems(office, claims.packages)) report(false, "machine destinations", error);

  for (const line of machineBelowFloors(office, claims.packages)) report("warn", machineFile, line);

  await packageCheckFunctions(office, report, claims);
}

/** What a `check` function may return: a list of problems. */
const problemList = v.array(v.strictObject({ level: v.picklist(["warning", "failed"]), message: v.string() }));

/**
 * Each package's own `check` function, in the order packages loaded, from a complete gathering: a
 * warning line for each warning, a failed line for each failure, and a failed line naming the
 * package for one that throws or returns something other than problems.
 */
async function packageCheckFunctions(office: Office, report: Report, gathered: Pick<Gathered, "packages" | "entries">): Promise<void> {
  for (const item of gathered.packages) {
    const name = `package ${item.entry.name}`;

    if (!item.manifest.check) continue;
    let problems: unknown;

    try {
      problems = await item.manifest.check({ office: officeInfo(office), entries: gathered.entries, settings: structuredClone(item.settings), host: packageHost(office, item.entry.name, { readOnly: true }), executor: executorAccess(office, { readOnly: true }) });
    } catch (error) {
      report(false, name, `its check failed: ${error instanceof Error ? error.message : String(error)}`);

      continue;
    }

    if (!v.is(problemList, problems)) {
      report(false, name, "its check returned something other than a list of problems");

      continue;
    }

    for (const { level, message } of problems) report(level === "warning" ? "warn" : false, name, message);
  }
}

/**
 * One line per package panel: installed on the desktop app's machine, registered in its config, and
 * the office's copy, naming the office that installed another (the install is per machine, so the
 * last sync wins). Also one line for each panel this office installed whose package it no longer lists.
 */
export function panelChecks(office: Office, report: Report, { loaded: plan }: Context): void {
  const panels = [...plan.panels].map(([name, bundle]) => ({ name, bundle }));
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
    const record = readPanelRecord(machine, name);

    // An unread package is still selected; its registration is unknown, so give no removal advice.
    if (panels.some((panel) => panel.name === name) || plan.unread.has(name) || record?.dir !== office.dir || record.office !== office.name) continue;

    report("warn", `panel ${panelId(name)}`, `this office installed it, but none of its packages has that panel now. ${removalNote(machine, name)}`);
  }
}
