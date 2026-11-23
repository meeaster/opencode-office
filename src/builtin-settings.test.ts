// Each built-in's settings schema accepts the office.yaml settings its README shows, resolving them
// as the earlier forms did, and its setup does what those settings ask.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { project } from "../standard/mise-integration/projection.ts";
import { loadOffice } from "./office.ts";
import { registerPackage } from "./package-setup.ts";
import { type InstalledPackage, readPackage } from "./packages.ts";
import { defaultOffSetting, type SettingValue } from "./schema.ts";

const office = mkdtempSync(join(tmpdir(), "office-builtin-settings-"));

afterAll(() => rmSync(office, { recursive: true, force: true }));

/** The checkout's copy of built-in `name`, read with `settings` from office.yaml. */
function read(name: string, settings: Record<string, SettingValue>): InstalledPackage {
  writeFileSync(join(office, "office.yaml"), "name: t\n");
  const result = readPackage(loadOffice(office), { entry: { name, settings, cron: {}, source: undefined }, kind: "local", dir: join(import.meta.dir, "../packages", name) });

  if (!result.ok) throw new Error(result.errors.join("\n"));

  return result.value;
}

test("aws-emulator: ports, a storage mode and no source reference", async () => {
  const item = read("aws-emulator", { port: 4600, ui_port: 4501, storage: "persistent", source_reference: false });

  expect(item.settings).toEqual({ port: 4600, ui_port: 4501, storage: "persistent", source_reference: false });
  expect(read("aws-emulator", {}).settings).toEqual({ port: 4566, ui_port: 4500, storage: "memory", source_reference: true });
  // Turned off, it adds no reference; on by default, it adds Floci's.
  const ids = async (pkg: InstalledPackage) => (await registerPackage({ name: pkg.entry.name, manifest: pkg.manifest, settings: pkg.settings })).additions.map(row => row.value.name);

  expect(await ids(item)).toEqual(["aws-cli"]);
  expect(await ids(read("aws-emulator", {}))).toEqual(["aws-cli", "floci"]);
});

test("browser: tool profiles, Browse off and system Chrome on; its recipe's setting defaults to off", async () => {
  const item = read("browser", { agent_browser_tools: "core,network,debug", browse: false, system_chrome: true });

  expect(item.settings).toEqual({ agent_browser_tools: "core,network,debug", browse: false, system_chrome: true });
  expect(read("browser", {}).settings).toEqual({ agent_browser_tools: "core", browse: true, system_chrome: false });
  expect(defaultOffSetting(item.manifest.settings, "system_chrome")).toBe(true);
  const { additions } = await registerPackage({ name: "browser", manifest: item.manifest, settings: item.settings });

  // The contributed recipe passes the default-off rule as sync projects it.
  expect(project(item, additions).system?.setting).toBe("system_chrome");
  // Projection reads claims without changing the definition.
  expect(item.manifest.system).toBeUndefined();
});

test("office: more ignored skill folders, and the Claude app's synced skills loaded", () => {
  expect(read("office", { ignore_skill_folders: ["~/.agents/skills/unwanted"], ignore_claude_synced_skills: false }).settings).toEqual({ ignore_skill_folders: ["~/.agents/skills/unwanted"], ignore_claude_synced_skills: false });
  expect(read("office", {}).settings).toEqual({ ignore_claude_synced_skills: true, ignore_skill_folders: [] });
});

test("design: a port, an address and the Executor app with OAuth off", () => {
  expect(read("design", { port: 41462, url: "https://doop.example.ts.net", executor_app: true, oauth: false }).settings).toEqual({ port: 41462, url: "https://doop.example.ts.net", executor_app: true, oauth: false });
  expect(read("design", {}).settings).toEqual({ port: 41441, url: "", executor_app: false, oauth: true });
});

test("artifact-share: the site's address is required; a title and theme replace the defaults", () => {
  expect(read("artifact-share", { url: "https://owner.github.io/site", title: "Notes", theme: "dracula" }).settings).toEqual({ url: "https://owner.github.io/site", title: "Notes", theme: "dracula" });
  expect(read("artifact-share", { url: "https://owner.github.io/site" }).settings).toEqual({ url: "https://owner.github.io/site", title: "Artifacts", theme: "paper" });
  expect(() => read("artifact-share", {})).toThrow("packages.artifact-share.settings.url: is required");
});

test("knowledge, references, tooling and mise-integration accept no settings", () => {
  for (const name of ["knowledge", "references", "tooling", "mise-integration"]) {
    expect(read(name, {}).settings).toEqual({});
    expect(() => read(name, { extra: true })).toThrow(`packages.${name}.settings.extra: the package declares no such setting`);
  }
});
