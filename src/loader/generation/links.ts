// How packages reach each other: one directory link per package in a package set's
// node_modules/@office, so `@office/<name>/…` resolves by ordinary node_modules lookup with the
// package's package.json `exports` enforced by Bun.
import { failure, type Change } from "../../lib/change.ts";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { packageLinks } from "../../bound-paths.ts";
import { sdkName } from "../sources/manifest.ts";
import type { ResolvedPackage } from "../sources/selection.ts";
import { toolFiles, toolPath, writeToolFile } from "../../tool.ts";

/**
 * Links each package as `<folder>/node_modules/@office/<name>`, relative, so the office can move;
 * a package this sync `rejected` gets none, so nothing imports it.
 */
export function writePackageLinks(folder: string, packages: ResolvedPackage[], rejected: readonly string[]) {
  const links = packageLinks(folder);
  mkdirSync(links, { recursive: true });

  for (const pkg of packages) {
    if (rejected.includes(pkg.entry.name)) continue;
    const link = join(links, pkg.entry.name);
    symlinkSync(relative(dirname(link), pkg.dir), link);
  }
}

/**
 * Writes the SDK's source as `<folder>/node_modules/@office/sdk`, beside the package links, so
 * editors and tsc resolve a package's `@office/sdk` import. Its root is types only: its runtime
 * entry throws, since a package office loads gets the executable's own SDK. Its
 * `./applied-settings` entry runs, for a package's Bun scripts.
 */
export function writeSdk(folder: string) {
  const target = join(packageLinks(folder), sdkName);

  for (const file of toolFiles("sdk")) writeToolFile(join(target, file), readFileSync(toolPath(`sdk/${file}`), "utf8"));
}

export const editorLinks = "packages/node_modules/@office";

/**
 * Points `packages/node_modules/@office` at the published set's links, so an editor (and a run
 * from source) resolves a local package's `@office/…` imports. The compiled office doesn't use
 * it. Creates it when missing and corrects a link that points elsewhere; a real file or folder
 * there is the owner's, reported and left, and so is a `packages/node_modules` that isn't a real
 * folder, so nothing is written through it. An office without a packages/ folder gets none.
 * Never throws: sync runs it after publishing, so a failure is reported as a line.
 */
export function linkForEditors(dir: string): Change[] {
  if (!existsSync(join(dir, "packages"))) return [];
  const path = join(dir, editorLinks);
  const parent = lstatSync(dirname(path), { throwIfNoEntry: false });
  const left = (what: string, kind: string) => [`${what} is not Office's ${kind}; left as it is, so editors may not resolve @office imports (move it aside and sync to restore the link)`];

  if (parent && !parent.isDirectory()) return left(dirname(editorLinks), "folder");

  try {
    const target = relative(dirname(path), join(dir, ".office/current/node_modules/@office"));
    const entry = lstatSync(path, { throwIfNoEntry: false });

    if (entry && !entry.isSymbolicLink()) return left(editorLinks, "link");

    if (entry && readlinkSync(path) === target) return [];
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}`;
    // A crashed run with the same pid may have left one.
    rmSync(temporary, { force: true });
    symlinkSync(target, temporary);
    renameSync(temporary, path);

    return [`${entry ? "corrected" : "linked"} ${editorLinks} to the published package set, for editors`];
  } catch (error) {
    return [failure(`FAILED ${editorLinks}: ${error instanceof Error ? error.message : String(error)}`)];
  }
}
