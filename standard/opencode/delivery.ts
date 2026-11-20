// Only office-wide package links and separately declared Git clones are managed here.
// Desk and repo plugin directories belong to their owners.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { OfficeError, type Office } from "../../src/office.ts";
import type { InstalledPackage, PackageProblem } from "../../src/packages.ts";

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

export function planPlugins(office: Office, installed: InstalledPackage[]) {
  const plugins = new Map<string, string>();
  const problems: PackageProblem[] = [];

  for (const { entry, dir, plugin } of installed) {
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

  return { plugins, problems };
}

export function pluginLinks(office: Office, plugins: Map<string, string>) {
  const folder = join(office.dir, pluginFolder);
  const wanted = new Map([...plugins].map(([name, dir]) => [name, relative(folder, dir)]));
  const links = new Map<string, string>();

  for (const name of existsSync(folder) ? readdirSync(folder) : []) {
    const target = packageLink(join(folder, name));

    if (target !== undefined) links.set(name, target);
  }

  return { folder, wanted, links };
}

export function linkPlugins(office: Office, installed: { plugins: Map<string, string>; unread: Set<string> }): string[] {
  requirePluginDestination(office);
  const { folder, wanted, links } = pluginLinks(office, installed.plugins);
  const changes: string[] = [];

  for (const [name, target] of links) {
    if (installed.unread.has(name) || wanted.get(name) === target) continue;

    unlinkSync(join(folder, name));
    changes.push(`unlinked ${pluginFolder}/${name}`);
  }

  for (const [name, target] of wanted) {
    if (links.get(name) === target) continue;

    mkdirSync(folder, { recursive: true });
    symlinkSync(target, join(folder, name));
    changes.push(`linked ${pluginFolder}/${name}`);
  }

  return changes;
}

/** Recognize the historical single-file bundles before migrating them. */
export function legacyPlugin(office: Office, name: "knowledge" | "office"): boolean {
  const dir = join(office.dir, pluginFolder, name);

  return lstatSync(dir, { throwIfNoEntry: false })?.isDirectory() === true &&
    readdirSync(dir).join() === "index.js" &&
    lstatSync(join(dir, "index.js")).isFile() &&
    readFileSync(join(dir, "index.js"), "utf8").split("\n", 3).includes(`// The office tool's ${name} plugin, bundled from its plugins/${name}/. \`office sync\` replaces this copy; change the tool's.`);
}
