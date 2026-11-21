import { dlopen } from "bun:ffi";
import { closeSync, constants, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { OfficeError } from "./office.ts";
import { referenceFile } from "./reference-snapshot.ts";

// BSD flock (Linux and macOS) locks an open file description, not a process.
// dup/fork/exec can share it. Never LOCK_UN or unlink the file: Git may still
// own a duplicate after Office dies. The last close releases it in the kernel.
function loadLibc() {
  if (process.platform !== "linux" && process.platform !== "darwin") throw new OfficeError("reference checkouts need flock on Linux or macOS");
  const path = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";

  try {
    return dlopen(path, { flock: { args: ["i32", "i32"], returns: "i32" } });
  } catch (error) {
    throw new OfficeError(`cannot protect reference checkouts with flock from ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let libc: ReturnType<typeof loadLibc> | undefined;

export function tryFileLock(fd: number, shared: boolean) {
  libc ??= loadLibc();

  return libc.symbols.flock(fd, (shared ? 1 : 2) | 4) === 0;
}

/** Open first so the caller's `using` covers failed admission as well as a completed checkout. */
export function openCheckoutLease(dir: string, name: string) {
  const folder = join(dir, dirname(referenceFile), "checkout-leases");
  mkdirSync(folder, { recursive: true });
  const fd = openSync(join(folder, `${encodeURIComponent(name)}.lock`), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);

  return {
    fd,
    acquire() {
      if (!tryFileLock(fd, false)) {
        throw new OfficeError(`reference ${name}: checkout lease unavailable; retry after the active Git checkout finishes (the filesystem must support flock)`);
      }
    },
    [Symbol.dispose]: () => closeSync(fd),
  };
}
