// What an office's folders should hold, derived from office.yaml and the tool: the clones, the
// installed packages, and the library skill and package plugin links. `office sync` makes the
// folders match; `office check` compares. Nothing of a package but its plugin is linked: the plugin
// gives OpenCode whatever the package provides, its skills and MCP servers included.
import { existsSync, readdirSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";

import { type Office, type Repository, skillsFolder } from "./office.ts";
import { type InstalledPackage, type PackageProblem, readPackage, requiredPackages, resolvePackages } from "./packages.ts";
import { pluginClones } from "../standard/opencode/delivery.ts";

export type Clone = { name: string; url: string; ref?: string; kind: string; dir: string; stale?: boolean };

/** Every clone office.yaml declares, with the folder it belongs in. */
export function clones(office: Office, references: readonly (Repository & { stale?: boolean })[]): Clone[] {
  return [
    ...references.map((reference) => ({ ...reference, kind: "reference", dir: join(office.dir, "references", reference.name) })),
    ...office.desks.flatMap((desk) =>
      desk.repos.map((repo) => ({ ...repo, kind: `${desk.name} repo`, dir: join(office.dir, desk.name, "repos", repo.name) })),
    ),
    ...pluginClones(office),
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

/** Packages installed with valid settings. Filesystem conflicts in plugin delivery are not
 * package-load failures and must not disable independent consumers such as cron. */
export function installedPackages(office: Office, rejected: ReadonlySet<string> = new Set()): InstalledPackages {
  const installed: InstalledPackage[] = [];
  const resolved = resolvePackages(office);
  const problems = [...resolved.problems];
  const selected = new Set([...requiredPackages, ...office.packages.map((entry) => entry.name)]);
  const unread = new Set(selected);

  for (const item of resolved.packages) {
    if (rejected.has(item.entry.name)) continue;
    const read = readPackage(office, item);

    if (read.ok) {
      installed.push(read.value);
      unread.delete(item.entry.name);
    } else problems.push(...read.errors.map((message) => ({ packages: [item.entry.name], message })));
  }

  return { selected, installed, problems, unread };
}

export type InstalledPackages = {
  selected: Set<string>;
  installed: InstalledPackage[];
  problems: PackageProblem[];
  /** Selected but unresolved or unreadable: absence from `installed` cannot authorize cleanup. */
  unread: Set<string>;
};

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
