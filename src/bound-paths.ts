import { join } from "node:path";
import { lstatSync, readlinkSync } from "node:fs";

/** Only an evaluator binds paths. Controllers and external link planners use the
 * stable discovery path. A process never evaluates two source views. */
let bound: { dir: string; folder: string; snapshot: string } | undefined;

export function bindPaths(dir: string, folder: string, candidate = false) {
  if (bound && (bound.dir !== dir || bound.folder !== folder)) throw new Error("cannot change package generation in an evaluating process");
  const bridge = join(dir, ".office/resolved/references.json");
  const canonical = candidate || (lstatSync(bridge, { throwIfNoEntry: false })?.isSymbolicLink() && readlinkSync(bridge) === "../current/references.json");
  bound = { dir, folder, snapshot: canonical ? join(folder, "references.json") : bridge };
}

export function packageRoot(dir: string) {
  return bound?.dir === dir ? join(bound.folder, "packages") : join(dir, ".office/packages");
}

export function snapshotPath(dir: string) {
  return bound?.dir === dir ? bound.snapshot : join(dir, ".office/resolved/references.json");
}
