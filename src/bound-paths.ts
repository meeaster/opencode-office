import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { ResolvedPackage } from "./loader/packages.ts";

export const pulledFolder = ".office/packages";

/** Only an evaluator binds paths. Controllers and external link planners use the
 * stable discovery path. A process never evaluates two source views. */
let bound: { dir: string; folder: string; unavailable: ReadonlySet<string> } | undefined;

/** Binds this process to the package set in `folder`, whose sync rejected the `unavailable` packages. */
export function bindPaths(dir: string, folder: string, unavailable: ReadonlySet<string> = new Set()) {
  if (bound && (bound.dir !== dir || bound.folder !== folder)) throw new Error("cannot change package generation in an evaluating process");
  bound = { dir, folder, unavailable };
}

/** The packages the bound set's sync rejected; none in a process not bound to a set. */
export function boundUnavailable(dir: string): ReadonlySet<string> {
  return bound?.dir === dir ? bound.unavailable : new Set();
}

export function packageRoot(dir: string) {
  return bound?.dir === dir ? join(bound.folder, "packages") : join(dir, pulledFolder);
}

/** Paths that outlive evaluation (e.g. mise hooks) must follow the published package.
 * Keep using item.dir to read and validate the bound or staged source. */
export function packageDeliveryDir(dir: string, item: ResolvedPackage) {
  return item.kind === "local" ? item.dir : join(dir, pulledFolder, item.entry.name);
}

/** The set's link folder: `node_modules/@office/<name>` for each package that loads. */
export function packageLinks(folder: string) {
  return join(folder, "node_modules/@office");
}

/**
 * Where an evaluator loads a package's definition from: through its bound set's link, so the
 * package's `@office/…` imports resolve inside that set (the compiled reader and admission
 * children preserve symlinks). A process not bound to a set loads from the package's folder. A
 * process loads a package only one way, so no module is evaluated twice; `linkProblem` is checked
 * before the first import, so a bound process never meets a missing link here.
 */
export function definitionRoot(dir: string, item: ResolvedPackage) {
  return bound?.dir === dir ? join(packageLinks(bound.folder), item.entry.name) : item.dir;
}

/** In a process bound to a set, what is wrong with the set's link to `item`; undefined when it is right or the process isn't bound. */
export function linkProblem(dir: string, item: ResolvedPackage): string | undefined {
  return bound?.dir === dir ? setLinkProblem(bound.folder, item) : undefined;
}

/** What is wrong with the link to `item` in the package set `folder`: missing, or to another folder. */
function setLinkProblem(folder: string, item: ResolvedPackage): string | undefined {
  const link = join(packageLinks(folder), item.entry.name);

  if (!lstatSync(link, { throwIfNoEntry: false })) return "selected since the last sync; run office sync";

  try {
    if (realpathSync(link) === realpathSync(item.dir)) return undefined;
  } catch { /* a dangling link or a missing folder is a wrong link too */ }

  return "the package set links it to a different folder; run office sync";
}
