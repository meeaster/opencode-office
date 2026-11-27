// A built-in package's plugin as an office holds it, for the packages' plugin tests: the package's
// files with its plugin bundled into the one index.js an office gets, in a scratch office whose
// applied settings the test writes, and loaded through a link as OpenCode loads it.
import { cpSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AppliedSettings } from "../../sdk/applied-settings.ts";
import { writeAppliedSnapshot } from "../../src/applied-settings.ts";
import { bundlePlugin, toolPath } from "../../src/tool.ts";

/**
 * Makes `office` (a new folder) an office holding the built-in package `name`, with `packages` as
 * its applied settings, and returns the plugin's default export, imported through
 * `.opencode/plugins/<name>` from a fresh copy, so each call runs the module anew. The package is
 * a local one, in `packages/<name>`, or with `installed`, one sync pulled in: in a package set
 * under `.office/generations/`, reached through `.office/current` as sync leaves it.
 */
export async function officePlugin<Plugin>(name: string, office: string, packages: Record<string, AppliedSettings>, { installed = false } = {}): Promise<Plugin> {
  const packageDir = installed ? join(office, ".office/generations", generation, "packages", name) : join(office, "packages", name);

  mkdirSync(join(packageDir, "plugin"), { recursive: true });
  writeFileSync(join(office, "office.yaml"), `name: test\npackages: [${name}]\n`);
  cpSync(toolPath(`packages/${name}/skills`), join(packageDir, "skills"), { recursive: true });
  writeFileSync(join(packageDir, "plugin/index.js"), await bundlePlugin(name));
  writeAppliedSnapshot(office, packages);
  mkdirSync(join(office, ".opencode/plugins"), { recursive: true });

  if (installed) {
    symlinkSync(`generations/${generation}`, join(office, ".office/current"));
    symlinkSync("current/packages", join(office, ".office/packages"));
  }

  symlinkSync(`../../${installed ? ".office/" : ""}packages/${name}/plugin`, join(office, ".opencode/plugins", name));

  const loaded: { default: Plugin } = await import(join(office, ".opencode/plugins", name, "index.js"));

  return loaded.default;
}

const generation = "g-00000000-0000-4000-8000-000000000001";

/**
 * Switches an office `officePlugin` made with `installed` to a new package set, as sync does:
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
