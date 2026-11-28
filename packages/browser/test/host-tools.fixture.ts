import assert from "node:assert/strict";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type browserPlugin from "../plugin/index.ts";
import { settle } from "../../../test/support/plugin-office.fixture.ts";

type Plugin = typeof browserPlugin;

type Context = Parameters<Plugin["setup"]>[0];

type McpTransform = Parameters<Context["mcp"]["transform"]>[0];

type SkillTransform = Parameters<Context["skill"]["transform"]>[0];

const office = process.argv[2];
const { default: plugin }: { default: Plugin } = await import(join(office, ".opencode/plugins/browser/index.js"));
const tools = join(office, "tools");
const generation = join(tools, "generations/approved");
const path = join(generation, "agent-browser");
let mcp: McpTransform | undefined;
let skill: SkillTransform | undefined;
let mcpReloads = 0;
let skillReloads = 0;
const registration = { dispose: async () => {} };

const close = await plugin.setup({
  mcp: {
    async transform(callback) {
      mcp = callback;

      return registration;
    },
    async reload() { mcpReloads++; },
  },
  skill: {
    async transform(callback) {
      skill = callback;

      return registration;
    },
    async reload() { skillReloads++; },
  },
});

function registeredCommand(): string[] | undefined {
  let command: string[] | undefined;

  mcp?.({ set(name, server) { if (name === "agent-browser") command = server.command; } });

  return command;
}

function guidance(): string {
  let text = "";

  skill?.({ add(item) { text = item.content; } });

  return text;
}

try {
  assert.equal(registeredCommand(), undefined);

  if (process.env.OFFICE_CONTAINER === "1") {
    assert.match(guidance(), /agent-browser`: the container has no executable/);
  } else {
    assert.match(guidance(), /agent-browser`: no applied executable/);
    symlinkSync(generation, join(tools, "current"));
    await settle(() => mcpReloads > 0 && skillReloads > 0);
    assert.ok(mcpReloads > 0 && skillReloads > 0, "activation must reload MCP and skills");
    assert.deepEqual(registeredCommand(), [path, "mcp", "--tools", "core"]);

    writeFileSync(path, "changed executable");
    assert.equal(registeredCommand(), undefined);
    assert.match(guidance(), /office neither runs a changed tool nor substitutes another copy/);
  }
} finally {
  close();
}
