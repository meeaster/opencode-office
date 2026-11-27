// Each built-in's settings schema accepts the office.yaml settings its README shows, resolving them
// as the earlier forms did, and its setup does what those settings ask.
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { project } from "../../src/features/mise-integration/projection.ts";
import { loadOffice } from "../../src/office.ts";
import { installedDefinition, type InstalledPackage, type InstalledPackages } from "../../src/loader/definitions/inventory.ts";
import { registerPackages } from "../../src/loader/definitions/registration.ts";
import { schemaSettings } from "../../src/loader/definitions/settings.ts";
import { defaultOffSetting, type SettingValue } from "../../src/schema.ts";
import { toolPath } from "../../src/tool.ts";

const office = mkdtempSync(join(tmpdir(), "office-builtin-settings-"));

afterAll(() => rmSync(office, { recursive: true, force: true }));

/** The checkout's copy of built-in `name`, read with `settings` from office.yaml. */
function read(name: string, settings: Record<string, SettingValue>): InstalledPackage {
  writeFileSync(join(office, "office.yaml"), "name: t\n");
  const item = { entry: { name, settings, source: undefined }, kind: "local" as const, dir: toolPath(`packages/${name}`) };
  const result = installedDefinition(loadOffice(office), item);

  if (!result.ok) throw new Error(result.errors.join("\n"));
  const { manifest, integrations, file } = result.value;
  const validated = schemaSettings(item, manifest, file);

  if (!validated.ok) throw new Error(validated.errors.join("\n"));

  return { ...item, manifest, integrations, settings: validated.value };
}

async function additions(item: InstalledPackage) {
  const inventory: InstalledPackages = { installed: [item], selected: new Set([item.entry.name]), unread: new Set(), problems: [], invalidSettings: [], definitions: new Map() };
  const [setUp] = await registerPackages({ dir: office }, inventory, (_name, cause) => { throw cause; });

  return setUp.registered.additions;
}

test("aws-emulator: ports, a storage mode and no source reference", async () => {
  const item = read("aws-emulator", { port: 4600, ui_port: 4501, storage: "persistent", source_reference: false });

  expect(item.settings).toEqual({ port: 4600, ui_port: 4501, storage: "persistent", source_reference: false });
  expect(read("aws-emulator", {}).settings).toEqual({ port: 4566, ui_port: 4500, storage: "memory", source_reference: true });
  // Turned off, it adds no reference; on by default, it adds Floci's.
  const ids = async (pkg: InstalledPackage) => (await additions(pkg)).flatMap(row => row.id === "opencode.plugins" ? [] : [row.value.name]);

  expect(await ids(item)).toEqual(["aws-cli"]);
  expect(await ids(read("aws-emulator", {}))).toEqual(["aws-cli", "floci"]);
});

test("browser: tool profiles, Browse off and system Chrome on; its recipe's setting defaults to off", async () => {
  const item = read("browser", { agent_browser_tools: "core,network,debug", browse: false, system_chrome: true });

  expect(item.settings).toEqual({ agent_browser_tools: "core,network,debug", browse: false, system_chrome: true });
  expect(read("browser", {}).settings).toEqual({ agent_browser_tools: "core", browse: true, system_chrome: false });
  expect(defaultOffSetting(item.manifest.settings, "system_chrome")).toBe(true);
  const added = await additions(item);

  // The contributed recipe passes the default-off rule as sync projects it.
  expect(project(item, added).system?.setting).toBe("system_chrome");
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

test("cron: the office's own jobs and overrides of packages' jobs; a wrong shape is refused by the schema", () => {
  const settings = {
    jobs: { heartbeat: { schedule: "@hourly", script: "scripts/heartbeat.sh" } },
    overrides: { "package.office.upgrade-tools": { enabled: false }, "package.office.update-references": { schedule: "0 5 * * *" } },
  };

  expect(read("cron", settings).settings).toEqual(settings);
  expect(read("cron", {}).settings).toEqual({});

  for (const [wrong, message] of [
    [{ jobs: { heartbeat: { schedule: "@hourly" } } }, "packages.cron.settings.jobs.heartbeat.script: is required"],
    [{ jobs: { heartbeat: { schedule: "@hourly", script: "../outside.sh" } } }, "packages.cron.settings.jobs.heartbeat.script: must match pattern"],
    [{ jobs: { heartbeat: { schedule: "@hourly\n* * * * *", script: "a.sh" } } }, "packages.cron.settings.jobs.heartbeat.schedule: must match pattern"],
    [{ jobs: { Heartbeat: { schedule: "@hourly", script: "a.sh" } } }, "packages.cron.settings.jobs: property name must be valid"],
    [{ jobs: { constructor: { schedule: "@hourly", script: "a.sh" } } }, "packages.cron.settings.jobs: property name must be valid"],
    [{ overrides: { "package.office.upgrade-tools": { when: "host" } } }, "packages.cron.settings.overrides.package.office.upgrade-tools.when: the package declares no such setting"],
    [{ overrides: { "package.office.upgrade-tools": { enabled: "no" } } }, "packages.cron.settings.overrides.package.office.upgrade-tools.enabled: must be boolean"],
    [{ heartbeat: {} }, "packages.cron.settings.heartbeat: the package declares no such setting"],
  ] as const) {
    expect(() => read("cron", wrong)).toThrow(message);
  }
});
