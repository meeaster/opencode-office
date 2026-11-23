import { Registry, type RegistryEntry } from "@office/sdk";

export type Requirement = { name: string; minimumVersion: string; hostOnly?: boolean };

export const requirements = Registry.define<Requirement>({
  identity: "package",
  id: "tooling.requirements",
  parse({ name, minimumVersion, hostOnly }: RegistryEntry): Requirement {
    if (!/^[A-Za-z0-9_.:@/-]+$/.test(name) || typeof minimumVersion !== "string" || !/^v?\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?$/.test(minimumVersion)) throw new Error(`invalid exact tool requirement ${name}@${minimumVersion}`);

    if (hostOnly !== undefined && typeof hostOnly !== "boolean") throw new Error("hostOnly must be boolean");

    return hostOnly === undefined ? { name, minimumVersion } : { name, minimumVersion, hostOnly };
  },
});
