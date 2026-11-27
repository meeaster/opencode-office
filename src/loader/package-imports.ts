// How packages reach each other: one directory link per package in a package set's
// node_modules/@office, so `@office/<name>/…` resolves by ordinary node_modules lookup with the
// package's package.json `exports` enforced by Bun. And which packages an update must move together.
import { failure, type Change } from "../lib/change.ts";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { packageLinks } from "../bound-paths.ts";
import { importEdges, readPackageJson, sdkName } from "./sources/manifest.ts";
import type { ResolvedPackage } from "./sources/selection.ts";
import { toolFiles, toolPath, writeToolFile } from "../tool.ts";

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

/**
 * Each present package's import edges in this view: its declared office dependencies and its
 * optional providers the view selects, whether or not their copies are present. Throws when a
 * package.json can't be read.
 */
function declaredDependencies(packages: ResolvedPackage[]) {
  const graph = new Map<string, Set<string>>();
  const selected = new Set(packages.map(pkg => pkg.entry.name));

  for (const pkg of packages) {
    if (!existsSync(pkg.dir)) continue;
    const read = readPackageJson(pkg.dir, pkg.entry.name);

    if (!read.ok) throw new Error(read.errors.join("; "));
    // @office/sdk is no package, so it couples nothing.
    graph.set(pkg.entry.name, new Set(importEdges(read.value, selected).filter(name => name !== sdkName)));
  }

  return graph;
}

/**
 * Which of the `pending` packages an update must hold back, given those `rejected`: each that
 * depends on a rejected one, or that a rejected one depends on, in either view's import edges
 * (selected optional providers included). An unreadable package.json is not evidence of independence: all are held back.
 */
export function coupledFailures(rejected: string[], pending: string[], views: ResolvedPackage[][]) {
  try {
    const graphs = views.map(declaredDependencies);
    const failed = new Set(rejected.filter(name => pending.includes(name)));

    const reachable = (from: string) => {
      const seen = new Set([from]);

      for (const name of seen) for (const graph of graphs) for (const dependency of graph.get(name) ?? []) seen.add(dependency);

      return seen;
    };

    const paths = new Map(pending.map(name => [name, reachable(name)]));

    for (const name of failed) {
      for (const [peer, imports] of paths) if (imports.has(name) || paths.get(name)?.has(peer)) failed.add(peer);
    }

    return [...failed];
  } catch {
    return pending;
  }
}
