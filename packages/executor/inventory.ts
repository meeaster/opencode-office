// The office's Executor app sources: its own `executor-apps/<slug>/` and the folders packages
// contribute through the apps registry. Everything here reads files only, so deploy, adopt and
// check reject a bad inventory before their first request to Executor.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import type { Entry, SettingValue } from "@office/sdk";
import type { App } from "./apps.ts";

/** The file that marks a root app folder as an adopted catalog app's source. */
export const adoptionMarker = ".office-catalog";

/** The office's own app sources. */
export const rootFolder = "executor-apps";

/**
 * An app's source folder. `contributor` is the package that offers it, whose folder is read-only:
 * deploy sends its files with the served `apps` version and a generated `package.ts`.
 */
export type AppFolder = {
  slug: string;
  dir: string;
  /** Office-relative, for messages. */
  where: string;
  adopted: boolean;
  contributor?: { name: string; settings: Readonly<Record<string, SettingValue>> };
};

/** The office's own app folders by name: each folder of `executor-apps/` holding a `package.json`. */
export function rootAppNames(officeDir: string): string[] {
  const dir = join(officeDir, rootFolder);

  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory() && existsSync(join(dir, entry.name, "package.json")) ? [entry.name] : []);
}

function rootFolders(officeDir: string, catalogApps: readonly string[]): AppFolder[] {
  return rootAppNames(officeDir).map((slug) => {
    const where = `${rootFolder}/${slug}`;
    const marker = join(officeDir, where, adoptionMarker);
    const adopted = existsSync(marker);

    if (adopted && (!catalogApps.includes(slug) || readFileSync(marker, "utf8").trim() !== slug)) {
      throw new Error(`${marker}: an adopted Executor app must be in ${rootFolder}/<catalog-id> and listed in the executor package's catalog_apps setting`);
    }

    return { slug, dir: join(officeDir, where), where, adopted };
  });
}

/** A contribution's folder: throws naming the package and path when it is outside its package or has no package.json. */
export function contributedFolder(officeDir: string, entry: Entry<App>): AppFolder {
  const { directory } = entry.value;
  const dir = resolve(entry.folder, directory);
  const where = relative(officeDir, join(entry.root, directory));
  const inside = (base: string, path: string) => path.startsWith(`${base}${sep}`);
  const outside = new Error(`package ${entry.owner}: its Executor app ${directory} is outside the package`);

  if (isAbsolute(directory) || !inside(resolve(entry.folder), dir)) throw outside;

  if (!existsSync(join(dir, "package.json"))) throw new Error(`package ${entry.owner}: its Executor app ${directory} has no package.json`);

  // A link inside the package can still lead out of it.
  if (!inside(realpathSync(entry.folder), realpathSync(dir))) throw outside;

  return { slug: entry.namespace, dir, where, adopted: false, contributor: { name: entry.owner, settings: entry.settings } };
}

/**
 * Every app source, the office's first: throws naming the package and path of a contribution
 * outside its package or without `package.json`, and both sources of a slug two of them claim.
 */
export function appFolders(officeDir: string, catalogApps: readonly string[], entries: readonly Entry<App>[]): AppFolder[] {
  const folders = [...rootFolders(officeDir, catalogApps), ...entries.map(entry => contributedFolder(officeDir, entry))];
  const seen = new Map<string, string>();

  for (const folder of folders) {
    const other = seen.get(folder.slug);

    if (other !== undefined) throw new Error(`${folder.where} and ${other} both deploy the Executor app ${folder.slug}; rename one of them`);

    seen.set(folder.slug, folder.where);
  }

  return folders;
}

/** An app folder's package.json, with only the fields office reads. */
export type AppManifest = { description?: string; dependencies?: Record<string, string>; executor?: { title?: string } };

export function readManifest(dir: string): AppManifest {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}
