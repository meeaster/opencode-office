import { Registry, type RegistryEntry } from "@office/sdk";

export type Requirement = { name: string; minimumVersion: string; hostOnly?: boolean };

export const requirements = Registry.define<Requirement>({
  id: "tooling.requirements",
  key: entry => entry.name,
  keyScope: "package",
  parse({ name, minimumVersion, hostOnly }: RegistryEntry): Requirement {
    if (typeof name !== "string") throw new Error("a tool requirement needs a name");

    if (!/^[A-Za-z0-9_.:@/-]+$/.test(name) || typeof minimumVersion !== "string" || !/^v?\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?$/.test(minimumVersion)) throw new Error(`invalid exact tool requirement ${name}@${minimumVersion}`);

    if (hostOnly !== undefined && typeof hostOnly !== "boolean") throw new Error("hostOnly must be boolean");

    return hostOnly === undefined ? { name, minimumVersion } : { name, minimumVersion, hostOnly };
  },
});
