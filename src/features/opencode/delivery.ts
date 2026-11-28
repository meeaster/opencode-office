import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { excludeCopy, planCopy, stagingFolder } from "../../../sdk/copy-tree.ts";
import { RenameError, renameNoReplace } from "../../lib/no-replace.ts";
import { OfficeError, type Office } from "../../office.ts";
import type { InstalledPackages } from "../../loader/definitions/inventory.ts";
import { builtinSource, gitSelection, readRecord, sourceFile } from "../../loader/sources/copies.ts";
import type { ResolvedPackage } from "../../loader/sources/selection.ts";
import { validateAssets, type AssetPaths } from "./assets.ts";
import { type Declaration, readDeclarations, writeDeclarations } from "./declarations.ts";
import { pluginEntrypoints } from "./entrypoints.ts";
import { cloneFolder, entries, entry as entryAt, pluginFolder, readCopies, writeCopies } from "./ownership.ts";

export { stagingFolder };

/** Sync owns entries in these directories, never the targets of a redirected parent. */
export function requirePluginDestination(office: Office) {
  for (const folder of [".opencode", pluginFolder, ".office", cloneFolder, stagingFolder]) {
    const info = lstatSync(join(office.dir, folder), { throwIfNoEntry: false });

    if (info && !info.isDirectory()) throw new OfficeError(`cannot deliver plugins: ${folder} is not an office directory (refusing to follow or replace it)`);
  }
}

/** Each `plugins:` entry: its checkout in `.office/plugins/<name>`, linked as `.opencode/plugins/<name>`. */
export function pluginClones(office: Office) {
  return office.plugins.map(plugin => ({ ...plugin, kind: "plugin" as const, dir: join(office.dir, cloneFolder, plugin.name), link: join(office.dir, pluginFolder, plugin.name) }));
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

type Plugin = { kind: "copy"; source: string } | { kind: "link"; target: string };

/** Uses this run's registrations, or observes those of the last sync when no collection is available. */
export function withPluginPlan(office: Office, installed: InstalledPackages, collected?: ReadonlyMap<string, AssetPaths>) {
  const plugins = new Map<string, Plugin>();
  const panels = new Map<string, string>();
  const problems = [...installed.problems];
  let conflict = false;
  const unread = new Set(installed.unread);
  const saved = collected ? undefined : readDeclarations(office);
  const declarations = new Map<string, Declaration>();
  const copies = readCopies(office);

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
    const existing = entryAt(office, entry.name, copies);
    const taken = existing !== undefined && !existing.office;

    const problem = taken
      ? `its plugin would be ${at}, which holds a plugin of this office's own (no Office copy or link owns it)`
      : office.plugins.some(cloned => cloned.name === entry.name)
        ? `its plugin would be ${at}, where the plugins: entry ${entry.name} is cloned`
        : undefined;

    if (problem !== undefined) {
      const message = `${problem}, so it isn't delivered; rename one of them`;

      if (taken) conflict = true;
      problems.push({ packages: [entry.name], message });
    } else if (item.kind === "local") {
      plugins.set(entry.name, { kind: "link", target: relative(join(office.dir, pluginFolder), plugin) });
    } else {
      plugins.set(entry.name, { kind: "copy", source: plugin });
    }
  }

  return { ...installed, unread, plugins, panels, declarations, problems, conflict };
}

export function pluginProblem(office: Office, name: string, plugin: Plugin, copies: ReadonlySet<string>): string | undefined {
  const at = `${pluginFolder}/${name}`;
  const current = entryAt(office, name, copies);

  if (plugin.kind === "link") {
    if (current?.copied || current?.target !== plugin.target) return `${at} isn't linked to ${plugin.target}; office sync links it${current?.office && !current.copied && current.target !== undefined ? `; ${restartNotice(name)}` : ""}`;

    return;
  }

  if (!current?.copied) return `${at} is missing its Office copy; office sync copies it`;

  try {
    const { differences } = planCopy(plugin.source, join(office.dir, at));

    if (differences.length) return `${at} differs from the package's plugin (${differences.map(path => join(at, path)).join(", ")}); office sync restores it`;
  } catch (error) {
    return `${at}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

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

function unlinkPlugin(folder: string, name: string, target: string) {
  const path = join(folder, name);

  if (readlinkSync(path) !== target) throw new OfficeError(`kept changed ${pluginFolder}/${name}; retry sync after the edit`);
  unlinkSync(path);
}

function restartNotice(name: string) {
  return `restart OpenCode to pick up ${name}: it keeps the previous target of a moved plugin link`;
}

export function deliverPlugins(office: Office, installed: ReturnType<typeof withPluginPlan>, exclude: (path: string) => readonly string[]): string[] {
  requirePluginDestination(office);

  for (const item of installed.installed) {
    const claim = installed.declarations.get(item.entry.name);

    if (claim?.state === "declared") validateAssets(office.dir, item.dir, claim.paths);
  }

  const changes: string[] = [];
  const folder = join(office.dir, pluginFolder);
  const copies = readCopies(office);
  const current = new Map(entries(office, copies).map(item => [item.name, item]));
  const cloned = new Set(office.plugins.map(plugin => plugin.name));
  const plans = new Map<string, ReturnType<typeof planCopy>>();

  for (const [name, plugin] of installed.plugins) {
    if (plugin.kind === "copy") plans.set(name, planCopy(plugin.source, join(folder, name), pluginEntrypoints));
  }

  writeDeclarations(office, installed.declarations);

  for (const name of copies) {
    if (installed.unread.has(name) || plans.has(name)) continue;
    requirePluginDestination(office);
    rmSync(join(folder, name), { recursive: true, force: true });
    copies.delete(name);
    writeCopies(office, copies);
    current.delete(name);
    const transition = cloned.has(name) || installed.plugins.has(name);

    changes.push(`removed plugin copy ${pluginFolder}/${name}${transition ? `; restart OpenCode to pick up ${name} if it loaded the previous delivery` : ""}`);
  }

  for (const [name, item] of current) {
    if (!item.office || item.copied || item.target === undefined || installed.unread.has(name) || installed.plugins.has(name) || (cloned.has(name) && item.target === cloneTarget(name))) continue;
    unlinkPlugin(folder, name, item.target);
    changes.push(cloned.has(name) ? `unlinked ${pluginFolder}/${name} for the plugins: entry of that name; ${restartNotice(name)}` : `unlinked ${pluginFolder}/${name}`);
  }

  for (const [name, plugin] of installed.plugins) {
    const at = `${pluginFolder}/${name}`;
    const target = current.get(name)?.target;

    if (plugin.kind === "link") {
      if (target === plugin.target) continue;
      placeLink(office, join(folder, name), plugin.target, target);
      changes.push(target === undefined ? `linked ${at}` : `relinked ${at} to ${plugin.target}; ${restartNotice(name)}`);
      continue;
    }

    const plan = plans.get(name);

    if (!plan?.differences.length) continue;

    const recorded = copies.has(name);
    const existing = entryAt(office, name, copies);

    if (!recorded && (target === undefined ? existing !== undefined : existing?.target !== target)) throw new OfficeError(`kept changed ${at}; retry sync after the edit`);
    changes.push(...excludeCopy(office.dir, at, exclude));

    if (!recorded) {
      copies.add(name);
      writeCopies(office, copies);
    }

    plan.write(office.dir);
    changes.push(`copied plugin ${at}`);
  }

  return changes;
}
