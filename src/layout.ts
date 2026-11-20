// What an office's folders should hold, derived from office.yaml and the tool: the clones, the
// installed packages, and the library skill and package plugin links. `office sync` makes the
// folders match; `office check` compares. Nothing of a package but its plugin is linked: the plugin
// gives OpenCode whatever the package provides, its skills and MCP servers included.
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { type Office, type Repository } from "./office.ts";
import { builtinSource, gitSelection, readRecord, type InstalledPackage, type PackageProblem, readPackage, requiredPackages, resolvePackages } from "./packages.ts";
import { readSnapshot } from "./reference-snapshot.ts";
import { machineCollection, project } from "../standard/mise-integration/projection.ts";
import { pluginClones } from "../standard/opencode/delivery.ts";
import { entries, scope, type Scope } from "../standard/opencode/ownership.ts";

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
export function installedPackages(office: Office, rejected: ReadonlySet<string> = new Set(), publishedMachine = true): InstalledPackages {
  const installed: InstalledPackage[] = [];
  const resolved = resolvePackages(office);
  const problems = [...resolved.problems];
  const selected = new Set([...requiredPackages, ...office.packages.map((entry) => entry.name)]);
  const unread = new Set(selected);

  const snapshot = publishedMachine ? readSnapshot(office.dir) : undefined;

  for (const item of resolved.packages) {
    if (rejected.has(item.entry.name)) continue;
    const read = readPackage(office, item);

    if (read.ok) {
      try {
        if (snapshot && !snapshot.ok) throw new Error(snapshot.errors.join("; "));
        const group = snapshot?.value?.contributors.find(owner => owner.name === item.entry.name);

        if (group?.entries.some(row => machineCollection(row.id))) {
          const record = item.kind === "local" ? undefined : readRecord(item.dir);
          const source = item.kind === "local" ? "local" : item.entry.source ? gitSelection(item.entry.source) : record && builtinSource(record.files);

          if (source !== group.source || (record && "repo" in record && record.commit !== group.commit)) throw new Error(`machine claims of ${item.entry.name} belong to a different source; sync to collect them`);
          project(read.value, group.entries);
        }
      } catch (error) {
        problems.push({ packages: [item.entry.name], message: String(error) });
        continue;
      }

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
  scope: Scope;
  /** Library skills enabled here, each linked into this `.opencode/skills/`. */
  enabled: string[];
  /** Office's links here (ownership.ts), with their targets. */
  links: Map<string, string>;
  /** The office's own skills here: real folders and links Office didn't write. Never changed. */
  own: string[];
  target: (skill: string) => string;
};

/**
 * The skill selection of the root (`desk` undefined) and of each desk: which library skills
 * should be linked into that `.opencode/skills/`, and what is there now.
 */
export function skillSelections(office: Office): SkillSelection[] {
  const levels = [{ desk: undefined, enabled: office.skills.enabled }, ...office.desks.map((desk) => ({ desk: desk.name, enabled: desk.skills }))];

  return levels.map(({ desk, enabled }) => {
    const where = scope(office, desk, "skills");
    const links = new Map<string, string>();
    const own: string[] = [];

    for (const entry of entries(where)) {
      if (entry.office && entry.target !== undefined) links.set(entry.name, entry.target);
      else if (entry.folder || entry.target !== undefined) own.push(entry.name);
    }

    return {
      desk,
      folder: where.folder,
      scope: where,
      enabled,
      links,
      own,
      /** The relative link target for a skill, so it resolves on the host and in the container. */
      target: (skill) => relative(where.folder, join(office.dir, "skills", skill)),
    };
  });
}
