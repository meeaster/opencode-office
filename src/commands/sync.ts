// `office sync`: makes the office's folders match office.yaml and the tool. It clones and updates,
// moves an office from an earlier release's layout (src/migrate.ts), scaffolds desks that are
// declared but missing, copies declared skills into the library, installs, updates, restores and
// removes packages, writes the mise tools packages declare into machine.packages.toml and their
// setup into .office/mise/ (src/package-tools.ts) and, in a host-mode office the user agreed may
// manage its machine, links them and machine.toml into mise's global conf.d (src/machine.ts), links enabled library skills and package plugins,
// and installs package panels on the desktop app's machine. A package's skills aren't linked: its plugin registers them, so sync
// removes the links earlier releases made. Office's links are recognized by their target
// (standard/opencode/ownership.ts) and kept out of commits through the repository's info/exclude.
// It never rewrites AGENTS.md, other hand-written content, an existing app or a file a package's
// template created; it deletes such a file only with its package, and only while unchanged.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import { prepareReferenceRefresh } from "../../packages/references/tasks/refresh.ts";
import { claudeFiles } from "../claude.ts";
import { boundRevision, collectReferences } from "../collect-references.ts";
import { beginReferencePublication, planReferenceApply } from "../reference-publication.ts";
import { preserveV3Owner } from "../v3-reference-owner.ts";
import { installPanel, locate, panelBundle, panelId, removalNote } from "../desktop.ts";
import { collectJobs } from "../../standard/cron/jobs.ts";
import { needsEnvironmentOwners, syncMachine } from "../machine.ts";
import { cloneOrFetchStreamed, clonePluginStreamed, existingPluginDestination, git, isClone, PluginCheckoutProblem, referenceGit, referenceOriginProblem, refreshCloneStreamed, verifiedHead } from "../git.ts";
import { type Clone, clones, installedPackages, skillSelections } from "../layout.ts";
import { cloneTarget, legacyPlugin, linkPlugins, placeLink, pluginFolder, pluginScope, requirePluginDestination, stagingFolder, withPluginPlan } from "../../standard/opencode/delivery.ts";
import { validateAssets } from "../../standard/opencode/assets.ts";
import { type Declaration, readDeclarations } from "../../standard/opencode/declarations.ts";
import { cloneFolder, entry as entryAt, officeEntries, requireFolder } from "../../standard/opencode/ownership.ts";
import { RenameError, renameNoReplace } from "../no-replace.ts";
import { migrate } from "../migrate.ts";
import { atomicWrite } from "../secrets.ts";
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

/**
 * Makes each .opencode/skills/ hold exactly the enabled library skills as relative links, among
 * Office's links. An entry of the office's own with an enabled skill's name stays instead.
 */
function linkSkills(office: Office): string[] {
  const changes: string[] = [];

  for (const selection of skillSelections(office)) {
    requireFolder(selection.scope);

    for (const [entry, target] of selection.links) {
      if (selection.enabled.includes(entry) && target === selection.target(entry)) continue;

      unlinkSync(join(selection.folder, entry));
      changes.push(`unlinked ${relative(office.dir, join(selection.folder, entry))}`);
    }

    for (const skill of selection.enabled) {
      const path = join(selection.folder, skill);

      if (selection.own.includes(skill)) {
        changes.push(`kept the office's own ${relative(office.dir, path)} instead of linking ${relative(office.dir, join(selection.folder, selection.target(skill)))}`);
      } else if (!existsSync(join(office.dir, "skills", skill))) {
        changes.push(`not linked: skills/${skill} is missing from the library`);
      } else if (selection.links.get(skill) !== selection.target(skill)) {
        mkdirSync(selection.folder, { recursive: true });
        symlinkSync(selection.target(skill), path); // exclusive creation; never replace an occupied path
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

type LinkClaim = {
  /** Office's link to this clone was already there. */
  linked: boolean;
  /** What moved from where earlier releases cloned. */
  moved: string[];
};

/**
 * Readies `.opencode/plugins/<name>` for a clone: free, or already Office's link to it. An earlier
 * release cloned into that path; such a checkout moves to `.office/plugins/<name>` when Office can
 * verify it is this plugin's (moving first, then linking, is safe while OpenCode runs). Returns
 * whether the link was there, and what moved.
 */
function claimPluginLink(office: Office, clone: Clone): LinkClaim {
  const at = `${pluginFolder}/${clone.name}`;
  const existing = entryAt(pluginScope(office), clone.name);

  if (!existing) {
    // A present, verified checkout is linked before fetching: a fetch that fails (offline, auth)
    // must not leave it unlinked, and OpenCode then keeps loading it. A first clone is linked after
    // publication instead (linkClone).
    if (!isClone(clone.dir) || !verifiedCheckout(office, clone.dir, clone.url)) return { linked: false, moved: [] };

    return { linked: true, moved: linkPresent(office, clone) };
  }

  if (existing.office && existing.target === cloneTarget(clone.name)) return { linked: true, moved: [] };

  if (existing.office) throw new PluginCheckoutProblem(`${at} links to a package's plugin; a package and a plugins: entry can't share a name, so rename one of them`);

  if (!existing.folder || existing.target !== undefined) throw new PluginCheckoutProblem(`${at} is the office's own (not a link office sync made), kept; move it aside or rename the plugins: entry`);
  const legacy = join(office.dir, at);

  if (!verifiedCheckout(office, legacy, clone.url)) {
    throw new PluginCheckoutProblem(`${at} is a folder office sync can't verify as this plugin's checkout (its origin, location and a commit); left unchanged. If an earlier release cloned it, check it and move it to ${cloneFolder}/${clone.name} yourself; otherwise rename one of them`);
  }

  if (lstatSync(clone.dir, { throwIfNoEntry: false })) throw new PluginCheckoutProblem(`both ${at} and ${cloneFolder}/${clone.name} exist; left unchanged. Remove the one you don't need`);
  mkdirSync(join(office.dir, cloneFolder), { recursive: true });

  try {
    renameNoReplace(legacy, clone.dir);
  } catch (error) {
    throw new PluginCheckoutProblem(`could not move ${at} to ${cloneFolder}/${clone.name} (${error instanceof RenameError ? error.code : "unavailable"}); left unchanged`);
  }

  // Linked at once, so a fetch that fails afterwards can't leave the moved plugin unloaded.
  return { linked: true, moved: [`moved the checkout ${at} to ${cloneFolder}/${clone.name}`, ...linkPresent(office, clone)] };
}

/** Whether `dir` is provably this plugin's checkout, with a commit. */
function verifiedCheckout(office: Office, dir: string, url: string): boolean {
  try {
    requirePluginCheckout(office, dir, url);

    return verifiedHead(dir) !== undefined;
  } catch {
    return false;
  }
}

/** Links an existing checkout where nothing is at `.opencode/plugins/<name>`. */
function linkPresent(office: Office, clone: Clone): string[] {
  const at = `${pluginFolder}/${clone.name}`;

  placeLink(office, join(office.dir, at), cloneTarget(clone.name));

  return [`linked ${at}`];
}

/**
 * Links `.opencode/plugins/<name>` to the clone, after it is published: OpenCode doesn't notice a
 * checkout that appears behind an existing link, so a link that was there first is made again.
 */
function linkClone(office: Office, clone: Clone, remake: boolean): string[] {
  const at = `${pluginFolder}/${clone.name}`;
  const target = cloneTarget(clone.name);
  const existing = entryAt(pluginScope(office), clone.name);

  if (existing && !(existing.office && existing.target === target)) throw new PluginCheckoutProblem(`${at} changed during delivery; kept, and the clone is not linked`);

  if (existing && !remake) return [];
  placeLink(office, join(office.dir, at), target, existing ? target : undefined);

  return [`${existing ? "relinked" : "linked"} ${at}`];
}

async function syncPlugin(office: Office, clone: Clone, present: boolean, linked: boolean) {
  requirePluginDestination(office);

  if (isClone(clone.dir) !== present) throw new Error("plugin checkout changed; retry sync");
  const verify = () => requirePluginCheckout(office, clone.dir, clone.url);
  let result: "cloned" | "updated" | "current";

  try {
    if (!present) {
      // Even an empty folder is the owner's: publication would replace it and its metadata.
      if (lstatSync(clone.dir, { throwIfNoEntry: false })) throw new PluginCheckoutProblem(existingPluginDestination);

      // Staging shares the filesystem of .office/plugins/, so publication is one rename.
      const staging = join(office.dir, stagingFolder);
      mkdirSync(staging, { recursive: true });
      result = await clonePluginStreamed(clone.url, clone.ref, clone.dir, staging, verify);
    } else {
      try {
        verify();
      } catch (error) {
        if (!(error instanceof PluginCheckoutProblem)) throw error;

        // Such as a withdrawn clone whose name is selected again with another repository.
        throw new PluginCheckoutProblem(`${error.message}. If ${cloneFolder}/${clone.name} is an earlier checkout of another repository, move it aside (or remove it) and sync again`);
      }

      // A checkout with no commit (such as one a failed clone left) would be filled in place, where
      // OpenCode already looks. Refuse it before fetching rather than adopt it.
      if (!verifiedHead(clone.dir)) throw new PluginCheckoutProblem(`existing plugin checkout has no commit; left unchanged. Move it aside so office sync can clone a fresh copy, then sync again. If an interrupted first sync left it, see "Recovering an interrupted first clone" in docs/opencode-sources.md`);

      result = await refreshCloneStreamed(clone.ref, clone.dir, {}, verify);
    }
  } catch (error) {
    // Raw Git output (including verbose progress) can contain credentialed URLs.
    if (error instanceof PluginCheckoutProblem) throw error;

    throw new Error("plugin Git operation failed; check the checkout, configured repository and ref");
  }

  return { result, notes: linkClone(office, clone, linked && result === "cloned") };
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

  // A clone's result shows as its part; other changes it makes show as notes.
  const noted = (index: number, notes: string[]) => {
    for (const note of notes) stage.note(note);
    lines[index].push(...notes);
  };

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
      let claim: LinkClaim = { linked: false, moved: [] };

      if (clone.kind === "plugin") {
        requirePluginDestination(office);

        if (lstatSync(clone.dir, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("existing symlink kept; move it aside yourself before cloning here");
        claim = claimPluginLink(office, clone);
        noted(index, claim.moved);
      }

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
          let notes: string[] = [];

          if (refresh) result = await refresh(options);
          else if (clone.kind === "plugin") ({ result, notes } = await syncPlugin(office, clone, present, claim.linked));
          else result = await cloneOrFetchStreamed(clone.url, clone.ref, clone.dir, options);
          part.done(result);

          if (result !== "current" && result !== "fetched") lines[index].push(`${result} ${clone.kind} ${where}`);
          noted(index, notes);
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

  // info/exclude is written once, after skills are linked too.
  const published = await syncPackages(office, changes, stage, false);
  reported.push(...await syncClones(office, published ? "all" : "others", stage, verbose));
  changes.push(...claudeFiles(office.dir, true));
  changes.push(...linkSkills(office));
  changes.push(...excludePlumbing(office));

  return reported;
}

/**
 * Installs, updates, restores and removes the office's packages at the refs office.yaml pins, then
 * applies them: settings and template files, their mise tools (linked machine-wide where the
 * office manages the machine), plugin links and desktop panels. `office sync` and `office packages
 * update` both apply packages this way. Each change goes to `changes`.
 */
export async function syncPackages(office: Office, changes: { push: (...lines: string[]) => void }, stage: Stage = silentStage, exclude = true): Promise<boolean> {
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
  using migration = preserveV3Owner(office, publication.value.previous);

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
      copied = await fetchPackage(office, item.entry, item.entry.source, boundRevision(publication.value.previous, item.entry));
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

  changes.push(...installed.problems.map((problem) => `FAILED package ${problem.packages.join(", ")}: ${problem.message}`));
  const published = await collectReferences(office, packages, installed, changes, publication.value, rejected, embedded);

  if (!published && migration) return false;
  migration?.commit();

  if (needsEnvironmentOwners(office, installed)) {
    changes.push("FAILED the existing machine environment predates package ownership records; repair the unread packages and sync again before withdrawing packages or rewriting their machine setup");

    return published;
  }

  // .office/packages/ holds only what sync pulled in, so a folder no package wants goes. Its panel
  // stays on the app's machine, where other offices may use it.
  const removedPanels: string[] = [];
  let declarations: Map<string, Declaration> | undefined;

  for (const name of pulledFolders(office)) {
    if (installed.unread.has(name) || packages.some((item) => item.kind !== "local" && item.entry.name === name)) continue;

    // The last synced authored registration names the bundle; without one, the convention does.
    const claim = (declarations ??= readDeclarations(office)).get(name);
    const bundle = claim?.state === "declared" ? claim.paths.panel : panelBundle;

    if (bundle !== undefined && existsSync(join(pulledDir(office, name), bundle))) removedPanels.push(name);

    changes.push(...removePackage(office, name));
  }

  // Executable cron owners were validated with their other contributions before publication.
  const cron = collectJobs(office, { installed: installed.installed.filter(pkg => !pkg.manifest.registerCron), problems: [] });

  if (!cron.ok) changes.push(...cron.errors.map((error) => `FAILED ${error}`));

  for (const item of installed.installed) changes.push(...installPackage(office, item));

  stage.detail("writing the packages' tools and linking skills and plugins");
  changes.push(...syncTools(office, installed.installed, [...installed.selected]));

  changes.push(...syncMachine(office, installed));
  const plan = withPluginPlan(office, { ...installed, problems: [] }, "collect");
  changes.push(...plan.problems.map((problem) => `FAILED package ${problem.packages.join(", ")}: ${problem.message}`));
  changes.push(...linkPlugins(office, plan));
  changes.push(...installPanels(office, plan.installed, removedPanels));

  if (exclude) changes.push(...excludePlumbing(office));

  return published;
}

/**
 * Installs each package's desktop app panel on the machine the app runs on, and says how to remove
 * the panel of a package that left office.yaml. The app machine is looked up only when there is a
 * panel to handle; inside the container, or when it can't be reached, nothing is installed.
 */
function installPanels(office: Office, installed: InstalledPackage[], removed: string[]): string[] {
  const panels = installed.flatMap((item) => {
    if (!item.panel) return [];

    if (item.manifest.opencode) validateAssets(office.dir, item.dir, { panel: relative(item.dir, item.panel) });

    return [{ name: item.entry.name, bundle: item.panel }];
  });

  if (panels.length === 0 && removed.length === 0) return [];

  const where = locate();
  const names = panels.map((panel) => panelId(panel.name)).join(", ");

  if (where.kind === "container") return panels.length === 0 ? [] : [`not installing panels (${names}) from the container: they install on the desktop app's machine, so run office sync on the host`];

  if (where.kind === "unreachable") return panels.length === 0 ? [] : [`not installing panels (${names}): ${where.reason}`];

  return [...panels.flatMap((panel) => installPanel(where.machine, office, panel)), ...removed.map((name) => removalNote(where.machine, name))];
}

export const excludeStart = "# office sync: its plumbing, rewritten on each sync. Add your own lines outside this block.";
export const excludeEnd = "# end of office sync";

/**
 * Keeps Office's plumbing out of commits without touching the owner's .gitignore: one block in the
 * repository's info/exclude naming `.office/` (packages, clones, staging and generated state) and
 * each Office link, with a leading slash and no trailing one so a link matches. Lines outside the
 * block are the owner's and stay, byte for byte, CRLF endings included. An office that isn't a Git
 * repository's root gets nothing.
 *
 * A file whose markers don't form exactly one block is left alone and reported: guessing where an
 * unterminated block ends could delete the owner's lines. The file is replaced whole by rename, from
 * a read made just before, so a reader (Git, or another sync) never sees it truncated. Two syncs
 * writing at once each keep every owner line they read, and the last rename wins; only an owner
 * edit made within that moment, between a sync's read and its rename, can be overwritten.
 */
export function excludePlumbing(office: Office): string[] {
  if (!existsSync(join(office.dir, ".git"))) return [];

  let exclude: string;

  try {
    // In a worktree office .git is a file; Git names the exclude file the worktrees share.
    exclude = resolve(office.dir, git(["rev-parse", "--git-path", "info/exclude"], office.dir));
  } catch {
    return ["could not locate the office repository's info/exclude; Office's plumbing is not excluded from commits"];
  }

  const wanted = ["/.office/", ...officeEntries(office).map((path) => `/${path}`)];
  // Lines earlier releases wrote one by one: a declared clone in `.opencode/plugins/<name>/` and first-clone staging.
  const legacy = new Set(["/.office-plugin-*/", ...office.plugins.map((plugin) => `/${pluginFolder}/${plugin.name}/`)]);

  if (existsSync(exclude)) exclude = realpathSync(exclude);
  const text = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  const raw = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const lines = raw.map((line) => line.replace(/\r$/, ""));
  const starts = lines.flatMap((line, index) => (line === excludeStart ? [index] : []));
  const ends = lines.flatMap((line, index) => (line === excludeEnd ? [index] : []));

  if (starts.length > 1 || ends.length !== starts.length || (starts.length === 1 && ends[0] < starts[0])) {
    const at = relative(office.dir, exclude).startsWith("..") ? exclude : relative(office.dir, exclude);

    return [`FAILED ${at} has ${starts.length} "${excludeStart}" and ${ends.length} "${excludeEnd}" lines, not one block; left unchanged, so Office's plumbing may not be excluded from commits. Delete the stray marker lines (or the whole block, which office sync writes again), keeping your own lines, then sync again`];
  }

  // The block stays where it is; a file without one gets it at the end.
  const [start, end] = starts.length === 1 ? [starts[0], ends[0]] : [raw.length, raw.length - 1];
  const block = lines.slice(start + 1, end);
  const kept = (part: string[]) => part.filter((line) => !legacy.has(line.replace(/\r$/, "")));
  const [before, after] = [raw.slice(0, start), raw.slice(end + 1)];
  // Office's lines take the file's line ending: CRLF when all of its lines have one.
  const cr = text.includes("\r\n") && !/(^|[^\r])\n/.test(text) ? "\r" : "";
  const next = `${[...kept(before), ...[excludeStart, ...wanted, excludeEnd].map((line) => line + cr), ...kept(after)].join("\n")}\n`;

  if (next === text) return [];

  atomicWrite(exclude, next, 0o644);

  const dropped = before.length + after.length - kept(before).length - kept(after).length;
  const added = wanted.filter((line) => !block.includes(line));
  const removed = block.filter((line) => !wanted.includes(line));

  return [
    ...added.map((line) => `excluded ${line} from commits (info/exclude)`),
    ...removed.map((line) => `stopped excluding ${line} from commits (info/exclude)`),
    ...(dropped > 0 ? [`replaced ${dropped} plugin exclude ${dropped === 1 ? "line" : "lines"} earlier releases wrote with the office sync block (info/exclude)`] : []),
  ];
}
