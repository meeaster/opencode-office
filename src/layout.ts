// What an office's folders should hold, derived from office.yaml and the tool: the clones and the
// installed packages. `office sync` makes the folders match; `office check` compares.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { type Office, type Repository } from "./office.ts";
import { definitionGate, type InstalledPackage, type PackageProblem, readPackage, resolvePackages, selectedNames } from "./packages.ts";
import type { PackageManifest } from "./schema.ts";
import { pluginClones } from "../standard/opencode/delivery.ts";

export type Clone = { name: string; url: string; ref?: string; kind: "reference" | "plugin"; dir: string };

/** Every reference and plugin clone office.yaml declares, with the folder it belongs in. */
export function clones(office: Office, references: readonly Repository[]): Clone[] {
  return [
    ...references.map((reference) => ({ ...reference, kind: "reference" as const, dir: join(office.dir, "references", reference.name) })),
    ...pluginClones(office),
  ];
}

/**
 * Root folders that hold checkouts and files of their own, which the office's repository must
 * never commit: working repositories and scratch work, whether or not a package manages them.
 */
export const separateFolders = ["repos", "scratch"];

/**
 * A problem for each of `separateFolders` the office's repository doesn't keep out: one its Git
 * rules don't ignore (`git check-ignore`), one holding files the repository already tracks, which
 * an ignore rule doesn't untrack, and one Git can't be asked about; none outside a Git repository.
 * The rules and the index are the owner's, so this only reads and says.
 */
export function unignoredFolders(dir: string): string[] {
  if (!existsSync(join(dir, ".git"))) return [];

  return separateFolders.flatMap((folder) => {
    const ignored = spawnSync("git", ["check-ignore", "--quiet", "--no-index", "--", `${folder}/checkout/file`], { cwd: dir, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });

    if (ignored.status === 1) return [`${folder}/ is not ignored by the office's Git rules, so its checkouts could be committed into the office; add /${folder}/ to .gitignore`];

    if (ignored.status !== 0) return [`${folder}/: couldn't ask Git whether the office's rules ignore it (${gitProblem(ignored)}), so its checkouts may not be kept out of the office`];
    const tracked = spawnSync("git", ["ls-files", "-z", "--", `${folder}/`], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    if (tracked.status !== 0) return [`${folder}/: couldn't ask Git which of its files the office tracks (${gitProblem(tracked)}), so its checkouts may not be kept out of the office`];
    const files = tracked.stdout.split("\0").filter(Boolean);

    return files.length === 0 ? [] : [`${folder}/ holds ${files.length === 1 ? "a file" : `${files.length} files`} the office's repository tracks (${files[0]}${files.length > 1 ? ", …" : ""}), which its ignore rules don't untrack; untrack them with git rm -r --cached ${folder}/`];
  });
}

/** What went wrong with a Git process, in a few words. */
function gitProblem(result: ReturnType<typeof spawnSync>): string {
  const said = String(result.stderr ?? "").trim().split("\n")[0];

  return said || (result.error ? result.error.message : `git exited ${result.status ?? result.signal}`);
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
