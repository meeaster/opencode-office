import { join } from "node:path";
import type { ResolvedPackage } from "./packages.ts";

export const pulledFolder = ".office/packages";

/** Only an evaluator binds paths. Controllers and external link planners use the
 * stable discovery path. A process never evaluates two source views. */
let bound: { dir: string; folder: string } | undefined;

export function bindPaths(dir: string, folder: string) {
  if (bound && (bound.dir !== dir || bound.folder !== folder)) throw new Error("cannot change package generation in an evaluating process");
  bound = { dir, folder };
}

export function packageRoot(dir: string) {
  return bound?.dir === dir ? join(bound.folder, "packages") : join(dir, pulledFolder);
}

/** Paths that outlive evaluation (e.g. mise hooks) must follow the published package.
 * Keep using item.dir to read and validate the bound or staged source. */
export function packageDeliveryDir(dir: string, item: ResolvedPackage) {
  return item.kind === "local" ? item.dir : join(dir, pulledFolder, item.entry.name);
}

export function snapshotPath(dir: string) {
  return bound?.dir === dir ? join(bound.folder, "references.json") : join(dir, ".office/resolved/references.json");
}
