import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "yaml";

import { writeAppliedSnapshot } from "../../../src/applied-settings.ts";
import { officePlugin, settle } from "../../../test/support/plugin-office.fixture.ts";
import { type AddressSettings, browserAddress } from "../executor-app/address.ts";
import type designPlugin from "../plugin/index.ts";

const packageDir = join(import.meta.dir, "..");
const scratch = mkdtempSync(join(tmpdir(), "design-address-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const cases: { name: string; settings: AddressSettings; address: string }[] = [
  { name: "the agent key file, as offices had it", settings: { port: 41441, url: "", executor_app: false, oauth: true }, address: "http://localhost:41441" },
  { name: "Executor with sign-in, the default for the app", settings: { port: 41461, url: "", executor_app: true, oauth: true }, address: "http://doop.localhost:41461" },
  { name: "Executor with the agent key only", settings: { port: 41461, url: "", executor_app: true, oauth: false }, address: "http://localhost:41461" },
  { name: "an explicit url, which always wins", settings: { port: 41461, url: "https://doop.example.ts.net/", executor_app: true, oauth: true }, address: "https://doop.example.ts.net" },
  { name: "settings given as text in office.yaml", settings: { port: "41462", url: "", executor_app: "true", oauth: "true" }, address: "http://doop.localhost:41462" },
];

type Compose = { services: { doop: { command: string[]; networks: { default: { aliases: string[] } } } } };

const compose: Compose = parse(readFileSync(join(packageDir, "compose.yaml"), "utf8"));

/** BETTER_AUTH_URL as the doop service's start script sets it, with Compose's $$ escapes undone. */
function composeAddress(settings: AddressSettings): string {
  const script = compose.services.doop.command[2].replaceAll("$$", "$").replace(/^exec .*$/m, 'printf %s "$BETTER_AUTH_URL"');

  return execFileSync("sh", ["-c", script], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, PORT: String(settings.port), DOOP_URL: settings.url, DOOP_EXECUTOR_APP: String(settings.executor_app), DOOP_OAUTH: String(settings.oauth) },
  });
}

type Plugin = typeof designPlugin;

/** The address the plugin gives the doop skill, as delivered to an office that applied these settings. */
async function pluginAddress(settings: AddressSettings, office: string): Promise<string> {
  const plugin = await officePlugin<Plugin>("design", office, { design: settings });
  let content = "";

  const close = await plugin.setup({
    skill: { transform: async (add: (editor: { add(skill: { content: string }): void }) => void) => (add({ add: (skill) => (content = skill.content) }), { dispose: async () => {} }), reload: async () => {} },
    mcp: { transform: async () => ({ dispose: async () => {} }), reload: async () => {} },
  });

  close();

  return /The user opens it at (\S+?)\.(?:\s|$)/.exec(content)?.[1] ?? "";
}

for (const [index, item] of cases.entries()) {
  test(`compose, plugin and app agree on Doop's address: ${item.name}`, async () => {
    expect(browserAddress(item.settings)).toBe(item.address);
    expect(composeAddress(item.settings)).toBe(item.address);
    expect(await pluginAddress(item.settings, join(scratch, String(index)))).toBe(item.address);
  });
}

test("the doop service answers to doop.localhost on the compose network", () => {
  expect(compose.services.doop.networks.default.aliases).toEqual(["doop.localhost"]);
});

test("before its settings are applied the plugin registers neither skill nor server, and does once a sync applies them", async () => {
  const office = join(scratch, "unapplied");
  const plugin = await officePlugin<Plugin>("design", office, { other: {} });
  let skill: ((editor: { add(skill: { content: string }): void }) => void) | undefined;
  let mcp: ((editor: { set(name: string, server: { type: "remote"; url: string }): void }) => void) | undefined;
  let reloads = 0;

  mkdirSync(join(office, ".opencode/doop"), { recursive: true });
  writeFileSync(join(office, ".opencode/doop/agent-key"), "key\n");

  const close = await plugin.setup({
    skill: { transform: async (callback: typeof skill) => ((skill = callback), { dispose: async () => {} }), reload: async () => void reloads++ },
    mcp: { transform: async (callback: typeof mcp) => ((mcp = callback), { dispose: async () => {} }), reload: async () => {} },
  });

  const registered = () => {
    const names: string[] = [];

    skill?.({ add: () => names.push("skill") });
    mcp?.({ set: (name) => names.push(name) });

    return names;
  };

  try {
    expect(registered()).toEqual([]);
    writeAppliedSnapshot(office, { design: { port: 41441, url: "", executor_app: false, oauth: false }, other: {} });
    await settle(() => reloads > 0);
    expect(registered()).toEqual(["skill", "doop"]);
  } finally {
    close?.();
  }
});

test("the outer plugin ignores the nested office's key and uses its own", async () => {
  const outer = join(scratch, "outer");
  const nested = join(outer, "nested");
  const location = { directory: nested };
  const plugin = await officePlugin<Plugin>("design", outer, { design: { port: 41441, url: "", executor_app: false, oauth: false } });
  const registration = { dispose: async () => {} };

  type Transform = Parameters<Parameters<Plugin["setup"]>[0]["mcp"]["transform"]>[0];

  let transform: Transform | undefined;

  mkdirSync(join(nested, ".opencode/doop"), { recursive: true });
  writeFileSync(join(nested, "office.yaml"), "name: nested\n");
  writeFileSync(join(nested, ".opencode/doop/agent-key"), "nested-fixture\n");
  mkdirSync(join(outer, ".opencode/doop"));

  const context = {
    location,
    skill: { transform: async () => registration, reload: async () => {} },
    mcp: { transform: async (callback: Transform) => ((transform = callback), registration), reload: async () => {} },
  };

  const close = await plugin.setup(context);

  const credentials = () => {
    const found: string[] = [];

    transform?.({ set(name, server) { if (name === "doop") found.push(server.headers.Authorization); } });

    return found;
  };

  try {
    expect(credentials()).toEqual([]);
    writeFileSync(join(outer, ".opencode/doop/agent-key"), "outer-fixture\n");
    expect(credentials()).toEqual(["Bearer outer-fixture"]);
  } finally {
    close();
  }
});
