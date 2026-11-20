import type { Collection, CollectionEntry } from "../office/package-context.ts";

export type Requirement = { name: string; minimumVersion: string; hostOnly?: boolean };

export const requirements = {
  identity: "package",
  id: "tooling.requirements",
  parse({ name, minimumVersion, hostOnly }: CollectionEntry): Requirement {
    if (!/^[A-Za-z0-9_.:@/-]+$/.test(name) || typeof minimumVersion !== "string" || !/^v?\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?$/.test(minimumVersion)) throw new Error(`invalid exact tool requirement ${name}@${minimumVersion}`);

    if (hostOnly !== undefined && typeof hostOnly !== "boolean") throw new Error("hostOnly must be boolean");

    return hostOnly === undefined ? { name, minimumVersion } : { name, minimumVersion, hostOnly };
  },
} satisfies Collection<Requirement>;
