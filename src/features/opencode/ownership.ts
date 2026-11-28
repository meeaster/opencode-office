import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { atomicWrite } from "../../lib/atomic-write.ts";
import { OfficeError, type Office } from "../../office.ts";
import { check } from "../../parse.ts";
import { asset } from "./assets.ts";

export const pluginFolder = ".opencode/plugins";
export const copyFolder = ".office/opencode";

const name = /^[a-z0-9][a-z0-9-]*$/;
const receiptFile = `${copyFolder}/copies.json`;

const receipt = v.strictObject({
  copies: v.array(v.pipe(v.string(), v.startsWith(`${pluginFolder}/`), v.check(path => name.test(path.slice(pluginFolder.length + 1))))),
});

/** Office's plugin clones, linked from the root's `.opencode/plugins/<name>`. */
export const cloneFolder = ".office/plugins";

/** A link to a clone or to a local package's registered server directory, even after deselection. */
export function officeTarget(entry: string, target: string): boolean {
  if (!name.test(entry) || !target.startsWith("../../")) return false;
  const rest = target.slice("../../".length);

  if (rest === `${cloneFolder}/${entry}`) return true;

  const prefix = `packages/${entry}/`;

  return rest.startsWith(prefix) && v.is(asset, rest.slice(prefix.length));
}

function copyReceipt(office: Office) {
  for (const parent of [".office", copyFolder]) {
    const info = lstatSync(join(office.dir, parent), { throwIfNoEntry: false });

    if (info && !info.isDirectory()) throw new OfficeError(`cannot use ${receiptFile}: ${parent} is not a real folder`);
  }

  const path = join(office.dir, receiptFile);
  const info = lstatSync(path, { throwIfNoEntry: false });

  if (info && !info.isFile()) throw new OfficeError(`${receiptFile} is not a regular file`);

  return { path, present: info !== undefined };
}

export function readCopies(office: Office): Set<string> {
  const { path, present } = copyReceipt(office);

  if (!present) return new Set();
  let parsed: unknown;

  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new OfficeError(`cannot read ${receiptFile}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const read = check(v.safeParse(receipt, parsed));

  if (!read.ok) throw new OfficeError(`${receiptFile} is not a record of folders in ${pluginFolder}/`);

  return new Set(read.value.copies.map(path => path.slice(pluginFolder.length + 1)));
}

export function writeCopies(office: Office, copies: ReadonlySet<string>) {
  const { path } = copyReceipt(office);
  const text = `${JSON.stringify({ copies: [...copies].sort().map(name => `${pluginFolder}/${name}`) }, null, 2)}\n`;

  atomicWrite(path, text, 0o644);
}

export type Entry = {
  name: string;
  /** The link's target text, for a symlink. */
  target?: string;
  copied: boolean;
  office: boolean;
};

/** Each entry of the root's plugin folder, read without following links. A missing folder has none. */
export function entries(office: Office, copies: ReadonlySet<string> = readCopies(office)): Entry[] {
  const folder = join(office.dir, pluginFolder);

  if (!lstatSync(join(office.dir, ".opencode"), { throwIfNoEntry: false })?.isDirectory()) return [];

  if (!lstatSync(folder, { throwIfNoEntry: false })?.isDirectory()) return [];

  return readdirSync(folder).flatMap(item => entry(office, item, copies) ?? []);
}

/** The entry at `.opencode/plugins/<name>` as `entries` would describe it, or undefined when nothing is there. */
export function entry(office: Office, entryName: string, copies: ReadonlySet<string> = readCopies(office)): Entry | undefined {
  if (!lstatSync(join(office.dir, ".opencode"), { throwIfNoEntry: false })?.isDirectory()) return;

  if (!lstatSync(join(office.dir, pluginFolder), { throwIfNoEntry: false })?.isDirectory()) return;
  const path = join(office.dir, pluginFolder, entryName);
  const info = lstatSync(path, { throwIfNoEntry: false });

  if (!info) return undefined;
  const target = info.isSymbolicLink() ? readlinkSync(path) : undefined;
  const copied = copies.has(entryName);

  return { name: entryName, target, copied, office: copied || (target !== undefined && officeTarget(entryName, target)) };
}

/** Office's entries in the root's plugin folder, as office-relative paths. */
export function officeEntries(office: Office): string[] {
  const copies = readCopies(office);
  const names = [...copies];

  for (const item of entries(office, copies)) {
    if (!item.copied && item.office) names.push(item.name);
  }

  return names.sort().map(name => `${pluginFolder}/${name}`);
}
