import { expect, test } from "bun:test";

import * as v from "valibot";
import { parse } from "yaml";

import { toolsBlock } from "./office.ts";
import { check, officeSchema, pinnedTools, type ResolvedTools, resolveTools } from "./schema.ts";

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

test("the wildcard listen host is opt-in for managed hosts with an IPv4 loopback client URL", () => {
  const host = "opencode:\n  mode: host\n  url: http://127.0.0.1:49374\n  listen_host: 0.0.0.0\n";
  const managed = host + "  managed: true\n";

  expect(errors(managed)).toEqual([]);
  expect(errors(host).join("\n")).toContain("requires opencode.managed");
  expect(errors(managed.replace("127.0.0.1", "[::1]")).join("\n")).toContain("IPv4 loopback");
  expect(errors(managed.replace("127.0.0.1", "0.0.0.0")).join("\n")).toContain("loopback HTTP origin");
  expect(errors("opencode:\n  mode: container\n  listen_host: 0.0.0.0\n")).not.toEqual([]);
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

/** The resolved tools of an office.yaml named t with `rest` after its name. */
function tools(rest: string) {
  const result = check(v.safeParse(officeSchema, parse(`name: t\n${rest}`)));

  if (!result.ok) throw new Error(result.errors.join("\n"));

  return resolveTools(result.value);
}

test("tools takes a version or a mapping per runtime, and refuses unknown keys, enabled outside sfw, and the keys it replaced", () => {
  expect(errors("tools:\n  minimum_release_age: 3d\n  opencode: { version: 2.3.2, minimum_release_age: 0d }\n  claude: 2.1.327\n  executor:\n    version: 2.0.0-beta.49\n    minimum_release_age: 7d\n  sfw: { version: 1.16.0, enabled: false }\n")).toEqual([]);
  expect(errors("tools:\n  node: 26.0.0\n")).toEqual(["tools: has an unknown key node: tools maps minimum_release_age, opencode, claude, codex, executor, mise and sfw"]);
  expect(errors("tools:\n  opencode: { version: 2.3.2, age: 1d }\n")).toEqual(["tools.opencode: has an unknown key age: an entry maps version and minimum_release_age"]);
  expect(errors("tools:\n  executor: { version: 2.0.0-beta.49, enabled: false }\n")).toEqual(["tools.executor: has enabled, which only sfw (Socket Firewall) has"]);
  expect(errors("tools:\n  sfw: { version: 1.16.0, pinned: true }\n")).toEqual(["tools.sfw: has an unknown key pinned: an entry maps version, minimum_release_age and enabled"]);
  expect(errors("tools:\n  minimum_release_age: 3 days\n")).toEqual(["tools.minimum_release_age: must be an age such as 36h, 1d or 2w"]);
  expect(errors("tools:\n  mise: 2026.11\n")).toEqual(["tools.mise: must be a version such as 2.3.0, or a mapping of version and minimum_release_age"]);
  expect(errors("tools:\n  claude: { version: latest }\n")).toEqual(["tools.claude.version: must be a version such as 2.3.0"]);
  expect(errors("tools:\n  claude: 2.1.327\nversions:\n  claude: 2.1.327\nsocket_firewall: false\n")).toEqual(["tools: replaces versions, upgrades and socket_firewall, so office.yaml can't have both: remove versions and socket_firewall"]);
  expect(errors("tools:\n  claude: 2.1.327\nupgrades:\n  minimum_release_age: 1d\n")).toEqual(["tools: replaces versions, upgrades and socket_firewall, so office.yaml can't have both: remove upgrades"]);
});

test("tools defaults to a three-day age for everything, and a runtime without its own inherits the office's", () => {
  const defaults = Object.fromEntries(pinnedTools.map((tool) => [tool, { version: undefined, minimumReleaseAge: "3d" }])) as ResolvedTools["runtimes"];

  expect(tools("")).toEqual({ minimumReleaseAge: "3d", runtimes: defaults, pinsVersions: false, socketFirewall: true, legacy: [], ignoredAges: [] } satisfies ResolvedTools);

  const resolved = tools("tools:\n  minimum_release_age: 1d\n  opencode: { version: 2.3.2, minimum_release_age: 0d }\n  claude: 2.1.327\n  sfw:\n    enabled: false\n");

  expect(resolved.minimumReleaseAge).toBe("1d");
  expect(resolved.runtimes.opencode).toEqual({ version: "2.3.2", minimumReleaseAge: "0d" });
  expect(resolved.runtimes.claude).toEqual({ version: "2.1.327", minimumReleaseAge: "1d" });
  expect(resolved.runtimes.sfw).toEqual({ version: undefined, minimumReleaseAge: "1d" });
  expect(resolved.pinsVersions).toBe(true);
  expect(resolved.socketFirewall).toBe(false);
});

test("an office.yaml from before tools reads as the tools block office check prints for it", () => {
  const old = "versions:\n  opencode: 2.3.2\n  claude: 2.1.327\n  executor: 2.0.0-beta.49\n  mise: 2026.11.9\n  sfw: 1.16.0\nupgrades:\n  minimum_release_age: 1d\n  executor: 7d\nsocket_firewall: false\n";
  const resolved = tools(old);

  expect(resolved.minimumReleaseAge).toBe("3d");
  expect(resolved.runtimes.executor).toEqual({ version: "2.0.0-beta.49", minimumReleaseAge: "7d" });
  expect(resolved.runtimes.sfw).toEqual({ version: "1.16.0", minimumReleaseAge: "1d" });
  expect(resolved.runtimes.codex).toEqual({ version: undefined, minimumReleaseAge: "1d" });
  expect(resolved.legacy).toEqual(["versions", "upgrades", "socket_firewall"]);

  const block = toolsBlock(resolved);

  expect(block).toBe(`tools:
  minimum_release_age: 3d
  opencode: { version: 2.3.2, minimum_release_age: 1d }
  claude: { version: 2.1.327, minimum_release_age: 1d }
  codex: { minimum_release_age: 1d }
  executor: { version: 2.0.0-beta.49, minimum_release_age: 7d }
  mise: { version: 2026.11.9, minimum_release_age: 1d }
  sfw: { version: 1.16.0, minimum_release_age: 1d, enabled: false }
`);
  expect({ ...tools(block), legacy: resolved.legacy }).toEqual(resolved);

  // Only versions: the short form, and the default age written out.
  expect(toolsBlock(tools("versions:\n  opencode: 2.3.2\n  sfw: 1.16.0\n"))).toBe("tools:\n  minimum_release_age: 3d\n  opencode: 2.3.2\n  sfw: 1.16.0\n");
  // No versions: nothing pinned, as before.
  expect(tools("socket_firewall: true\n").pinsVersions).toBe(false);
  expect(tools("versions:\n  opencode: 2.3.2\n").pinsVersions).toBe(true);
});
