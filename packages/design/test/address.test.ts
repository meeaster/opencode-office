import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parse } from "yaml";

import { type AddressSettings, browserAddress } from "../executor-app/address.ts";

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

/** The address the plugin gives the doop skill, from a copy of the package with these settings. */
async function pluginAddress(settings: AddressSettings, copy: string): Promise<string> {
  mkdirSync(copy);
  cpSync(join(packageDir, "plugin"), join(copy, "plugin"), { recursive: true });
  cpSync(join(packageDir, "skills"), join(copy, "skills"), { recursive: true });
  writeFileSync(join(copy, ".settings.json"), JSON.stringify(settings));

  const plugin = (await import(join(copy, "plugin/index.ts"))).default;
  let content = "";

  const close = await plugin.setup({
    location: { directory: copy },
    skill: { transform: async (add: (editor: { add(skill: { content: string }): void }) => void) => add({ add: (skill) => (content = skill.content) }), reload: async () => {} },
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
