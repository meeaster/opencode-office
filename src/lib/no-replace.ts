import { dlopen, type Pointer, read } from "bun:ffi";
import { constants } from "node:os";

/** A failed no-replace rename; `code` is the errno name, such as EEXIST. */
export class RenameError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

// The FFI boundary: Bun types a returned pointer as number, bigint or null, but reads only a number.
const errnoAt = (at: Pointer | bigint | null) => typeof at === "number" ? read.i32(at) : -1;

// rename(2) silently replaces an empty directory. Linux renameat2(RENAME_NOREPLACE) and macOS
// renamex_np(RENAME_EXCL) check and rename in one kernel step: they fail with EEXIST instead.
function loadLibc() {
  if (process.platform === "linux") {
    const libc = dlopen("libc.so.6", {
      renameat2: { args: ["i32", "ptr", "i32", "ptr", "u32"], returns: "i32" },
      __errno_location: { args: [], returns: "ptr" },
    });

    const AT_FDCWD = -100, RENAME_NOREPLACE = 1;

    return {
      rename: (from: Buffer, to: Buffer) => libc.symbols.renameat2(AT_FDCWD, from, AT_FDCWD, to, RENAME_NOREPLACE),
      errno: () => errnoAt(libc.symbols.__errno_location()),
    };
  }

  if (process.platform === "darwin") {
    const libc = dlopen("/usr/lib/libSystem.B.dylib", {
      renamex_np: { args: ["ptr", "ptr", "u32"], returns: "i32" },
      __error: { args: [], returns: "ptr" },
    });

    const RENAME_EXCL = 4;

    return {
      rename: (from: Buffer, to: Buffer) => libc.symbols.renamex_np(from, to, RENAME_EXCL),
      errno: () => errnoAt(libc.symbols.__error()),
    };
  }

  throw new RenameError("ENOSYS", `no-replace rename is unavailable on ${process.platform}`);
}

let libc: ReturnType<typeof loadLibc> | undefined;

/**
 * Renames `from` to `to` only while nothing at all is at `to`, atomically. Throws a RenameError:
 * EEXIST when anything (even an empty directory) is there, ENOENT when `from` is missing, and
 * EINVAL or ENOSYS when the filesystem or platform cannot make the guarantee.
 */
export function renameNoReplace(from: string, to: string): void {
  try {
    libc ??= loadLibc();
  } catch (error) {
    if (error instanceof RenameError) throw error;
    throw new RenameError("ENOSYS", `no-replace rename is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (libc.rename(Buffer.from(`${from}\0`), Buffer.from(`${to}\0`)) === 0) return;
  const errno = libc.errno();
  const code = Object.entries(constants.errno).find(([, value]) => value === errno)?.[0] ?? `errno ${errno}`;

  throw new RenameError(code, `${code}: cannot rename ${from} to ${to} without replacing`);
}
