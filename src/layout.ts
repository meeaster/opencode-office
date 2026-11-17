// What an office's folders should hold, derived from office.yaml and the tool: the clones, the
// installed packages, and the library skill and package plugin links. `office sync` makes the
// folders match; `office check` compares. Nothing of a package but its plugin is linked: the plugin
// gives OpenCode whatever the package provides, its skills and MCP servers included.
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";

import { type Office, skillsFolder } from "./office.ts";
import { type InstalledPackage, type PackageProblem, readPackage, resolvePackages } from "./packages.ts";

export type Clone = { name: string; url: string; ref?: string; kind: string; dir: string };

/** Every clone office.yaml declares, with the folder it belongs in. */
export function clones(office: Office): Clone[] {
  return [
    ...office.references.map((reference) => ({ ...reference, kind: "reference", dir: join(office.dir, "references", reference.name) })),
    ...office.desks.flatMap((desk) =>
      desk.repos.map((repo) => ({ ...repo, kind: `${desk.name} repo`, dir: join(office.dir, desk.name, "repos", repo.name) })),
    ),
    ...office.plugins.map((plugin) => ({ ...plugin, kind: "plugin", dir: join(office.dir, ".opencode/plugins", plugin.name) })),
  ];
}

/** Skill IDs in the office's library, `skills/<id>/`. */
export function library(office: Office): string[] {
  const dir = join(office.dir, "skills");

  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/**
 * The office's packages that are installed with valid settings, and each one's plugin to link.
 * `problems` names each package that isn't, each entry that can't be one, and each plugin not
 * linked because of its name.
 */
export function installedPackages(office: Office): InstalledPackages {
  const installed: InstalledPackage[] = [];
  const resolved = resolvePackages(office);
  const problems = [...resolved.problems];

  for (const item of resolved.packages) {
    const read = readPackage(office, item);

    if (read.ok) installed.push(read.value);
    else problems.push(...read.errors.map((message) => ({ packages: [item.entry.name], message })));
  }

  // A package's plugin is linked under the package's name, which office.yaml keeps unique among
  // packages; it can still meet a cloned plugin or one of the office's own.
  const plugins = new Map<string, string>();

  for (const { entry, dir, plugin } of installed) {
    if (!plugin) continue;

    const at = `.opencode/plugins/${entry.name}`;
    const taken = occupied(join(office.dir, at)) && packageLink(join(office.dir, at)) === undefined;

    const problem = office.plugins.some((cloned) => cloned.name === entry.name)
      ? `its plugin would be ${at}, where the plugins: entry ${entry.name} is cloned`
      : taken && entry.name === "office"
        ? `its plugin would be ${at}, where earlier releases of office copied the tool's plugin; office sync replaces that copy with the link`
        : taken
          ? `its plugin would be ${at}, which holds a plugin of this office's own (not a link office sync made)`
          : undefined;

    if (problem === undefined) plugins.set(entry.name, join(dir, "plugin"));
    else problems.push({ packages: [entry.name], message: `${problem}, so it isn't linked; rename one of them` });
  }

  return { installed, plugins, problems };
}

export type InstalledPackages = {
  installed: InstalledPackage[];
  /** Each package plugin to link, by package name, with its folder. */
  plugins: Map<string, string>;
  problems: PackageProblem[];
};

function occupied(path: string): boolean {
  try {
    lstatSync(path);

    return true;
  } catch {
    return false;
  }
}

/**
 * The target of `path` when it is a link office sync made to a package plugin,
 * `../../.office/packages/<name>/plugin` or `../../packages/<name>/plugin`.
 */
export function packageLink(path: string): string | undefined {
  let target;

  try {
    target = readlinkSync(path);
  } catch {
    // Missing, or not a link.
    return undefined;
  }

  return target.startsWith("../../packages/") || target.startsWith("../../.office/packages/") ? target : undefined;
}

/**
 * The package plugins of `.opencode/plugins/`: the links the office's packages want, by name with
 * their relative targets, and the links to package plugins there now.
 */
export function pluginLinks(office: Office) {
  const folder = join(office.dir, ".opencode/plugins");
  const { plugins } = installedPackages(office);
  const wanted = new Map([...plugins].map(([name, dir]) => [name, relative(folder, dir)]));
  const links = new Map<string, string>();

  for (const name of existsSync(folder) ? readdirSync(folder) : []) {
    const target = packageLink(join(folder, name));

    if (target !== undefined) links.set(name, target);
  }

  return { folder, wanted, links };
}

/**
 * Whether `.opencode/plugins/knowledge/` is the copy of the knowledge plugin an `office` before
 * the knowledge package wrote into each office, recognised by the banner its bundle starts with.
 */
export function oldKnowledgePlugin(office: Office): boolean {
  const dir = join(office.dir, ".opencode/plugins/knowledge");

  return (
    occupied(dir) &&
    lstatSync(dir).isDirectory() &&
    readdirSync(dir).join() === "index.js" &&
    // Bun puts `// @bun` above the banner.
    readFileSync(join(dir, "index.js"), "utf8").split("\n", 3).includes("// The office tool's knowledge plugin, bundled from its plugins/knowledge/. `office sync` replaces this copy; change the tool's.")
  );
}

export type SkillSelection = {
  desk: string | undefined;
  folder: string;
  /** Library skills enabled here, each linked into this `.opencode/skills/`. */
  enabled: string[];
  links: Map<string, string>;
  folders: string[];
  target: (skill: string) => string;
};

/**
 * The skill selection of the root (`desk` undefined) and of each desk: which library skills
 * should be linked into that `.opencode/skills/`, and what is there now.
 */
export function skillSelections(office: Office): SkillSelection[] {
  const levels = [{ desk: undefined, enabled: office.skills.enabled }, ...office.desks.map((desk) => ({ desk: desk.name, enabled: desk.skills }))];

  return levels.map(({ desk, enabled }) => {
    const folder = skillsFolder(office, desk);
    const links = new Map<string, string>();
    const folders: string[] = [];

    for (const entry of existsSync(folder) ? readdirSync(folder, { withFileTypes: true }) : []) {
      if (entry.isSymbolicLink()) links.set(entry.name, readlinkSync(join(folder, entry.name)));
      else if (entry.isDirectory()) folders.push(entry.name);
    }

    return {
      desk,
      folder,
      enabled,
      links,
      folders,
      /** The relative link target for a skill, so it resolves on the host and in the container. */
      target: (skill) => relative(folder, join(office.dir, "skills", skill)),
    };
  });
}
