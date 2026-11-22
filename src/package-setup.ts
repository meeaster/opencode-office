// One package's setup, run in this process: what it registered. Sync and package commands both
// call it; each decides what to do with the result.
import * as v from "valibot";
import type { Collection, CollectionEntry, SettingValue } from "../packages/office/package-context.ts";
import { commandRegistration, type RegisteredCommand } from "./command-table.ts";
import { runPackageSetup } from "./package-definition.ts";
import { namedEntry } from "./reference-snapshot.ts";
import type { PackageManifest } from "./schema.ts";

export type Registered = {
  /** The collections this package provides, by ID. */
  collections: Map<string, Collection<CollectionEntry>>;
  /** What it added to any collection, not yet parsed by the provider. */
  additions: { id: string; value: CollectionEntry }[];
  commands: RegisteredCommand[];
  /** Command registrations that failed validation, one message each. */
  invalid: string[];
  scalars: Record<string, string | number | boolean>;
};

type SetupInput = {
  name: string;
  manifest: PackageManifest;
  /** The entry's settings in office.yaml. */
  overrides: Readonly<Record<string, SettingValue>>;
  /** The settings with defaults applied, as `ctx.settings`. */
  settings: Record<string, SettingValue>;
};

/** Runs `setup` and gathers its registrations. Throws when setup or a registration call throws. */
export async function registerPackage({ name, manifest, overrides, settings }: SetupInput): Promise<Registered> {
  const collections = new Map<string, Collection<CollectionEntry>>();
  const additions: Registered["additions"] = [];
  const commands: RegisteredCommand[] = [];
  const invalid: string[] = [];

  const { scalars } = await runPackageSetup(manifest, overrides, {
    settings: structuredClone(settings),
    collection(handle) {
      if (!handle.id.startsWith(`${name}.`) || !/^[a-z0-9-]+\.[a-z0-9-]+$/.test(handle.id) || !v.is(v.function(), handle.parse) || collections.has(handle.id)) throw new Error(`invalid or duplicate collection ${handle.id}`);
      collections.set(handle.id, handle);
    },
    command(input) {
      const read = commandRegistration(input);

      if (read.ok) commands.push(read.value);
      else invalid.push(`package ${name}: command: ${read.errors.join("; ")}`);
    },
    add(handle, value) {
      // Accept shipped one-argument registrations from existing package definitions.
      if (arguments.length === 1 && "registry" in handle && v.is(v.string(), handle.registry) && "value" in handle) {
        if (!v.is(namedEntry, handle.value)) throw new Error("expected a named collection entry");
        additions.push({ id: handle.registry, value: structuredClone(handle.value) });
      } else {
        if (!v.is(namedEntry, value)) throw new Error("expected a named collection entry");
        additions.push({ id: handle.id, value: structuredClone(value) });
      }
    },
  });

  return { collections, additions, commands, invalid, scalars };
}
