import { lstatSync, readdirSync, realpathSync, renameSync, rmdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { type Office, OfficeError } from "./office.ts";

export function oldExecutorAppDirs(office: Office): string[] {
  return ["", ...office.desks.map(desk => desk.name)].flatMap(scope => {
    const old = join(scope, "executor/apps");

    return lstatSync(join(office.dir, old), { throwIfNoEntry: false }) ? [old] : [];
  });
}

/** Check every destination before moving any source or scaffolding a desk. */
export function moveExecutorAppDirs(office: Office): string[] {
  const root = realpathSync(office.dir);

  const moves = oldExecutorAppDirs(office).map(old => {
    const from = join(root, old);
    const parent = dirname(from);
    const target = join(dirname(dirname(old)), "executor-apps");
    const to = join(root, target);

    if (!lstatSync(from).isDirectory() || realpathSync(from) !== from) throw new OfficeError(`${old} must be a real directory to migrate; move its sources to ${target} manually`);

    if (lstatSync(to, { throwIfNoEntry: false })) throw new OfficeError(`both ${old} and ${target} exist; reconcile them in ${target}, then run office sync again`);

    return { from, to, parent, old, target };
  });

  return moves.map(({ from, to, parent, old, target }) => {
    renameSync(from, to);

    if (readdirSync(parent).length === 0) rmdirSync(parent);

    return `moved ${old}/ to ${target}/`;
  });
}
