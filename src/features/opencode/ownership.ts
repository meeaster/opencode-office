// Which entries of the office root's `.opencode/plugins/` folder are Office's. There is no
// record of what Office created: an entry is Office's exactly when it is a symlink whose target
// text is one Office writes for that folder. Real folders, files and links to anything else are
// the owner's, and Office never changes or removes them. A link the owner made by hand with
// Office's exact text counts as Office's.
//
// The rule is deliberately broad: any `<up>packages/<name>/<path>` or `<up>.office/packages/<name>/<path>`
// plugin link whose entry name equals the package name is Office's, whatever the asset path,
// whether or not that package is selected.
// It can't be narrowed without a ledger: once a package is deselected (or its registration changes
// its server path), nothing on disk says which path Office linked, so recognizing and withdrawing
// that link needs the whole shape. Office recreates such a link if the package is selected again.
import { existsSync, lstatSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import type { Office } from "../../office.ts";
import { asset } from "./assets.ts";

export const pluginFolder = ".opencode/plugins";

const name = /^[a-z0-9][a-z0-9-]*$/;

/** Office's plugin clones, linked from the root's `.opencode/plugins/<name>`. */
export const cloneFolder = ".office/plugins";

/**
 * Whether `target`, read from the link `.opencode/plugins/<entry>`, is one Office writes there:
 * `../../.office/plugins/<entry>` (a Git clone), and `../../packages/<entry>/<path>` or
 * `../../.office/packages/<entry>/<path>` (a package's server plugin, the package-relative
 * directory it registers with `opencode.plugins.add`).
 */
export function officeTarget(entry: string, target: string): boolean {
  if (!name.test(entry) || !target.startsWith("../../")) return false;
  const rest = target.slice("../../".length);

  if (rest === `${cloneFolder}/${entry}`) return true;

  return [`packages/${entry}/`, `.office/packages/${entry}/`].some(prefix => rest.startsWith(prefix) && v.is(asset, rest.slice(prefix.length)));
}

export type Entry = {
  name: string;
  /** The link's target text, for a symlink. */
  target?: string;
  /** A symlink whose target text Office writes here. */
  office: boolean;
};

/** Each entry of the root's plugin folder, read without following links. A missing folder has none. */
export function entries(office: Office): Entry[] {
  const folder = join(office.dir, pluginFolder);

  if (!existsSync(folder)) return [];

  return readdirSync(folder).flatMap(item => entry(office, item) ?? []);
}

/** The entry at `.opencode/plugins/<name>` as `entries` would describe it, or undefined when nothing is there. */
export function entry(office: Office, entryName: string): Entry | undefined {
  const path = join(office.dir, pluginFolder, entryName);
  const info = lstatSync(path, { throwIfNoEntry: false });

  if (!info) return undefined;
  const target = info.isSymbolicLink() ? readlinkSync(path) : undefined;

  return { name: entryName, target, office: target !== undefined && officeTarget(entryName, target) };
}

/** Office's entries in the root's plugin folder, as office-relative paths. */
export function officeEntries(office: Office): string[] {
  return entries(office).filter(item => item.office).map(item => `${pluginFolder}/${item.name}`).sort();
}
