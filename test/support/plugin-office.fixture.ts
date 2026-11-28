import { cpSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AppliedSettings } from "../../sdk/applied-settings.ts";
import { writeAppliedSnapshot } from "../../src/applied-settings.ts";
import { bundlePlugin, toolPath } from "../../src/tool.ts";

/** A delivered plugin copy and a separate published package set holding its assets. */
export async function officePlugin<Plugin>(name: string, office: string, packages: Record<string, AppliedSettings>): Promise<Plugin> {
  const packageDir = join(office, ".office/generations", generation, "packages", name);
  const plugin = join(office, ".opencode/plugins", name);

  mkdirSync(packageDir, { recursive: true });
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(office, "office.yaml"), `name: test\npackages: [${name}]\n`);
  cpSync(toolPath(`packages/${name}/skills`), join(packageDir, "skills"), { recursive: true });
  writeFileSync(join(plugin, "index.js"), await bundlePlugin(name));
  writeAppliedSnapshot(office, packages);
  symlinkSync(`generations/${generation}`, join(office, ".office/current"));
  symlinkSync("current/packages", join(office, ".office/packages"));

  const loaded: { default: Plugin } = await import(join(plugin, "index.js"));

  return loaded.default;
}

const generation = "g-00000000-0000-4000-8000-000000000001";

/**
 * Switches the fixture office to a new package set, as sync does:
 * a copy of the active one, changed by `change`, then `.office/current` renamed onto it.
 */
export function switchPackageSet(office: string, change: (packages: string) => void): void {
  const next = "g-00000000-0000-4000-8000-000000000002";
  const generations = join(office, ".office/generations");

  cpSync(join(generations, generation), join(generations, next), { recursive: true });
  change(join(generations, next, "packages"));
  symlinkSync(`generations/${next}`, join(office, ".office/current.new"));
  renameSync(join(office, ".office/current.new"), join(office, ".office/current"));
}

/** Waits until `expected` holds or two seconds pass, then long enough for a stray watcher event to arrive. */
export async function settle(expected: () => boolean): Promise<void> {
  for (let waited = 0; waited < 2000 && !expected(); waited += 20) await Bun.sleep(20);
  await Bun.sleep(100);
}
