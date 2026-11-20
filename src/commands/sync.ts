// `office sync`: makes the office's folders match office.yaml and the tool. It clones and updates,
// moves an office from an earlier release's layout (src/migrate.ts), scaffolds desks that are
// declared but missing, copies declared skills into the library, installs, updates, restores and
// removes packages, writes the mise tools packages declare into machine.packages.toml and their
// setup into .office/mise/ (src/package-tools.ts) and, in a host-mode office the user agreed may
// manage its machine, links them and machine.toml into mise's global conf.d (src/machine.ts), links enabled library skills and package plugins,
// and installs package panels on the desktop app's machine. A package's skills aren't linked: its plugin registers them, so sync
// removes the links earlier releases made.
// It never rewrites AGENTS.md, other hand-written content, an existing app or a file a package's
// template created; it deletes such a file only with its package, and only while unchanged.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { prepareReferenceRefresh } from "../../packages/references/tasks/refresh.ts";
import { claudeFiles } from "../claude.ts";
import { boundRevision, collectReferences } from "../collect-references.ts";
import { beginReferencePublication, planReferenceApply } from "../reference-publication.ts";
import { installPanel, locate, panelBundle, panelId, removalNote } from "../desktop.ts";
import { collectJobs } from "../cron/jobs.ts";
import { needsEnvironmentOwners, syncMachine } from "../machine.ts";
import { cloneOrFetchStreamed, clonePluginStreamed, existingPluginDestination, git, isClone, PluginCheckoutProblem, referenceGit, referenceOriginProblem, refreshCloneStreamed, verifiedHead } from "../git.ts";
import { type Clone, clones, installedPackages, skillSelections } from "../layout.ts";
import { legacyPlugin, linkPlugins, requirePluginDestination, withPluginPlan } from "../../standard/opencode/delivery.ts";
import { migrate } from "../migrate.ts";
import { definitionFiles } from "../package-definition.ts";
import { packageComposeFile } from "../package-services.ts";
import { syncTools } from "../package-tools.ts";
import { type Desk, type Office, skillGroups } from "../office.ts";
import { silentStage, type Stage } from "../report/index.ts";
import { fetchPackage, installBuiltin, type InstalledPackage, installPackage, pulledDir, pulledFolders, removePackage, requirePackageOwnership, resolvePackages } from "../packages.ts";
import { describeGroup, stageGroup } from "../skill-copies.ts";
import { toolFiles, toolPath, writeToolFile } from "../tool.ts";

/** "release-notes" → "Release notes", for titles in scaffolded files. */
function title(name: string): string {
  const words = name.replaceAll("-", " ");

  return words.charAt(0).toUpperCase() + words.slice(1);
}

function fill(text: string, values: Record<string, string>): string {
  let result = text;

  for (const [key, value] of Object.entries(values)) result = result.replaceAll(`__${key}__`, value);

  return result;
}

/**
 * Copies a tool template folder (such as "template/desk"), filling placeholders in file names and
 * contents. Existing files are kept, and so are template paths (after filling) that `include`
 * rejects.
 */
export function copyTemplate(from: string, to: string, values: Record<string, string>, include: (path: string) => boolean = () => true): string[] {
  const written: string[] = [];

  for (const file of toolFiles(from)) {
    const path = fill(file, values);
    const target = join(to, path);

    if (existsSync(target) || !include(path)) continue;

    writeToolFile(target, fill(readFileSync(toolPath(`${from}/${file}`), "utf8"), values));
    written.push(target);
  }

  return written;
}

/**
 * Scaffolds a desk whose folder is missing, or only the starter Executor app of a desk that has
 * none. A desk that has both is left alone; `office check` reports anything else missing. A desk
 * with `app: false` never gets the app; an existing one is left for the human to delete.
 */
function scaffoldDesk(office: Office, desk: Desk): string[] {
  const dir = join(office.dir, desk.name);
  const appPath = join("executor-apps", desk.name);
  const deskExists = existsSync(dir);
  const appExists = !desk.app || existsSync(join(dir, appPath));

  for (const folder of ["repos", "scratch"]) mkdirSync(join(dir, folder), { recursive: true });

  if (deskExists && appExists) return [];

  const written = copyTemplate("template/desk", dir, { DESK: desk.name, DESK_TITLE: title(desk.name) }, (path) =>
    path.startsWith(`${appPath}/`) ? !appExists : !deskExists,
  );

  // Desk apps carry a copy of the office's OpenCode client, so they declare the same provider
  // and one OpenCode account links to all of them.
  if (!appExists) {
    for (const file of ["opencode.ts", "office.ts"]) {
      const copy = join(dir, appPath, file);

      cpSync(join(office.dir, "executor-apps/opencode", file), copy);
      written.push(copy);
    }
  }

  return written;
}

/**
 * Copies skills.copied into the library at the refs office.yaml pins, one group at a time: a
 * missing copy, and a group's copy whose record names another ref. A skill listed alone is copied
 * once and never replaced. Pins only move with `office skills update`.
 */
function copySkills(office: Office): string[] {
  return skillGroups(office).flatMap((group) => {
    const staged = stageGroup(office, group, group.ref);

    if (staged.ok) return staged.apply();

    return [group.grouped ? `FAILED ${describeGroup(group)} at ${group.ref}: ${staged.reason}` : `FAILED to copy skills/${group.skills[0].name}: ${staged.reason}`];
  });
}

/** Makes each .opencode/skills/ hold exactly the enabled library skills as relative links. */
function linkSkills(office: Office): string[] {
  const changes: string[] = [];

  for (const selection of skillSelections(office)) {
    mkdirSync(selection.folder, { recursive: true });

    for (const [entry, target] of selection.links) {
      if (selection.enabled.includes(entry) && target === selection.target(entry)) continue;

      unlinkSync(join(selection.folder, entry));
      changes.push(`unlinked ${relative(office.dir, join(selection.folder, entry))}`);
    }

    for (const skill of selection.enabled) {
      const path = join(selection.folder, skill);

      if (selection.folders.includes(skill)) {
        changes.push(`kept the real folder ${relative(office.dir, path)} instead of linking ${relative(office.dir, join(selection.folder, selection.target(skill)))}`);
      } else if (!existsSync(join(office.dir, "skills", skill))) {
        changes.push(`not linked: skills/${skill} is missing from the library`);
      } else if (selection.links.get(skill) !== selection.target(skill)) {
        symlinkSync(selection.target(skill), path);
        changes.push(`linked ${relative(office.dir, path)}`);
      }
    }
  }

  return changes;
}

/**
 * Removes the knowledge plugin an earlier `office` wrote into each office, which the knowledge
 * package replaced; without that package declared, it says which entry keeps the listing.
 */
function removeOldKnowledgePlugin(office: Office): string[] {
  rmSync(join(office.dir, ".opencode/plugins/knowledge"), { recursive: true });

  const removed = "removed .opencode/plugins/knowledge/, the knowledge plugin earlier releases of office wrote";

  if (office.packages.some((entry) => entry.name === "knowledge")) return [`${removed}; the knowledge package's plugin replaces it`];

  return [`${removed}. Sessions no longer list knowledge/ articles; to keep that, add \`- name: knowledge\` under packages: in office.yaml and run office sync again`];
}

const fetchSlots = 8;
const cloneSlots = 4;

/** Check both the working tree being updated and the effective fetch URL. */
function requirePluginCheckout(office: Office, dir: string, url: string) {
  requirePluginDestination(office);
  const metadata = join(dir, ".git");
  const info = lstatSync(metadata, { throwIfNoEntry: false });

  try {
    if (info?.isDirectory() && !referenceOriginProblem(dir, url) &&
      realpathSync(git(["rev-parse", "--show-toplevel"], dir)) === realpathSync(dir) &&
      realpathSync(git(["rev-parse", "--absolute-git-dir"], dir)) === realpathSync(metadata) &&
      git(["remote", "get-url", "--all", "origin"], dir) === git(["config", "--local", "--get", "remote.origin.url"], dir)
    ) return;
  } catch { /* Refuse without quoting raw Git URLs or credentials. */ }

  throw new PluginCheckoutProblem("cannot verify plugin checkout origin and directory; left unchanged");
}

async function syncPlugin(office: Office, clone: Clone, present: boolean) {
  requirePluginDestination(office);

  if (isClone(clone.dir) !== present) throw new Error("plugin checkout changed; retry sync");
  const verify = () => requirePluginCheckout(office, clone.dir, clone.url);

  try {
    if (!present) {
      // Even an empty folder is the owner's: publication would replace it and its metadata.
      if (lstatSync(clone.dir, { throwIfNoEntry: false })) throw new PluginCheckoutProblem(existingPluginDestination);

      return await clonePluginStreamed(clone.url, clone.ref, clone.dir, office.dir, verify);
    }

    verify();

    // A checkout with no commit (such as one a failed clone left) would be filled in place, where
    // OpenCode already looks. Refuse it before fetching rather than adopt it.
    if (!verifiedHead(clone.dir)) throw new PluginCheckoutProblem("existing plugin checkout has no commit; left unchanged. Move it aside so office sync can clone a fresh copy, then sync again. If an interrupted first sync left it, see \"Recovering an interrupted first clone\" in docs/opencode-sources.md");

    return await refreshCloneStreamed(clone.ref, clone.dir, {}, verify);
  } catch (error) {
    // Raw Git output (including verbose progress) can contain credentialed URLs.
    if (error instanceof PluginCheckoutProblem) throw error;

    throw new Error("plugin Git operation failed; check the checkout, configured repository and ref");
  }
}

/**
 * Clones and updates the office's repositories, references and plugin clones, each reported
 * as a part of `stage` as it runs. Returns one line per change, in office.yaml's
 * order, with a FAILED line for each that failed.
 */
async function syncClones(office: Office, scope: "references" | "others" | "all", stage: Stage, verbose: boolean): Promise<string[]> {
  const references = scope === "others" ? undefined : planReferenceApply(office);

  if (references && !references.ok) {
    const errors = references.errors.map(error => `FAILED ${error}`);

    for (const error of errors) stage.error(error);

    return errors;
  }

  for (const note of references?.value.notes ?? []) stage.warn(note);
  const work = clones(office, references?.value.entries ?? []).filter((clone) => scope !== "references" || clone.kind === "reference");
  const lines: string[][] = work.map(() => []);

  if (work.length === 0) return [];

  stage.detail(`cloning and updating ${work.length} ${work.length === 1 ? "source" : "sources"}, up to ${fetchSlots} at a time (${cloneSlots} new clones)`);
  stage.expect(work.length);

  const updates: (() => Promise<void>)[] = [];
  const missing: (() => Promise<void>)[] = [];

  for (const [index, clone] of work.entries()) {
    const where = relative(office.dir, clone.dir);

    const failed = (message: string) => {
      lines[index].push(`FAILED ${clone.kind} ${where}: ${message}`);

      return message;
    };

    try {
      // Only the package-link owner may withdraw a link. The clone operation never unlinks one.
      if (clone.kind === "plugin" && lstatSync(clone.dir, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("existing symlink kept; move it aside yourself before cloning here");
      const present = isClone(clone.dir);

      let refresh: ReturnType<typeof prepareReferenceRefresh> | undefined;

      if (clone.kind === "reference") {
        if (!references) throw new Error("reference apply requires a current claim");
        const git = referenceGit(clone, apply => references.value.guard(clone.name, apply));
        refresh = prepareReferenceRefresh(present, clone.stale === true, git);
      }

      (present ? updates : missing).push(async () => {
        const part = stage.part(where, present ? "updating" : "cloning");
        const options = { line: part.output, verbose };

        try {
          let result;

          if (refresh) result = await refresh(options);
          else if (clone.kind === "plugin") result = await syncPlugin(office, clone, present);
          else result = await cloneOrFetchStreamed(clone.url, clone.ref, clone.dir, options);
          part.done(result);

          if (result !== "current" && result !== "fetched") lines[index].push(`${result} ${clone.kind} ${where}`);
        } catch (error) {
          part.fail(failed(error instanceof Error ? error.message.trim() : String(error)));
        }
      });
    } catch (error) {
      stage.part(where, "checking").fail(failed(error instanceof Error ? error.message.trim() : String(error)));
    }
  }

  // Half the workers may start new clones. All eight can drain existing-repo fetches.
  await Promise.all(Array.from({ length: fetchSlots }, async (_, slot) => {
    for (;;) {
      const job = (slot < cloneSlots ? missing.shift() : undefined) ?? updates.shift();

      if (!job) return;
      await job();
    }
  }));

  return lines.flat();
}

/** One line for a stage's result from sync's lines: what it cloned and updated, and how many other changes. */
export function summarize(changes: string[]): string {
  const count = (pattern: RegExp) => changes.filter((line) => pattern.test(line)).length;
  const failed = count(/^FAILED/);
  // Clone lines name a kind: reference, plugin or "<desk> repo".
  const cloned = count(/^cloned (reference|plugin|\S+ repo) /);
  const updated = count(/^updated (reference|plugin|\S+ repo) /);
  const other = changes.length - failed - cloned - updated;

  const parts = [
    cloned > 0 ? `${cloned} cloned` : "",
    updated > 0 ? `${updated} updated` : "",
    other > 0 ? `${other} other ${other === 1 ? "change" : "changes"}` : "",
    failed > 0 ? `${failed} failed` : "",
  ].filter(Boolean);

  return parts.length === 0 ? "already in sync" : parts.join(", ");
}

type SyncOptions = {
  scope?: "all" | "references" | "packages";
  /** Where the sync reports as it goes: each clone as a part, then each change line. */
  stage?: Stage;
  /** Ask git for its progress, for a verbose plain run. */
  verbose?: boolean;
};

/**
 * Runs the sync and returns one line per change, each also reported to `stage` as it happens
 * (clones as parts, a line starting with FAILED as an error, the rest as notes).
 */
export async function sync(loaded: Office, { scope = "all", stage = silentStage, verbose = false }: SyncOptions = {}): Promise<string[]> {
  let office = loaded;
  const reported: string[] = [];

  // Every line reported except the clones', which their parts already showed.
  const changes = {
    push(...lines: string[]) {
      for (const line of lines) {
        reported.push(line);

        if (line.startsWith("FAILED")) stage.error(line);
        else stage.note(line);
      }
    },
  };

  if (scope !== "references") requirePackageOwnership(office);

  if (scope === "packages") {
    await syncPackages(office, changes, stage);

    return reported;
  }

  if (scope === "references") return syncClones(office, "references", stage, verbose);

  requirePluginDestination(office);
  stage.detail("migrating, scaffolding desks, copying skills and installing packages");

  const migrated = migrate(office);

  office = migrated.office;
  changes.push(...migrated.changes);

  for (const desk of office.desks) {
    for (const path of scaffoldDesk(office, desk)) changes.push(`created ${relative(office.dir, path)}`);
  }

  changes.push(...copySkills(office));

  const published = await syncPackages(office, changes, stage);
  reported.push(...await syncClones(office, published ? "all" : "others", stage, verbose));
  changes.push(...claudeFiles(office.dir, true));
  changes.push(...linkSkills(office));
  changes.push(...excludePluginClones(office));

  return reported;
}

/**
 * Installs, updates, restores and removes the office's packages at the refs office.yaml pins, then
 * applies them: settings and template files, their mise tools (linked machine-wide where the
 * office manages the machine), plugin links and desktop panels. `office sync` and `office packages
 * update` both apply packages this way. Each change goes to `changes`.
 */
export async function syncPackages(office: Office, changes: { push: (...lines: string[]) => void }, stage: Stage = silentStage): Promise<boolean> {
  requirePluginDestination(office);
  const { packages, problems } = resolvePackages(office);

  if (problems.length) {
    changes.push(...problems.map(problem => `FAILED ${problem.message}`));

    return false;
  }

  const publication = beginReferencePublication(office);

  if (!publication.ok) {
    changes.push(...publication.errors.map(error => `FAILED ${error}; restore a readable generation, or verify installed Git pins before moving it aside and running office sync --packages`));

    return false;
  }

  const rejected = new Set<string>();
  const embedded = new Map<string, string>();

  for (const item of packages) {
    const services = join(item.dir, packageComposeFile);
    const before = existsSync(services) ? readFileSync(services, "utf8") : undefined;

    if (item.kind !== "local" && definitionFiles(item.dir).length > 1) {
      changes.push(`${relative(office.dir, item.dir)} has both office.ts and package.yaml; restoring from the selected ${item.kind} source`);
    }

    let copied: string[] = [];

    if (item.kind === "built-in") {
      const result = await installBuiltin(office, item.entry);
      embedded.set(item.entry.name, result.source);
      copied = result.changes;
    } else if (item.entry.source) {
      copied = fetchPackage(office, item.entry, item.entry.source, boundRevision(publication.value.previous, item.entry));
    }

    changes.push(...copied);

    if (copied.some(line => line.startsWith("FAILED"))) rejected.add(item.entry.name);

    // A pulled-in package's services run on this machine's Docker, so a new or changed file is worth seeing.
    const after = existsSync(services) ? readFileSync(services, "utf8") : undefined;

    if (after !== undefined && after !== before) {
      changes.push(`package ${item.entry.name} ${before === undefined ? "adds" : "changes"} ${relative(office.dir, services)}, services that run on this machine's Docker; review it, then office up${before === undefined ? "" : " --upgrade"} applies it`);
    }
  }

  let installed = installedPackages(office, rejected);

  if (!installed.unread.has("knowledge") && legacyPlugin(office, "knowledge")) {
    changes.push(...removeOldKnowledgePlugin(office));
    installed = installedPackages(office, rejected);
  }

  const plan = withPluginPlan(office, installed);
  changes.push(...plan.problems.map((problem) => `FAILED package ${problem.packages.join(", ")}: ${problem.message}`));
  const published = await collectReferences(office, packages, installed, changes, publication.value, rejected, embedded);

  if (needsEnvironmentOwners(office, installed)) {
    changes.push("FAILED the existing machine environment predates package ownership records; repair the unread packages and sync again before withdrawing packages or rewriting their machine setup");

    return published;
  }

  // .office/packages/ holds only what sync pulled in, so a folder no package wants goes. Its panel
  // stays on the app's machine, where other offices may use it.
  const removedPanels: string[] = [];

  for (const name of pulledFolders(office)) {
    if (installed.unread.has(name) || packages.some((item) => item.kind !== "local" && item.entry.name === name)) continue;

    if (existsSync(join(pulledDir(office, name), panelBundle))) removedPanels.push(name);

    changes.push(...removePackage(office, name));
  }

  const cron = collectJobs(office, { ...installed, problems: [] });

  if (!cron.ok) changes.push(...cron.errors.map((error) => `FAILED ${error}`));

  for (const item of installed.installed) changes.push(...installPackage(office, item));

  stage.detail("writing the packages' tools and linking skills and plugins");
  changes.push(...syncTools(office, installed.installed, [...installed.selected]));

  changes.push(...syncMachine(office, installed));
  changes.push(...linkPlugins(office, plan));
  changes.push(...installPanels(office, installed.installed, removedPanels));

  return published;
}

/**
 * Installs each package's desktop app panel on the machine the app runs on, and says how to remove
 * the panel of a package that left office.yaml. The app machine is looked up only when there is a
 * panel to handle; inside the container, or when it can't be reached, nothing is installed.
 */
function installPanels(office: Office, installed: InstalledPackage[], removed: string[]): string[] {
  const panels = installed.flatMap((item) => (item.panel === undefined ? [] : [{ name: item.entry.name, bundle: item.panel }]));

  if (panels.length === 0 && removed.length === 0) return [];

  const where = locate();
  const names = panels.map((panel) => panelId(panel.name)).join(", ");

  if (where.kind === "container") return panels.length === 0 ? [] : [`not installing panels (${names}) from the container: they install on the desktop app's machine, so run office sync on the host`];

  if (where.kind === "unreachable") return panels.length === 0 ? [] : [`not installing panels (${names}): ${where.reason}`];

  return [...panels.flatMap((panel) => installPanel(where.machine, office, panel)), ...removed.map((name) => removalNote(where.machine, name))];
}

/**
 * Keeps plugin clones out of the office's commits through the repository's local
 * .git/info/exclude, so no committed file needs a section the tool rewrites, and drops the line
 * of a plugin no longer declared.
 */
function excludePluginClones(office: Office): string[] {
  const exclude = join(office.dir, ".git/info/exclude");

  if (!existsSync(join(office.dir, ".git"))) return [];

  const lines = existsSync(exclude) ? readFileSync(exclude, "utf8").replace(/\n$/, "").split("\n") : [];
  // An interrupted or refused first plugin delivery can leave its staging folder in the root.
  const wanted = [...office.plugins.map((plugin) => `/.opencode/plugins/${plugin.name}/`), ...(office.plugins.length > 0 ? ["/.office-plugin-*/"] : [])];
  // Lines of the shape this writes, for a plugin no longer declared: left there, one would keep
  // a package plugin's link of the same name out of commits.
  const stale = lines.filter((line) => /^\/\.opencode\/plugins\/[^/]+\/$/.test(line) && !wanted.includes(line));
  const missing = wanted.filter((line) => !lines.includes(line));

  if (stale.length === 0 && missing.length === 0) return [];

  mkdirSync(join(exclude, ".."), { recursive: true });
  writeFileSync(exclude, `${[...lines.filter((line) => !stale.includes(line)), ...missing].join("\n")}\n`);

  return [...stale.map((line) => `stopped excluding ${line} from commits (.git/info/exclude)`), ...missing.map((line) => `excluded ${line} from commits (.git/info/exclude)`)];
}
