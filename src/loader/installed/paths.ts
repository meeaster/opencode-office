import { lstatSync } from "node:fs";
import { join } from "node:path";
import { OfficeError } from "../../office.ts";

export const installedRoot = (dir: string) => join(dir, ".office");
export const selectionFile = (dir: string) => join(installedRoot(dir), "selection.json");

export function checkPath(path: string, type: "folder" | "file") {
  const entry = lstatSync(path, { throwIfNoEntry: false });

  if (entry && !(type === "folder" ? entry.isDirectory() : entry.isFile())) {
    throw new OfficeError(`cannot use ${path}: expected a real ${type}; move it aside and run office sync --packages`);
  }

  return entry;
}

export function checkInstalled(dir: string) {
  const root = installedRoot(dir);

  for (const folder of ["", "packages", "node_modules", "node_modules/@office", "withdrawals", "resolved"]) {
    checkPath(join(root, folder), "folder");
  }

  for (const file of ["selection.json", "unavailable.json"]) checkPath(join(root, file), "file");
}

export function hasPublishedSet(dir: string) {
  return checkPath(selectionFile(dir), "file") !== undefined;
}

/** Identifies the selection already on disk, even when two syncs use identical pins. */
export function installedSelection(dir: string) {
  const entry = lstatSync(selectionFile(dir), { throwIfNoEntry: false, bigint: true });

  if (entry) return `${entry.ino}:${entry.ctimeNs}`;
}
