import { tryFileLock } from "./file-lock.ts";
import { closeSync, constants, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import { OfficeError } from "./office.ts";
import { referenceFile } from "./reference-snapshot.ts";

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
