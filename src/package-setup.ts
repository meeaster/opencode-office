// One package's setup, run in this process: what it registered. Sync and package commands both
// call it; each decides what to do with the result.
import * as v from "valibot";
import type { Registry, RegistryEntry, SettingValue } from "../sdk/index.ts";
import { namedEntry } from "./reference-snapshot.ts";
import type { PackageManifest } from "./schema.ts";

export type Registered = {
  /** The registries this package provides, by ID. */
  registries: Map<string, Registry<RegistryEntry>>;
  /** What it added to any registry, not yet parsed by the provider. */
  additions: { id: string; value: RegistryEntry }[];
};

type SetupInput = {
  name: string;
  manifest: PackageManifest;
  /** The validated settings with defaults applied, as `ctx.settings`. */
  settings: Record<string, SettingValue>;
};

/** Runs `setup` and gathers its registrations. Throws when setup or a registration call throws. */
export async function registerPackage({ name, manifest, settings }: SetupInput): Promise<Registered> {
  const registries = new Map<string, Registry<RegistryEntry>>();
  const additions: Registered["additions"] = [];

  await manifest.setup?.({
    settings: structuredClone(settings),
    registry(handle) {
      if (!handle.id.startsWith(`${name}.`) || !/^[a-z0-9-]+\.[a-z0-9-]+$/.test(handle.id) || !v.is(v.function(), handle.parse) || registries.has(handle.id)) throw new Error(`invalid or duplicate registry ${handle.id}`);
      registries.set(handle.id, handle);
    },
    add(handle, value) {
      // Entries are named records until registries take other shapes.
      if (!v.is(namedEntry, value)) throw new Error("expected a named registry entry");
      additions.push({ id: handle.id, value: structuredClone(value) });
    },
  });

  return { registries, additions };
}
