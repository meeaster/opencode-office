import { expect, test } from "bun:test";

import * as v from "valibot";
import { parse } from "yaml";

import { check, officeSchema } from "./schema.ts";

/** The schema's errors for an office.yaml named t with `rest` after its name. */
function errors(rest: string): string[] {
  const result = check(v.safeParse(officeSchema, parse(`name: t\n${rest}`)));

  return result.ok ? [] : result.errors;
}

test("a claude block says the gateway was removed", () => {
  expect(errors("claude:\n  credential: secrets/claude.enc.json\n  settings: claude/settings.json\n")).toEqual([
    "claude: was the Claude gateway, which office no longer has: delete the claude block from office.yaml",
  ]);
});

test("server commands and encrypted secrets need managed host mode", () => {
  const host = "opencode:\n  mode: host\n  url: http://127.0.0.1:49374\n";
  const commands = "  env_commands:\n    GITHUB_MCP_TOKEN: gh auth token\n";
  const secrets = "secrets:\n  server: secrets/server.enc.yaml\n";

  expect(errors(host + "  managed: true\n" + commands + secrets)).toEqual([]);
  expect(errors(host + commands).join("\n")).toContain("requires opencode.managed: true");
  expect(errors(host + secrets).join("\n")).toContain("secrets.server: requires opencode.managed: true");
  expect(errors("opencode: container\n" + secrets).join("\n")).toContain("secrets.server: requires opencode.managed: true");
  expect(errors(host + "  managed: true\n" + commands.replace("GITHUB_MCP_TOKEN", "PATH"))).not.toEqual([]);
  expect(errors(host.replace("127.0.0.1", "example.org") + "  managed: true\n").join("\n")).toContain("loopback HTTP origin");
});
