import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "yaml";

import { writeAppliedSnapshot } from "../../../src/applied-settings.ts";
import { officePlugin, replacePackage, settle } from "../../../test/support/plugin-office.fixture.ts";
import { composeProblems, spawnsLabel } from "../../../src/features/compose/services.ts";
import { parseManifest, settingProperties, settingVariable } from "../../../src/loader/sources/manifest-schema.ts";
import definition from "../office.ts";
import type awsPlugin from "../plugin/index.ts";

const packageDir = join(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "aws-emulator-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const composeText = readFileSync(join(packageDir, "compose.yaml"), "utf8");

type Compose = { services: { floci: { environment: Record<string, string>; networks: { default: { aliases: string[] } } } } };

const compose: Compose = parse(composeText);

const manifest = parseManifest("aws-emulator", definition);

test("office accepts the manifest and the compose file", () => {
  if (!manifest.ok) throw new Error(manifest.errors.join("\n"));

  expect(manifest.value.namespace).toBe("floci");
  expect(composeProblems(manifest.value.namespace, composeText)).toEqual([]);
});

test("the spawns label is the namespace Floci labels what it starts with, so office down removes it", () => {
  if (!manifest.ok) throw new Error(manifest.errors.join("\n"));

  expect(manifest.value.spawns?.label).toBe(`floci_namespace=${compose.services.floci.environment.FLOCI_DOCKER_RESOURCE_NAMESPACE}`);
  expect(spawnsLabel(manifest.value.spawns?.label ?? "", "personal")).toBe("floci_namespace=office-personal-floci");
});

test("the compose file uses only the package's settings and the office's name", () => {
  if (!manifest.ok) throw new Error(manifest.errors.join("\n"));

  const { namespace, settings } = manifest.value;
  const used = new Set([...composeText.matchAll(/\$\{([A-Z0-9_]+)/g)].map((match) => match[1]));

  // source_reference reaches the compose file's environment too, but no service needs it.
  expect([...used].sort()).toEqual([...["port", "ui_port", "storage"].map(key => settingVariable(namespace, key)), "OFFICE_NAME"].sort());
  expect(Object.keys(settingProperties(settings)).sort()).toEqual(["port", "source_reference", "storage", "ui_port"]);
});

type Settings = { port: number | string; ui_port: number | string; storage: string };

type Plugin = typeof awsPlugin;

/** The skill as the plugin registers it, delivered to an office that applied these settings. */
async function registeredSkill(settings: Settings, container: boolean, office: string) {
  const plugin = await officePlugin<Plugin>("aws-emulator", office, { "aws-emulator": settings });
  const added: { id: string; name: string; description: string; path: string; content: string }[] = [];
  const before = process.env.OFFICE_CONTAINER;

  if (container) process.env.OFFICE_CONTAINER = "1";
  else delete process.env.OFFICE_CONTAINER;

  try {
    const close = await plugin.setup({
      skill: { transform: async (callback: (editor: { add(skill: (typeof added)[number]): void }) => void) => (callback({ add: (skill) => added.push(skill) }), { dispose: async () => {} }), reload: async () => {} },
    });

    close();
  } finally {
    if (before === undefined) delete process.env.OFFICE_CONTAINER;
    else process.env.OFFICE_CONTAINER = before;
  }

  return added;
}

/** FLOCI_BASE_URL as Compose gives it to Floci for a port. */
function composeEndpoint(port: number | string): string {
  return compose.services.floci.environment.FLOCI_BASE_URL.replace("${FLOCI_PORT}", String(port));
}

test("the plugin registers the floci skill with this office's addresses on the host", async () => {
  const skills = await registeredSkill({ port: 4566, ui_port: 4500, storage: "memory" }, false, join(scratch, "host"));

  expect(skills.map((skill) => skill.id)).toEqual(["floci"]);
  expect(skills[0].name).toBe("floci");
  expect(skills[0].description).toStartWith("Run AWS CLI and SDK calls against the office's local AWS emulator");
  expect(skills[0].path).toBe(join(scratch, "host/.office/packages/aws-emulator/skills/floci/SKILL.md"));
  expect(skills[0].content).toContain("- Endpoint: http://localhost.floci.io:4566\n");
  expect(skills[0].content).toContain("- Console: http://floci.localhost:4500\n");
  expect(skills[0].content).toContain("a restart of Floci starts empty");
  expect(skills[0].content).not.toContain("name: floci");
});

test("from the office's container the endpoint is the same and the console is the compose service", async () => {
  const [skill] = await registeredSkill({ port: "14566", ui_port: "14500", storage: "hybrid" }, true, join(scratch, "container"));

  expect(skill.content).toContain(`- Endpoint: ${composeEndpoint("14566")}\n`);
  expect(skill.content).toContain("- Console: http://floci-ui:4500, which the user opens on their machine as http://floci.localhost:14500\n");
  expect(skill.content).toContain("storage mode hybrid");
});

test("Floci advertises the endpoint name, which its service answers to on the compose network", () => {
  expect(composeEndpoint(4566)).toBe("http://localhost.floci.io:4566");
  expect(compose.services.floci.networks.default.aliases).toEqual(["localhost.floci.io"]);
  expect(compose.services.floci.environment.FLOCI_PORT).toBe("${FLOCI_PORT}");
});

test("the skill reloads when sync applies new settings for the package, not for another package or the same ones", async () => {
  const office = join(scratch, "watch");
  const settings = { port: 4566, ui_port: 4500, storage: "memory" };
  const plugin = await officePlugin<Plugin>("aws-emulator", office, { "aws-emulator": settings, design: { port: 41441 } });
  let reloads = 0;

  const close = await plugin.setup({ skill: { transform: async () => ({ dispose: async () => {} }), reload: async () => void reloads++ } });

  try {
    // As sync publishes: a whole new file renamed over the old one.
    writeAppliedSnapshot(office, { "aws-emulator": settings, design: { port: 41442 } });
    await settle(() => true);
    expect(reloads).toBe(0);

    writeAppliedSnapshot(office, { "aws-emulator": { ...settings, port: 4600 }, design: { port: 41442 } });
    await settle(() => reloads > 0);
    expect(reloads).toBe(1);
  } finally {
    close();
  }
});

test("a plugin linked before its settings are applied registers the skill once a sync applies them, and follows new skill text in a new package set", async () => {
  const office = join(scratch, "unapplied");
  // As a sync that couldn't fetch another package leaves a newly selected one: linked, with no entry.
  const plugin = await officePlugin<Plugin>("aws-emulator", office, { office: {} });
  let transform: ((editor: { add(skill: { content: string }): void }) => void) | undefined;
  let reloads = 0;

  const skill = () => {
    let content: string | undefined;

    transform?.({ add: (added) => (content = added.content) });

    return content;
  };

  const close = await plugin.setup({ skill: { transform: async (callback: typeof transform) => ((transform = callback), { dispose: async () => {} }), reload: async () => void reloads++ } });

  try {
    expect(skill()).toBeUndefined();

    writeAppliedSnapshot(office, { "aws-emulator": { port: 4600, ui_port: 4500, storage: "memory" }, office: {} });
    await settle(() => reloads > 0);
    expect(reloads).toBe(1);
    expect(skill()).toContain("- Endpoint: http://localhost.floci.io:4600\n");

    // Only the skill's text changes, as in a new release of the package.
    replacePackage(office, "aws-emulator", folder => {
      const file = join(folder, "skills/floci/SKILL.md");

      writeFileSync(file, `${readFileSync(file, "utf8")}\nNew guidance.\n`);
    });
    await settle(() => reloads > 1);
    expect(reloads).toBe(2);
    expect(skill()).toContain("New guidance.");
  } finally {
    close();
  }
});
