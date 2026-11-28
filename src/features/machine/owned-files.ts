import { existsSync, lstatSync, readFileSync, readlinkSync, unlinkSync } from "node:fs";

import { failure, type Change } from "../../lib/change.ts";
import { sha256 } from "../../lib/hash.ts";
import type { MachineFile } from "./record.ts";

/** A recorded file against what is on disk. */
export type FileState = "present" | "changed" | "missing" | "dangling";

export function fileState(file: MachineFile): FileState {
  let stats;

  try {
    stats = lstatSync(file.path);
  } catch {
    return "missing";
  }

  if (file.kind === "link") {
    if (!stats.isSymbolicLink() || readlinkSync(file.path) !== file.target) return "changed";

    return existsSync(file.path) ? "present" : "dangling";
  }

  return stats.isFile() && sha256(readFileSync(file.path)) === file.sha256 ? "present" : "changed";
}

/** Whether anything, a dangling link included, is at `path`. */
export function occupied(path: string): boolean {
  try {
    lstatSync(path);

    return true;
  } catch {
    return false;
  }
}

/** Whether a recorded file is gone, and what to say about it. */
type Removal = { removed: boolean; line: Change | undefined };

/** True if the feature handled the removal; false to remove an ordinary owned file. */
export type RemoveManagedFile = (file: MachineFile, missing: boolean) => boolean;

/** Removes a recorded file that is still as the office wrote it. A changed one stays, reported. */
export function removeFile(file: MachineFile, why: string, removeManagedFile: RemoveManagedFile): Removal {
  const state = fileState(file);

  if (state === "changed") return { removed: false, line: failure(`FAILED to remove ${file.path}: it changed since office wrote it, so it stays; delete it yourself`) };

  try {
    if (removeManagedFile(file, state === "missing")) return { removed: true, line: `removed ${file.path}, ${why}` };
  } catch (error) {
    return { removed: false, line: failure(`FAILED to remove ${file.path}: ${error instanceof Error ? error.message : String(error)}`) };
  }

  if (state === "missing") return { removed: true, line: undefined };

  unlinkSync(file.path);

  return { removed: true, line: `removed ${file.path}, ${why}` };
}
