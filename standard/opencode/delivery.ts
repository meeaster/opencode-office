// Only office-wide package links and separately declared Git clones are managed here.
// Desk and repo plugin directories belong to their owners.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { OfficeError, type Office } from "../../src/office.ts";
import type { InstalledPackages } from "../../src/layout.ts";
import { builtinSource, gitSelection, readRecord, sourceFile, type ResolvedPackage } from "../../src/packages.ts";
import { collectAssets, packageTarget, validateAssets, type AssetPaths } from "./assets.ts";
import { type Declaration, linkIdentity, readDeclarations, readReceipts, reconcileReceipts } from "./receipts.ts";

export const pluginFolder = ".opencode/plugins";

/** Sync owns entries in these directories, never the targets of a redirected parent. */
export function requirePluginDestination(office: Office) {
  for (const folder of [".opencode", pluginFolder]) {
    const info = lstatSync(join(office.dir, folder), { throwIfNoEntry: false });

    if (info && !info.isDirectory()) throw new OfficeError(`cannot deliver plugins: ${folder} is not an office directory (refusing to follow or replace it)`);
  }
}

export function pluginClones(office: Office) {
  return office.plugins.map(plugin => ({ ...plugin, kind: "plugin", dir: join(office.dir, pluginFolder, plugin.name) }));
}

/** Historical, committed link convention. A prefix match would also claim owner aliases. */
export function packageLink(path: string): string | undefined {
  const name = basename(path);

  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return undefined;

  const info = lstatSync(path, { throwIfNoEntry: false });

  if (!info?.isSymbolicLink()) return undefined;

  const target = readlinkSync(path);

  return target === `../../packages/${name}/plugin` || target === `../../.office/packages/${name}/plugin` ? target : undefined;
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

export function withPluginPlan(office: Office, installed: InstalledPackages, mode: "observe" | "collect" = "observe") {
  const plugins = new Map<string, string>();
  const problems = [...installed.problems];
  const unread = new Set(installed.unread);
  const saved = mode === "observe" ? readDeclarations(office) : undefined;
  const declarations = new Map<string, Declaration>();
  const projected = [];

  for (const name of unread) {
    // Unknown source: withhold both outputs, never restore a previous declaration as new authority.
    declarations.set(name, { state: "unavailable" });
  }

  for (const item of installed.installed) {
    const { entry, dir } = item;
    let paths: AssetPaths;

    try {
      if (!item.manifest.opencode) paths = collectAssets(office.dir, item);
      else {
        declarations.set(entry.name, { state: "unavailable" });
        const binding = declarationBinding(item);

        if (!binding) throw new Error("package source has changed; sync its selected revision");

        if (mode === "collect") paths = collectAssets(office.dir, item);
        else {
          const old = saved?.get(entry.name);

          if (old?.state !== "declared" || old.binding !== binding) throw new Error("no current successful OpenCode registration; run office sync --packages");
          validateAssets(office.dir, dir, old.paths);
          paths = old.paths;
        }

        declarations.set(entry.name, { state: "declared", binding, paths });
      }
    } catch (error) {
      unread.add(entry.name);
      problems.push({ packages: [entry.name], message: `OpenCode registration: ${error instanceof Error ? error.message : "failed"}` });
      projected.push({ ...item, plugin: false, panel: undefined });
      continue;
    }

    projected.push({ ...item, plugin: !!paths.server, panel: paths.panel && join(dir, paths.panel) });

    if (!paths.server) continue;
    const plugin = join(dir, paths.server);
    const at = `${pluginFolder}/${entry.name}`;
    const path = join(office.dir, at);
    const info = lstatSync(path, { throwIfNoEntry: false });
    const target = info?.isSymbolicLink() ? readlinkSync(path) : undefined;
    // Plausible package targets go to receipt reconciliation; spelling never authorizes unlink.
    const taken = info && !(target && packageTarget(entry.name, target));

    const problem = office.plugins.some(cloned => cloned.name === entry.name)
      ? `its plugin would be ${at}, where the plugins: entry ${entry.name} is cloned`
      : taken && entry.name === "office" && legacyPlugin(office, "office")
        ? `its plugin would be ${at}, where earlier releases of office copied the tool's plugin; office sync replaces that copy with the link`
        : taken
          ? `its plugin would be ${at}, which holds a plugin of this office's own (not a link office sync made)`
          : undefined;

    if (problem === undefined) plugins.set(entry.name, plugin);
    else problems.push({ packages: [entry.name], message: `${problem}, so it isn't linked; rename one of them` });
  }

  return { ...installed, installed: projected, unread, plugins, declarations, problems };
}

export const unownedLink = "no matching Office creation receipt; kept. To authorize delivery, move the existing entry aside yourself and run office sync --packages";

export function ownsLink(office: Office, name: string, target: string, receipts: ReturnType<typeof readReceipts>) {
  const record = receipts.get(name);
  const path = `${pluginFolder}/${name}`;

  return record?.path === path && record.target === target && record.identity === linkIdentity(join(office.dir, path));
}

export function pluginLinks(office: Office, plugins: Map<string, string>, recorded = readReceipts(office)) {
  const folder = join(office.dir, pluginFolder);
  const wanted = new Map([...plugins].map(([name, dir]) => [name, relative(folder, dir)]));
  const links = new Map<string, string>();
  const unrecorded = new Set<string>();

  for (const name of existsSync(folder) ? readdirSync(folder) : []) {
    const path = join(folder, name);
    const target = lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ? readlinkSync(path) : undefined;

    if (target === undefined) continue;

    if (ownsLink(office, name, target, recorded)) links.set(name, target);
    else if (packageLink(path) || (wanted.has(name) && packageTarget(name, target))) unrecorded.add(name);
  }

  return { folder, wanted, links, unrecorded };
}

export function linkPlugins(office: Office, installed: ReturnType<typeof withPluginPlan>): string[] {
  requirePluginDestination(office);

  return reconcileReceipts(office, installed.declarations, (recorded, created, forget) => {
    for (const item of installed.installed) {
      const claim = installed.declarations.get(item.entry.name);

      if (claim?.state === "declared") validateAssets(office.dir, item.dir, claim.paths);
    }

    const { folder, wanted, links, unrecorded } = pluginLinks(office, installed.plugins, recorded);
    const changes: string[] = [];

    for (const name of unrecorded) {
      const different = wanted.has(name) && wanted.get(name) !== readlinkSync(join(folder, name));
      changes.push(`${different ? "FAILED " : ""}${pluginFolder}/${name}: ${unownedLink}`);
    }

    for (const name of recorded.keys()) {
      const path = join(folder, name);
      const target = links.get(name);

      if (!target) {
        // Loss of custody: a changed or missing path must never regain authority by spelling.
        if (!unrecorded.has(name) && lstatSync(path, { throwIfNoEntry: false })) changes.push(`kept changed ${pluginFolder}/${name}; Office no longer owns it`);
        forget(name);
        continue;
      }

      if (installed.unread.has(name) || wanted.get(name) === target) continue;

      if (!ownsLink(office, name, target, recorded) || readlinkSync(path) !== target) throw new OfficeError(`kept changed ${pluginFolder}/${name}; retry sync after the edit`);
      unlinkSync(path);
      forget(name);
      changes.push(`unlinked ${pluginFolder}/${name}`);
    }

    for (const [name, target] of wanted) {
      if (unrecorded.has(name) || links.get(name) === target) continue;

      mkdirSync(folder, { recursive: true });
      const path = join(folder, name);
      symlinkSync(target, path); // exclusive creation; never replace an occupied path
      const identity = linkIdentity(path);

      if (!identity || readlinkSync(path) !== target) throw new OfficeError("package link changed before recording delivery");
      created({ owner: name, path: `${pluginFolder}/${name}`, target, identity });
      changes.push(`linked ${pluginFolder}/${name}`);
    }

    return changes;
  });
}

/** Recognize the historical single-file bundles before migrating them. */
export function legacyPlugin(office: Office, name: "knowledge" | "office"): boolean {
  const dir = join(office.dir, pluginFolder, name);

  return lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() === true &&
    readdirSync(dir).join() === "index.js" &&
    lstatSync(join(dir, "index.js")).isFile() &&
    readFileSync(join(dir, "index.js"), "utf8").split("\n", 3).includes(`// The office tool's ${name} plugin, bundled from its plugins/${name}/. \`office sync\` replaces this copy; change the tool's.`);
}
