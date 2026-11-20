import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as v from "valibot";
import { parse } from "yaml";

import { composeProblems } from "../../../src/package-services.ts";
import { runPackageSetup } from "../../../src/package-definition.ts";
import { spawnsLabel } from "../../../src/package-spawns.ts";
import { check, packageManifestSchema, settingVariable } from "../../../src/schema.ts";
import definition from "../office.ts";

const packageDir = join(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "aws-emulator-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const composeText = readFileSync(join(packageDir, "compose.yaml"), "utf8");

type Compose = { services: { floci: { environment: Record<string, string>; networks: { default: { aliases: string[] } } } } };

const compose: Compose = parse(composeText);

const manifest = check(v.safeParse(packageManifestSchema, definition));

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

test("the compose file uses only the package's settings and the office's name", async () => {
  if (!manifest.ok) throw new Error(manifest.errors.join("\n"));

  const { scalars: serviceSettings } = await runPackageSetup(manifest.value, {}, { settings: {}, add() {}, collection() {}, command() {} });
  const used = new Set([...composeText.matchAll(/\$\{([A-Z0-9_]+)/g)].map((match) => match[1]));

  expect([...used].sort()).toEqual([...Object.keys(serviceSettings).map(key => settingVariable(manifest.value.namespace, key)), "OFFICE_NAME"].sort());
});

type Settings = { port: number | string; ui_port: number | string; storage: string };

/** The skill as the plugin registers it, from a copy of the package with these settings. */
async function registeredSkill(settings: Settings, container: boolean, copy: string) {
  mkdirSync(copy);
  cpSync(join(packageDir, "plugin"), join(copy, "plugin"), { recursive: true });
  cpSync(join(packageDir, "skills"), join(copy, "skills"), { recursive: true });
  writeFileSync(join(copy, ".settings.json"), JSON.stringify(settings));

  const plugin = (await import(join(copy, "plugin/index.ts"))).default;
  const added: { id: string; name: string; description: string; path: string; content: string }[] = [];
  const before = process.env.OFFICE_CONTAINER;

  if (container) process.env.OFFICE_CONTAINER = "1";
  else delete process.env.OFFICE_CONTAINER;

  try {
    const close = await plugin.setup({
      skill: { transform: async (callback: (editor: { add(skill: (typeof added)[number]): void }) => void) => callback({ add: (skill) => added.push(skill) }), reload: async () => {} },
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
  expect(skills[0].path).toBe(join(scratch, "host/skills/floci/SKILL.md"));
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
