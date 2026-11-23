// Package plugin links and Git-cloned plugins at the office root, where every desk inherits them.
// Desk and repo plugin folders belong to their owners. Office's entries are recognized by their
// target (ownership.ts); nothing records which links Office made.
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { RenameError, renameNoReplace } from "../../src/no-replace.ts";
import { OfficeError, type Office } from "../../src/office.ts";
import type { InstalledPackages } from "../../src/layout.ts";
import { builtinSource, gitSelection, readRecord, sourceFile, type ResolvedPackage } from "../../src/packages.ts";
import { validateAssets, type AssetPaths } from "./assets.ts";
import { type Declaration, readDeclarations, writeDeclarations } from "./declarations.ts";
import { cloneFolder, entries, entry as entryAt, pluginFolder } from "./ownership.ts";

/** Sync owns entries in these directories, never the targets of a redirected parent. */
export function requirePluginDestination(office: Office) {
  for (const folder of [".opencode", pluginFolder, ".office", cloneFolder]) {
    const info = lstatSync(join(office.dir, folder), { throwIfNoEntry: false });

    if (info && !info.isDirectory()) throw new OfficeError(`cannot deliver plugins: ${folder} is not an office directory (refusing to follow or replace it)`);
  }
}

/** Each `plugins:` entry: its checkout in `.office/plugins/<name>`, linked as `.opencode/plugins/<name>`. */
export function pluginClones(office: Office) {
  return office.plugins.map(plugin => ({ ...plugin, kind: "plugin", dir: join(office.dir, cloneFolder, plugin.name), link: join(office.dir, pluginFolder, plugin.name) }));
}

/** The link text for a clone, from the root's `.opencode/plugins/`. */
export function cloneTarget(name: string) {
  return `../../${cloneFolder}/${name}`;
}

export function declarationBinding(item: ResolvedPackage) {
  if (item.kind !== "local" && !lstatSync(join(item.dir, sourceFile), { throwIfNoEntry: false })?.isFile()) return undefined;
  const record = item.kind === "local" ? undefined : readRecord(item.dir);
  let source: string = item.kind;

  if (item.kind === "remote") {
    const selected = item.entry.source;

    if (!selected || !record || !("repo" in record) || record.repo !== selected.repo || record.path !== selected.path || record.ref !== selected.ref) return undefined;
    source = `${gitSelection(selected)}:${record.commit}`;
  } else if (item.kind === "built-in") {
    if (!record || "repo" in record) return undefined;
    source = builtinSource(record.files);
  }

  return new Bun.CryptoHasher("sha256").update(JSON.stringify([source, item.entry.settings])).digest("hex");
}

/**
 * Each package's OpenCode plugin and panel. `collected` is what this run's gathering registered,
 * by package (sync and check); without it, the applied record of the last sync is observed, as
 * readers that run no package code do. A package registering neither has none: no folder is
 * looked for by name. `plugins` maps each package to the plugin directory to link, `panels` to its
 * desktop bundle.
 */
export function withPluginPlan(office: Office, installed: InstalledPackages, collected?: ReadonlyMap<string, AssetPaths>) {
  const plugins = new Map<string, string>();
  const panels = new Map<string, string>();
  const problems = [...installed.problems];
  const unread = new Set(installed.unread);
  const saved = collected ? undefined : readDeclarations(office);
  const declarations = new Map<string, Declaration>();

  for (const name of unread) {
    // Unknown source: withhold both outputs, never restore a previous declaration as new authority.
    declarations.set(name, { state: "unavailable" });
  }

  for (const item of installed.installed) {
    const { entry, dir } = item;
    let paths: AssetPaths;

    try {
      const old = saved?.get(entry.name);
      const fresh = collected?.get(entry.name);

      if (!fresh && !old) paths = {};
      else {
        declarations.set(entry.name, { state: "unavailable" });
        const binding = declarationBinding(item);

        if (!binding) throw new Error("package source has changed; sync its selected revision");

        if (fresh) paths = fresh;
        else if (old?.state !== "declared" || old.binding !== binding) throw new Error("no current successful OpenCode registration; run office sync --packages");
        else paths = old.paths;

        validateAssets(office.dir, dir, paths);
        declarations.set(entry.name, { state: "declared", binding, paths });
      }
    } catch (error) {
      unread.add(entry.name);
      problems.push({ packages: [entry.name], message: `OpenCode registration: ${error instanceof Error ? error.message : "failed"}` });
      continue;
    }

    if (paths.panel) panels.set(entry.name, join(dir, paths.panel));

    if (!paths.server) continue;
    const plugin = join(item.kind === "local" ? dir : join(office.dir, ".office/packages", entry.name), paths.server);
    const at = `${pluginFolder}/${entry.name}`;
    const existing = entryAt(office, entry.name);
    const taken = existing !== undefined && !existing.office;

    const problem = office.plugins.some(cloned => cloned.name === entry.name)
      ? `its plugin would be ${at}, where the plugins: entry ${entry.name} is cloned`
      : taken
        ? `its plugin would be ${at}, which holds a plugin of this office's own (not a link office sync made)`
        : undefined;

    if (problem === undefined) plugins.set(entry.name, plugin);
    else problems.push({ packages: [entry.name], message: `${problem}, so it isn't linked; rename one of them` });
  }

  return { ...installed, unread, plugins, panels, declarations, problems };
}

/**
 * What the root's plugin folder should hold for `plugins` (package name to plugin directory), and
 * Office's links there now. `withPluginPlan` already left out names the owner holds.
 */
export function pluginLinks(office: Office, plugins: Map<string, string>) {
  const folder = join(office.dir, pluginFolder);
  const wanted = new Map([...plugins].map(([name, dir]) => [name, relative(folder, dir)]));
  const links = new Map<string, string>();

  for (const item of entries(office)) {
    if (item.office && item.target !== undefined) links.set(item.name, item.target);
  }

  return { folder, wanted, links };
}

/** Office's staging folder, on the office's filesystem and never scanned by OpenCode. */
export const stagingFolder = ".office/tmp";

/**
 * Places the link `path` -> `target`. It is made in `.office/tmp/`, never as a dot-name in a folder
 * OpenCode scans, and renamed into place without replacement. `previous` is the target text of
 * Office's link there to remove first; the new link is made before that removal, so it is a new
 * entry, which OpenCode notices even when the text is the same. Where the filesystem can't rename
 * without replacing, the link is created in place, which also never replaces anything.
 */
export function placeLink(office: Office, path: string, target: string, previous?: string) {
  const at = relative(office.dir, path);
  const staging = join(office.dir, stagingFolder);
  mkdirSync(staging, { recursive: true });
  const staged = join(staging, `link-${randomUUID()}`);
  symlinkSync(target, staged);
  // What a failure leaves: either nothing changed, or Office's previous link is already gone.
  let outcome = "nothing there was replaced";

  try {
    if (previous !== undefined) {
      if (readlinkSync(path) !== previous) throw new OfficeError(`kept changed ${at}; retry sync after the edit`);
      unlinkSync(path);
      outcome = `Office's previous link (to ${previous}) was removed, and no entry of anyone else's was replaced; office sync links it again`;
    }

    mkdirSync(dirname(path), { recursive: true });

    try {
      renameNoReplace(staged, path);
    } catch (error) {
      if (!(error instanceof RenameError) || !["EINVAL", "ENOSYS"].includes(error.code)) throw new OfficeError(`could not place ${at}${error instanceof RenameError ? ` (${error.code})` : ""}; ${outcome}`);

      try {
        symlinkSync(target, path); // exclusive creation
      } catch {
        throw new OfficeError(`could not place ${at}${lstatSync(path, { throwIfNoEntry: false }) ? " (something else appeared there)" : ""}; ${outcome}`);
      }
    }
  } finally {
    rmSync(staged, { force: true });
  }
}

export function restartNotice(name: string) {
  return `restart OpenCode to pick up ${name}: a running server keeps loading a plugin from where it first found it`;
}

function unlinkPlugin(folder: string, name: string, target: string) {
  const path = join(folder, name);

  if (readlinkSync(path) !== target) throw new OfficeError(`kept changed ${pluginFolder}/${name}; retry sync after the edit`);
  unlinkSync(path);
}

/**
 * Makes the root's `.opencode/plugins/` hold a link for each package plugin, and no other Office
 * link except those of declared clones, which the clone step manages. An Office link whose package
 * is selected but unreadable stays. A name the owner holds is never replaced.
 */
export function linkPlugins(office: Office, installed: ReturnType<typeof withPluginPlan>): string[] {
  requirePluginDestination(office);

  for (const item of installed.installed) {
    const claim = installed.declarations.get(item.entry.name);

    if (claim?.state === "declared") validateAssets(office.dir, item.dir, claim.paths);
  }

  writeDeclarations(office, installed.declarations);
  const changes: string[] = [];
  const { folder, wanted, links } = pluginLinks(office, installed.plugins);
  const cloned = new Set(office.plugins.map(plugin => plugin.name));

  for (const [name, target] of links) {
    if (installed.unread.has(name) || wanted.has(name) || (cloned.has(name) && target === cloneTarget(name))) continue;
    unlinkPlugin(folder, name, target);
    changes.push(cloned.has(name) ? `unlinked ${pluginFolder}/${name} for the plugins: entry of that name; ${restartNotice(name)}` : `unlinked ${pluginFolder}/${name}`);
  }

  for (const [name, target] of wanted) {
    const current = links.get(name);

    if (current === target) continue;
    // A running server keeps the location it first resolved for a name: moving it needs a restart.
    placeLink(office, join(folder, name), target, current);
    changes.push(current === undefined ? `linked ${pluginFolder}/${name}` : `relinked ${pluginFolder}/${name} to ${target}; ${restartNotice(name)}`);
  }

  return changes;
}

