// `office sync`: makes the office's folders match office.yaml and the tool. It clones and updates,
// moves an office from an earlier release's layout (src/migrate.ts), scaffolds desks that are
// declared but missing, copies declared skills into the library, installs, updates, restores and
// removes packages, writes the mise tools packages declare into the office's .office/mise/
// (src/package-tools.ts) and, in a host-mode office the user agreed may manage its machine, links
// them and machine.toml into mise's global conf.d (src/machine.ts), links enabled library skills and package plugins,
// and installs package panels on the desktop app's machine. A package's skills aren't linked: its plugin registers them, so sync
// removes the links earlier releases made.
// It never rewrites AGENTS.md, other hand-written content, an existing app or a file a package's
// template created; it deletes such a file only with its package, and only while unchanged.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { installPanel, locate, panelBundle, panelId, removalNote } from "../desktop.ts";
import { syncMachine } from "../machine.ts";
import { cloneOrFetch, cloneShallow, copyFromRepository, isClone, refreshClone } from "../git.ts";
import { clones, installedPackages, oldKnowledgePlugin, packageLink, pluginLinks, skillSelections } from "../layout.ts";
import { migrate } from "../migrate.ts";
import { packageComposeFile } from "../package-services.ts";
import { syncTools } from "../package-tools.ts";
import type { CopiedSkill, Desk, Office } from "../office.ts";
import { fetchPackage, installBuiltin, type InstalledPackage, installPackage, pulledDir, pulledFolders, removePackage, resolvePackages, sourceFile } from "../packages.ts";
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
  const appPath = join("executor/apps", desk.name);
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

      cpSync(join(office.dir, "executor/apps/opencode", file), copy);
      written.push(copy);
    }
  }

  return written;
}

/**
 * Copies one skill folder of a git repository at a ref into `to` and records where it came from
 * in `.source.json`, so a later check can compare the copied commit with upstream.
 */
function copySkill(skill: CopiedSkill, to: string): string {
  const commit = copyFromRepository(skill, to, "SKILL.md");

  writeFileSync(join(to, sourceFile), `${JSON.stringify({ repo: skill.repo, ref: skill.ref ?? null, path: skill.path, commit, copied: new Date().toISOString() }, null, 2)}\n`);

  return commit;
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

/** Makes `.opencode/plugins/` hold a relative link to each declared package's plugin, and no other link to a package plugin. */
function linkPlugins(office: Office): string[] {
  const { folder, wanted, links } = pluginLinks(office);
  const changes: string[] = [];

  for (const [name, target] of links) {
    if (wanted.get(name) === target) continue;

    unlinkSync(join(folder, name));
    changes.push(`unlinked .opencode/plugins/${name}`);
  }

  for (const [name, target] of wanted) {
    if (links.get(name) === target) continue;

    mkdirSync(folder, { recursive: true });
    symlinkSync(target, join(folder, name));
    changes.push(`linked .opencode/plugins/${name}`);
  }

  return changes;
}

/**
 * Removes the knowledge plugin an earlier `office` wrote into each office, which the knowledge
 * package replaced; without that package declared, it says which entry keeps the listing.
 */
function removeOldKnowledgePlugin(office: Office): string[] {
  if (!oldKnowledgePlugin(office)) return [];

  rmSync(join(office.dir, ".opencode/plugins/knowledge"), { recursive: true });

  const removed = "removed .opencode/plugins/knowledge/, the knowledge plugin earlier releases of office wrote";

  if (office.packages.some((entry) => entry.name === "knowledge")) return [`${removed}; the knowledge package's plugin replaces it`];

  return [`${removed}. Sessions no longer list knowledge/ articles; to keep that, add \`- name: knowledge\` under packages: in office.yaml and run office sync again`];
}

/** Runs the sync and returns one line per change. With `referencesOnly`, it only updates references. */
export async function sync(loaded: Office, { referencesOnly = false } = {}): Promise<string[]> {
  let office = loaded;
  const changes: string[] = [];

  for (const clone of clones(office)) {
    if (referencesOnly && clone.kind !== "reference") continue;

    const where = relative(office.dir, clone.dir);

    // A package plugin's link can stand where a plugins: entry of the same name is cloned; the
    // entry wins, so git never runs through the link in the office's own repository.
    if (clone.kind === "plugin" && packageLink(clone.dir) !== undefined) unlinkSync(clone.dir);

    try {
      const result =
        clone.kind === "reference" || clone.kind === "plugin"
          ? isClone(clone.dir)
            ? refreshClone(clone.ref, clone.dir)
            : cloneShallow(clone.url, clone.ref, clone.dir)
          : cloneOrFetch(clone.url, clone.ref, clone.dir);

      if (result !== "current" && result !== "fetched") changes.push(`${result} ${clone.kind} ${where}`);
    } catch (error) {
      changes.push(`FAILED ${clone.kind} ${where}: ${error instanceof Error ? error.message.trim() : String(error)}`);
    }
  }

  if (referencesOnly) return changes;

  const migrated = migrate(office);

  office = migrated.office;
  changes.push(...migrated.changes);

  for (const desk of office.desks) {
    for (const path of scaffoldDesk(office, desk)) changes.push(`created ${relative(office.dir, path)}`);
  }

  for (const skill of office.skills.copied) {
    const to = join(office.dir, "skills", skill.name);

    if (existsSync(to)) continue;

    try {
      const commit = copySkill(skill, to);

      changes.push(`copied skills/${skill.name} from ${skill.repo} at ${commit}`);
    } catch (error) {
      changes.push(`FAILED to copy skills/${skill.name}: ${error instanceof Error ? error.message.trim() : String(error)}`);
    }
  }

  const { packages } = resolvePackages(office);

  for (const item of packages) {
    const services = join(item.dir, packageComposeFile);
    const before = existsSync(services) ? readFileSync(services, "utf8") : undefined;

    if (item.kind === "built-in") changes.push(...(await installBuiltin(office, item.entry.name)));
    else if (item.kind === "remote" && item.entry.source !== undefined) changes.push(...fetchPackage(office, item.entry.name, item.entry.source));

    // A pulled-in package's services run on this machine's Docker, so a new or changed file is worth seeing.
    const after = existsSync(services) ? readFileSync(services, "utf8") : undefined;

    if (after !== undefined && after !== before) {
      changes.push(`package ${item.entry.name} ${before === undefined ? "adds" : "changes"} ${relative(office.dir, services)}, services that run on this machine's Docker; review it, then office up${before === undefined ? "" : " --upgrade"} applies it`);
    }
  }

  // .office/packages/ holds only what sync pulled in, so a folder no package wants goes. Its panel
  // stays on the app's machine, where other offices may use it.
  const removedPanels: string[] = [];

  for (const name of pulledFolders(office)) {
    if (packages.some((item) => item.kind !== "local" && item.entry.name === name)) continue;

    if (existsSync(join(pulledDir(office, name), panelBundle))) removedPanels.push(name);

    changes.push(...removePackage(office, name));
  }

  changes.push(...removeOldKnowledgePlugin(office));

  const installed = installedPackages(office);

  changes.push(...installed.problems.map((problem) => `FAILED package ${problem.packages.join(", ")}: ${problem.message}`));

  for (const item of installed.installed) changes.push(...installPackage(office, item));

  changes.push(...syncTools(office, installed.installed, packages.map((item) => item.entry.name)));
  changes.push(...syncMachine(office));

  changes.push(...linkSkills(office));
  changes.push(...linkPlugins(office));
  changes.push(...excludePluginClones(office));
  changes.push(...installPanels(office, installed.installed, removedPanels));

  return changes;
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
  const wanted = office.plugins.map((plugin) => `/.opencode/plugins/${plugin.name}/`);
  // Lines of the shape this writes, for a plugin no longer declared: left there, one would keep
  // a package plugin's link of the same name out of commits.
  const stale = lines.filter((line) => /^\/\.opencode\/plugins\/[^/]+\/$/.test(line) && !wanted.includes(line));
  const missing = wanted.filter((line) => !lines.includes(line));

  if (stale.length === 0 && missing.length === 0) return [];

  mkdirSync(join(exclude, ".."), { recursive: true });
  writeFileSync(exclude, `${[...lines.filter((line) => !stale.includes(line)), ...missing].join("\n")}\n`);

  return [...stale.map((line) => `stopped excluding ${line} from commits (.git/info/exclude)`), ...missing.map((line) => `excluded ${line} from commits (.git/info/exclude)`)];
}
