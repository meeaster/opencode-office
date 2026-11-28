import * as v from "valibot";
import type { Integration, Registry, RegistryEntry, SettingValue, SetupContext } from "../../../sdk/index.ts";
import { definitionRoot, packageDeliveryDir } from "../../bound-paths.ts";
import type { Office } from "../../office.ts";
import type { PackageManifest } from "../sources/manifest-schema.ts";
import { settingValue } from "../../schema.ts";
import { loadIntegrations, selectedIntegrations } from "./integrations.ts";
import type { InstalledPackages } from "./inventory.ts";

/** A registry entry: a JSON object, which sync and commands can copy and compare. */
const mapping = v.object({});
export const jsonObject = v.pipe(settingValue, v.check(value => !Array.isArray(value) && v.is(mapping, value)));

export type Registered = {
  /** The registries this package provides, by ID. */
  registries: Map<string, Registry<RegistryEntry>>;
  /** What it added to any registry, not yet parsed by the provider. */
  additions: { id: string; value: RegistryEntry }[];
};

type SetUp = { name: string; namespace: string; settings: Record<string, SettingValue>; folder: string; root: string; registered: Registered };

/** With any invalid settings or a blocked inventory, no setup runs. */
export async function registerPackages(office: Pick<Office, "dir">, inventory: InstalledPackages, onProblem: (name: string, cause: unknown) => void): Promise<SetUp[]> {
  if (inventory.blocked || inventory.invalidSettings.length) return [];

  const setUp: SetUp[] = [];

  for (const item of inventory.installed) {
    const name = item.entry.name;
    const folder = definitionRoot(office.dir, item);

    try {
      const integrations = loadIntegrations(folder, selectedIntegrations(item.integrations, inventory));
      const registered = await registerPackage({ name, manifest: item.manifest, settings: item.settings, integrations, selected: inventory.selected });

      setUp.push({ name, namespace: item.manifest.namespace, settings: item.settings, folder, root: packageDeliveryDir(office.dir, item), registered });
    } catch (error) {
      onProblem(name, error);
    }
  }

  return setUp;
}

type SetupInput = {
  name: string;
  manifest: PackageManifest;
  /** The validated settings with defaults applied, as `ctx.settings`. */
  settings: Record<string, SettingValue>;
  /** Its integrations whose provider is selected, whose setups run after its own, adding as this package. */
  integrations: readonly Integration[];
  /** The packages the office selects, the required built-ins included, for `ctx.providers.selected`. */
  selected: ReadonlySet<string>;
};

/**
 * Runs `setup`, then each given integration's, and gathers their registrations. Throws when a setup
 * or a registration call throws.
 */
async function registerPackage({ name, manifest, settings, integrations, selected }: SetupInput): Promise<Registered> {
  const registries = new Map<string, Registry<RegistryEntry>>();
  const additions: Registered["additions"] = [];

  const ctx: SetupContext = {
    settings: structuredClone(settings),
    registry(handle) {
      if (!handle.id.startsWith(`${name}.`) || !/^[a-z0-9-]+\.[a-z0-9-]+$/.test(handle.id) || !v.is(v.function(), handle.parse) || registries.has(handle.id)) throw new Error(`invalid or duplicate registry ${handle.id}`);
      registries.set(handle.id, handle);
    },
    add(handle, value) {
      if (!v.is(jsonObject, value)) throw new Error(`${handle.id}: an entry must be a JSON object`);
      additions.push({ id: handle.id, value: structuredClone(value) });
    },
    providers: {
      selected(provider) {
        if (!v.is(v.string(), provider) || provider.startsWith("@")) throw new Error(`providers.selected: name a package as office.yaml does, such as executor, not ${JSON.stringify(provider)}`);

        return selected.has(provider);
      },
    },
  };

  await manifest.setup?.(ctx);

  for (const integration of integrations) await integration.setup({ settings: structuredClone(settings), add: ctx.add });

  return { registries, additions };
}
