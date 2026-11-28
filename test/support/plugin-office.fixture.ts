import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AppliedSettings } from "../../sdk/applied-settings.ts";
import { writeAppliedSnapshot } from "../../src/applied-settings.ts";
import { bundlePlugin, toolPath } from "../../src/tool.ts";

/** A delivered plugin copy and a separate published package set holding its assets. */
export async function officePlugin<Plugin>(name: string, office: string, packages: Record<string, AppliedSettings>): Promise<Plugin> {
  const packageDir = join(office, ".office/packages", name);
  const plugin = join(office, ".opencode/plugins", name);

  mkdirSync(packageDir, { recursive: true });
  mkdirSync(plugin, { recursive: true });
  writeFileSync(join(office, "office.yaml"), `name: test\npackages: [${name}]\n`);
  cpSync(toolPath(`packages/${name}/skills`), join(packageDir, "skills"), { recursive: true });
  writeFileSync(join(plugin, "index.js"), await bundlePlugin(name));
  writeAppliedSnapshot(office, packages);

  const loaded: { default: Plugin } = await import(join(plugin, "index.js"));

  return loaded.default;
}

export function replacePackage(office: string, name: string, change: (folder: string) => void): void {
  const installed = join(office, ".office/packages", name);
  const temporary = mkdtempSync(join(office, ".office/stage-"));
  const next = join(temporary, name);

  try {
    cpSync(installed, next, { recursive: true });
    change(next);
    renameSync(installed, join(temporary, "retired"));
    renameSync(next, installed);
  } finally {
    rmSync(temporary, { recursive: true });
  }
}

/** Waits until `expected` holds or two seconds pass, then long enough for a stray watcher event to arrive. */
export async function settle(expected: () => boolean): Promise<void> {
  for (let waited = 0; waited < 2000 && !expected(); waited += 20) await Bun.sleep(20);
  await Bun.sleep(100);
}
