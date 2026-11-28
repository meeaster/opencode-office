import { type AppliedState, appliedState } from "../../applied-settings.ts";
import { contributedAssets } from "../../features/opencode/assets.ts";
import { withPluginPlan } from "../../features/opencode/delivery.ts";
import type { Gathered } from "../../gather.ts";
import type { Office, Repository } from "../../office.ts";
import type { LoadedPlugin } from "./server.ts";

/** Prints one check; "warn" is shown but doesn't fail `office check`. */
export type Report = (ok: boolean | "warn", name: string, detail: string) => void;

/**
 * What one `office check` gathered, shared by every check: the packages with their plugin plan
 * (what they register now when the gathering is complete, else what the last sync applied),
 * `claims` only when the gathering is complete (what every package claims is known), and the
 * references to compare checkouts with: the gathering's, or with a package broken office.yaml's own.
 */
export type Context = { gathered: Gathered; loaded: ReturnType<typeof withPluginPlan>; claims?: Gathered; references: readonly Repository[]; applied: AppliedState };

export function context(office: Office, gathered: Gathered): Context {
  return {
    gathered, loaded: withPluginPlan(office, gathered.inventory, gathered.complete ? contributedAssets(gathered.entries) : undefined),
    claims: gathered.complete ? gathered : undefined,
    references: gathered.complete ? gathered.references : office.references,
    // Read once, for every report about what sessions get; check never writes it.
    applied: appliedState(office),
  };
}

/** The root session's skills and plugins as the server listed them. */
export type RootAnswer = { skills: { id: string; path: string }[]; plugins: LoadedPlugin[] };
