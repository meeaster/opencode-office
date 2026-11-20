// Only office-wide package links and separately declared Git clones are managed here.
// Desk and repo plugin directories belong to their owners.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { OfficeError, type Office } from "../../src/office.ts";
import type { InstalledPackages } from "../../src/layout.ts";
import { linkIdentity, readReceipts, reconcileReceipts } from "./receipts.ts";

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

export function withPluginPlan(office: Office, installed: InstalledPackages) {
  const plugins = new Map<string, string>();
  const problems = [...installed.problems];

  for (const { entry, dir, plugin } of installed.installed) {
    if (!plugin) continue;

    const at = `${pluginFolder}/${entry.name}`;
    const path = join(office.dir, at);
    const taken = lstatSync(path, { throwIfNoEntry: false }) && packageLink(path) === undefined;

    const problem = office.plugins.some(cloned => cloned.name === entry.name)
      ? `its plugin would be ${at}, where the plugins: entry ${entry.name} is cloned`
      : taken && entry.name === "office" && legacyPlugin(office, "office")
        ? `its plugin would be ${at}, where earlier releases of office copied the tool's plugin; office sync replaces that copy with the link`
        : taken
          ? `its plugin would be ${at}, which holds a plugin of this office's own (not a link office sync made)`
          : undefined;

    if (problem === undefined) plugins.set(entry.name, join(dir, "plugin"));
    else problems.push({ packages: [entry.name], message: `${problem}, so it isn't linked; rename one of them` });
  }

  return { ...installed, plugins, problems };
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
    const target = packageLink(path);

    if (target === undefined) continue;

    if (ownsLink(office, name, target, recorded)) links.set(name, target);
    else unrecorded.add(name);
  }

  return { folder, wanted, links, unrecorded };
}

export function linkPlugins(office: Office, installed: { plugins: Map<string, string>; unread: Set<string> }): string[] {
  requirePluginDestination(office);

  return reconcileReceipts(office, (recorded, created, forget) => {
    const { folder, wanted, links, unrecorded } = pluginLinks(office, installed.plugins, recorded);
    const changes: string[] = [];

    for (const name of unrecorded) {
      const different = wanted.has(name) && wanted.get(name) !== packageLink(join(folder, name));
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

      if (packageLink(path) !== target || !ownsLink(office, name, target, recorded)) throw new OfficeError(`kept changed ${pluginFolder}/${name}; retry sync after the edit`);
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

      if (!identity || packageLink(path) !== target) throw new OfficeError("package link changed before recording delivery");
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
