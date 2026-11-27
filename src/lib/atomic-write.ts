import { randomBytes } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/**
 * Replaces `path` whole by rename. The temporary is written beside it, or in `staging`, a folder on
 * the same filesystem, when a leftover beside it would be in the way (as in a committed folder).
 */
export function atomicWrite(path: string, content: string | Buffer, mode = 0o600, staging = dirname(path)): void {
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(staging, { recursive: true });

  const temporary = join(staging, `${basename(path)}.${randomBytes(8).toString("hex")}.new`);

  try {
    writeFileSync(temporary, content, { mode, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
