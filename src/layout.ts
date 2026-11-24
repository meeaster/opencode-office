// What an office's folders should hold, derived from office.yaml and the tool: the clones and the
// installed packages. `office sync` makes the folders match; `office check` compares.
import { join } from "node:path";

import { type Office, type Repository } from "./office.ts";
import { definitionGate, type InstalledPackage, type PackageProblem, readPackage, resolvePackages, selectedNames } from "./packages.ts";
import type { PackageManifest } from "./schema.ts";
import { pluginClones } from "../standard/opencode/delivery.ts";

export type Clone = { name: string; url: string; ref?: string; kind: string; dir: string };

/** Every clone office.yaml declares, with the folder it belongs in. */
export function clones(office: Office, references: readonly Repository[]): Clone[] {
  return [
    ...references.map((reference) => ({ ...reference, kind: "reference", dir: join(office.dir, "references", reference.name) })),
    ...office.desks.flatMap((desk) =>
      desk.repos.map((repo) => ({ ...repo, kind: `${desk.name} repo`, dir: join(office.dir, desk.name, "repos", repo.name) })),
    ),
    ...pluginClones(office),
  ];
}

/** Packages installed with valid settings, read from their definitions alone: no setup runs, so
 * nothing they register is known here (src/gather.ts gathers that). The whole selection passes
 * `definitionGate` first (the `skip` packages, the ones sync failed to fetch, are left out); with
 * any problem, no definition is imported and `blocked` holds the problems. `live` (the gathering)
 * resolves the rest of the selection past an ownership problem, and that problem blocks it too:
 * another package could import the conflicting one's copy. */
export function installedPackages(office: Office, skip: ReadonlySet<string> = new Set(), live = false): InstalledPackages {
  const installed: InstalledPackage[] = [];
  const resolved = resolvePackages(office, undefined, live);
  const problems = [...resolved.problems];
  const selected = selectedNames(office);
  const unread = new Set(selected);
  const gate = definitionGate(office, resolved.packages, skip);
  // resolvePackages already names a package called sdk.
  const unknown = gate.filter(problem => !problems.some(known => known.message === problem.message));
  const blocked = live ? [...problems, ...unknown] : gate;

  if (blocked.length) return { selected, installed, problems: [...problems, ...unknown], unread, blocked, invalidSettings: [], definitions: new Map() };

  const invalidSettings: PackageProblem[] = [];
  const definitions = new Map<string, PackageManifest>();

  for (const item of resolved.packages) {
    if (skip.has(item.entry.name)) continue;
    const read = readPackage(office, item);
    const manifest = read.ok ? read.value.manifest : read.manifest;

    if (manifest) definitions.set(item.entry.name, manifest);

    if (read.ok) {
      installed.push(read.value);
      unread.delete(item.entry.name);
    } else {
      problems.push(...read.errors.map((message) => ({ packages: [item.entry.name], message })));
      invalidSettings.push(...(read.settings ?? []).map((message) => ({ packages: [item.entry.name], message })));
    }
  }

  return { selected, installed, problems, unread, invalidSettings, definitions };
}

export type InstalledPackages = {
  selected: Set<string>;
  installed: InstalledPackage[];
  problems: PackageProblem[];
  /** Selected but unresolved or unreadable: absence from `installed` cannot authorize cleanup. */
  unread: Set<string>;
  /** The problems `definitionGate` found; with any, no package loaded. */
  blocked?: PackageProblem[];
  /** Settings in office.yaml that a package's schema refuses (also in `problems`); with any, no setup may run. */
  invalidSettings: PackageProblem[];
  /** The definition of each package that loaded, read or not: its declared commands are claimed either way. */
  definitions: Map<string, PackageManifest>;
};
