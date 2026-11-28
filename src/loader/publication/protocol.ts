import * as v from "valibot";
import { changeSchema } from "../../lib/change.ts";
import type { Office } from "../../office.ts";
import type { LockedPackage } from "../../lock-schema.ts";
import type { Candidate } from "../generation/storage.ts";

export type Admission = {
  transaction: Candidate;
  office: Office;
  yaml: string;
  /** The candidate `packages:` section of office.lock, published with office.yaml (a Map, as an object here). */
  packages: Record<string, LockedPackage>;
  validate: string[];
  rejected: string[];
  exclude: boolean;
  apply: boolean;
  tracked: boolean;
};

/**
 * Three outcomes: rejected before publishing (`published` false, the pointer where it was), published
 * and applied, or published with a failed application (FAILED lines). `recorded` is whether the
 * applied references file was written after the switch; without it no reference checkout is touched.
 * `stopped` is a package's sync function throwing: a full sync runs none of its later steps.
 * `committed`, the folders packages declare committed, and `excluded`, the paths their sync
 * functions exclude, are set only when the set was applied with every package loaded and no sync
 * function threw; without them the exclude block is left as it is, and a full sync runs no
 * packages' full-sync work.
 */
export const outcomeSchema = v.object({
  published: v.boolean(),
  recorded: v.optional(v.boolean()),
  stopped: v.optional(v.boolean()),
  excluded: v.optional(v.array(v.string())),
  committed: v.optional(v.array(v.string())),
  lines: v.array(changeSchema),
  rejected: v.optional(v.array(v.string())),
  generation: v.optional(v.string()),
});

export type Outcome = v.InferOutput<typeof outcomeSchema>;
