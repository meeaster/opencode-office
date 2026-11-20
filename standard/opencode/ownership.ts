// Which entries of a `.opencode/plugins/` or `.opencode/skills/` folder are Office's. There is no
// record of what Office created: an entry is Office's exactly when it is a symlink whose target
// text is one Office writes for that folder. Real folders, files and links to anything else are
// the owner's, and Office never changes or removes them. A link the owner made by hand with
// Office's exact text counts as Office's.
//
// The rule is deliberately broad: any `<up>packages/<name>/<path>` or `<up>.office/packages/<name>/<path>`
// plugin link whose entry name equals the package name is Office's, whatever the asset path, and so
// are the package-skill link forms earlier releases made, whether or not that package is selected.
// It can't be narrowed without a ledger: once a package is deselected (or its registration changes
// its server path), nothing on disk says which path Office linked, so recognizing and withdrawing
// that link needs the whole shape. Office recreates such a link if the package is selected again.
import { existsSync, lstatSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import * as v from "valibot";
import { type Office, OfficeError } from "../../src/office.ts";
import { asset } from "./assets.ts";

export type Kind = "plugins" | "skills";

const name = /^[a-z0-9][a-z0-9-]*$/;

/** Office's plugin clones, linked from the root's `.opencode/plugins/<name>`. */
export const cloneFolder = ".office/plugins";

/**
 * Whether `target`, read from the link `<scope>/.opencode/<kind>/<entry>`, is one Office writes
 * there. `up` leads from that folder to the office root: `../../` at the root, `../../../` in a desk.
 *
 * - plugins: `<up>.office/plugins/<entry>` (a Git clone), and `<up>packages/<entry>/<path>` or
 *   `<up>.office/packages/<entry>/<path>` (a package's server plugin: `plugin` by convention, or
 *   the package-relative directory its `opencode(ctx)` registers).
 * - skills: `<up>skills/<entry>` (a library skill), and `<up>packages/<package>/skills/<entry>` or
 *   `<up>.office/packages/<package>/skills/<entry>` (package skill links earlier releases made).
 */
export function officeTarget(kind: Kind, up: string, entry: string, target: string): boolean {
  if (!name.test(entry) || !target.startsWith(up)) return false;
  const rest = target.slice(up.length);

  if (kind === "plugins") {
    if (rest === `${cloneFolder}/${entry}`) return true;

    return [`packages/${entry}/`, `.office/packages/${entry}/`].some(prefix => rest.startsWith(prefix) && v.is(asset, rest.slice(prefix.length)));
  }

  if (rest === `skills/${entry}`) return true;
  const parts = rest.split("/");
  const at = parts[0] === ".office" ? 1 : 0;

  return parts.length === at + 4 && parts[at] === "packages" && name.test(parts[at + 1]) && parts[at + 2] === "skills" && parts[at + 3] === entry;
}

export type Entry = {
  name: string;
  /** The link's target text, for a symlink. */
  target?: string;
  /** A symlink whose target text Office writes here. */
  office: boolean;
  /** A real folder (the owner's). */
  folder: boolean;
};

/** One `.opencode/<kind>/` folder: the office root's or a desk's. */
export type Scope = { desk: string | undefined; kind: Kind; folder: string; up: string; label: string };

export function scope(office: Office, desk: string | undefined, kind: Kind): Scope {
  const folder = desk === undefined ? join(office.dir, ".opencode", kind) : join(office.dir, desk, ".opencode", kind);

  return { desk, kind, folder, up: `${relative(folder, office.dir)}/`, label: relative(office.dir, folder) };
}

/**
 * The folders Office delivers into. Plugins are linked only at the root, where every desk inherits
 * them; desk plugin folders are entirely the owner's. Skills are linked at the root and per desk.
 */
export function scopes(office: Office): Scope[] {
  return [scope(office, undefined, "plugins"), scope(office, undefined, "skills"), ...office.desks.map(desk => scope(office, desk.name, "skills"))];
}

/**
 * Office manages entries in these folders, never the targets of a redirected desk, `.opencode` or
 * folder: a desk that is a symlink leads outside the office.
 */
export function requireFolder(where: Scope) {
  const opencode = dirname(where.folder);

  for (const path of [...(where.desk === undefined ? [] : [dirname(opencode)]), opencode, where.folder]) {
    const info = lstatSync(path, { throwIfNoEntry: false });

    if (info && !info.isDirectory()) throw new OfficeError(`cannot deliver ${where.kind}: ${where.label}, its .opencode or its desk is not an office directory (refusing to follow or replace it)`);
  }
}

/** Each entry of the folder, read without following links. A missing folder has none. Writers
 * call `requireFolder` first. */
export function entries(where: Scope): Entry[] {
  if (!existsSync(where.folder)) return [];

  return readdirSync(where.folder).flatMap(item => entry(where, item) ?? []);
}

/** The entry at `<folder>/<name>` as `entries` would describe it, or undefined when nothing is there. */
export function entry(where: Scope, entryName: string): Entry | undefined {
  const path = join(where.folder, entryName);
  const info = lstatSync(path, { throwIfNoEntry: false });

  if (!info) return undefined;
  const target = info.isSymbolicLink() ? readlinkSync(path) : undefined;

  return { name: entryName, target, office: target !== undefined && officeTarget(where.kind, where.up, entryName, target), folder: info.isDirectory() };
}

/** Office's entries everywhere it delivers, as office-relative paths. */
export function officeEntries(office: Office): string[] {
  return scopes(office).flatMap(where => entries(where).filter(item => item.office).map(item => relative(office.dir, join(where.folder, item.name)))).sort();
}
