import { dlopen } from "bun:ffi";

// BSD flock locks an open file description. The last close (including after a
// process death) releases it; inherited descriptors share the lock.
function load() {
  if (process.platform !== "linux" && process.platform !== "darwin") throw new Error("Office file leases require flock on Linux or macOS");
  const path = process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6";

  return dlopen(path, { flock: { args: ["i32", "i32"], returns: "i32" } });
}

let libc: ReturnType<typeof load> | undefined;

export function tryFileLock(fd: number, shared: boolean) {
  libc ??= load();

  return libc.symbols.flock(fd, (shared ? 1 : 2) | 4) === 0;
}
