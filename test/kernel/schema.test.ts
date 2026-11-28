import { expect, test } from "bun:test";

import * as v from "valibot";
import { parse } from "yaml";

import { check } from "../../src/parse.ts";
import { officeSchema, pinnedTools, type ResolvedTools, resolveTools } from "../../src/schema.ts";

/** The schema's errors for an office.yaml named t with `rest` after its name. */
function errors(rest: string): string[] {
  const result = check(v.safeParse(officeSchema, parse(`name: t\n${rest}`)));

  return result.ok ? [] : result.errors;
}

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

test("tools takes a version or a mapping per runtime, and refuses unknown keys and enabled outside sfw", () => {
  expect(errors("minimum_release_age: 3d\ntools:\n  opencode: { version: 2.3.2, minimum_release_age: 0d }\n  claude: 2.1.327\n  executor:\n    version: 2.0.0-beta.49\n    minimum_release_age: 7d\n  sfw: { version: 1.16.0, enabled: false }\n")).toEqual([]);
  expect(errors("tools:\n  node: 26.0.0\n")).toEqual(["tools: has an unknown key node: tools maps opencode, claude, codex, executor, mise and sfw"]);
  expect(errors("tools:\n  opencode: { version: 2.3.2, age: 1d }\n")).toEqual(["tools.opencode: has an unknown key age: an entry maps version and minimum_release_age"]);
  expect(errors("tools:\n  executor: { version: 2.0.0-beta.49, enabled: false }\n")).toEqual(["tools.executor: has enabled, which only sfw (Socket Firewall) has"]);
  expect(errors("tools:\n  sfw: { version: 1.16.0, pinned: true }\n")).toEqual(["tools.sfw: has an unknown key pinned: an entry maps version, minimum_release_age and enabled"]);
  expect(errors("minimum_release_age: 3 days\n")).toEqual(["minimum_release_age: must be an age such as 36h, 1d or 2w"]);
  // The office's age is top-level; under tools it is an unknown key like any other.
  expect(errors("tools:\n  minimum_release_age: 3d\n")).toEqual(["tools: has an unknown key minimum_release_age: tools maps opencode, claude, codex, executor, mise and sfw"]);
  expect(errors("packages:\n  - name: demo\n    minimum_release_age: 0d\n  - name: other\n    minimum_release_age: soon\n")).toEqual(["packages[1].minimum_release_age: must be an age such as 36h, 1d or 2w"]);
  expect(errors("tools:\n  mise: 2026.11\n")).toEqual(["tools.mise: must be a version such as 2.3.0, or a mapping of version and minimum_release_age"]);
  expect(errors("tools:\n  claude: { version: latest }\n")).toEqual(["tools.claude.version: must be a version such as 2.3.0"]);
});

test("unknown keys in office.yaml are refused", () => {
  expect(errors("versions:\n  opencode: 2.3.2\n")).toEqual(["versions: must be a mapping of name, state, opencode, executor, git, secrets, minimum_release_age, tools, references, plugins and packages"]);
  // Cron's configuration is the cron package's settings: the keys before it are unknown like any other.
  expect(errors("cron:\n  heartbeat: { schedule: '@hourly', script: heartbeat.sh }\n")).toEqual(["cron: must be a mapping of name, state, opencode, executor, git, secrets, minimum_release_age, tools, references, plugins and packages"]);

  expect(errors("packages:\n  - name: office\n    cron: { upgrade-tools: { enabled: false } }\n")).toEqual(["packages[0].cron: must be a mapping of the fields this schema knows"]);
});

test("tools defaults to a three-day age for everything, and a runtime without its own inherits the office's", () => {
  const defaults = Object.fromEntries(pinnedTools.map((tool) => [tool, { version: undefined, minimumReleaseAge: "3d" }])) as ResolvedTools["runtimes"];

  expect(tools("")).toEqual({ minimumReleaseAge: "3d", runtimes: defaults, pinsVersions: false, socketFirewall: true } satisfies ResolvedTools);

  const resolved = tools("minimum_release_age: 1d\ntools:\n  opencode: { version: 2.3.2, minimum_release_age: 0d }\n  claude: 2.1.327\n  sfw:\n    enabled: false\n");

  expect(resolved.minimumReleaseAge).toBe("1d");
  expect(resolved.runtimes.opencode).toEqual({ version: "2.3.2", minimumReleaseAge: "0d" });
  expect(resolved.runtimes.claude).toEqual({ version: "2.1.327", minimumReleaseAge: "1d" });
  expect(resolved.runtimes.sfw).toEqual({ version: undefined, minimumReleaseAge: "1d" });
  expect(resolved.pinsVersions).toBe(true);
  expect(resolved.socketFirewall).toBe(false);
});
