import { cpSync, existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { openCheckoutLease } from "./checkout-lease.ts";
import type { Office } from "./office.ts";
import { pulledDir } from "./packages.ts";
import type { ReferenceSnapshot } from "./reference-snapshot.ts";

// Shipped v3 references package, identical in the pre-inspect generation. Never use the
// snapshot itself as authority to execute a built-in from a different binary.
export const shippedReferences = "built-in:ebaceb1239d9ab6724f100275dff9ceb954b73c86c7f861db23c20a3a5de0534";

/** Contributors import the new contract from the installed path during collection. Keep the
 * pre-upgrade owner until publication succeeds so a refusal doesn't strand either v3 reader. */
export function preserveV3Owner(office: Office, previous?: ReferenceSnapshot) {
  if (previous?.version !== 3 || !previous.contributors.some(owner => owner.name === "references" && owner.source === shippedReferences && owner.commands)) return;
  const owner = pulledDir(office, "references");
  const lease = openCheckoutLease(office.dir, ".v3-owner-migration");
  let backup: string | undefined;
  let published = false;

  try {
    lease.acquire();

    if (existsSync(owner)) {
      backup = mkdtempSync(join(dirname(owner), ".v3-references-"));
      cpSync(owner, join(backup, "references"), { recursive: true, verbatimSymlinks: true });
    }
  } catch (error) {
    lease[Symbol.dispose]();

    if (backup) rmSync(backup, { recursive: true, force: true });
    throw error;
  }

  return {
    commit() { published = true; },
    [Symbol.dispose]() {
      try {
        if (!backup) return;

        if (!published) {
          rmSync(owner, { recursive: true, force: true });
          renameSync(join(backup, "references"), owner);
        }

        rmSync(backup, { recursive: true, force: true });
      } finally {
        lease[Symbol.dispose]();
      }
    },
  };
}
