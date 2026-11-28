import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AppliedSettings } from "../../../sdk/applied-settings.ts";
import { writeAppliedSnapshot } from "../../../src/applied-settings.ts";
import { officePlugin, replacePackage, settle } from "../../../test/support/plugin-office.fixture.ts";
import type browserPlugin from "../plugin/index.ts";

type Skill = { id: string; content: string };

type Plugin = typeof browserPlugin;

const scratch = mkdtempSync(join(tmpdir(), "browser-plugin-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

test("a host session takes only the activated agent-browser, ignoring a misleading PATH", async () => {
  const office = join(scratch, "host-tools");
  const bin = join(office, "misleading-bin");
  const shim = join(bin, "agent-browser");
  const misleading = "#!/bin/sh\nexit 99\n";
  const tools = join(office, "tools");
  const generation = join(tools, "generations/approved");
  const path = join(generation, "agent-browser");
  const contents = "#!/bin/sh\nexit 0\n";
  const sha256 = `sha256:${createHash("sha256").update(contents).digest("hex")}`;

  await officePlugin<Plugin>("browser", office, { browser: { agent_browser_tools: "core", browse: false, system_chrome: false } });
  mkdirSync(generation, { recursive: true });
  writeFileSync(path, contents, { mode: 0o755 });
  writeFileSync(join(generation, "applied.json"), JSON.stringify({
    tools: { "npm:agent-browser": { version: "0.43.0", identity: sha256, names: [], bin: { "agent-browser": { path, sha256 } } } },
    highest: {},
  }));
  writeFileSync(join(office, ".office/runtime/tools.json"), JSON.stringify({ mode: "host", tools }));
  mkdirSync(bin);
  writeFileSync(shim, misleading, { mode: 0o755 });

  const child = Bun.spawn([process.execPath, join(import.meta.dir, "host-tools.fixture.ts"), office], {
    env: { HOME: office, PATH: bin },
    stderr: "pipe",
  });

  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

  expect(status, stderr).toBe(0);
  expect(readFileSync(shim, "utf8")).toBe(misleading);
});

test("the container session omits agent-browser when the container lacks it", async () => {
  const office = join(scratch, "container-tools");

  await officePlugin<Plugin>("browser", office, { browser: { agent_browser_tools: "core", browse: false } });
  writeFileSync(join(office, ".office/packages/browser/.office.json"), '{"opencode":"container"}');
  writeFileSync(join(office, ".office/runtime/tools.json"), '{"mode":"container"}');

  const child = Bun.spawn([process.execPath, join(import.meta.dir, "host-tools.fixture.ts"), office], {
    env: { HOME: office, PATH: join(office, "no-bin"), OFFICE_CONTAINER: "1" },
    stderr: "pipe",
  });

  const [status, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

  expect(status, stderr).toBe(0);
});

/** Sets the plugin up in an office in host mode, returning its skill on each load and a count of its reloads. */
async function started(office: string, packages: Record<string, AppliedSettings>) {
  const plugin = await officePlugin<Plugin>("browser", office, packages);
  let transform: ((editor: { add(skill: Skill): void }) => void) | undefined;
  let reloads = 0;

  writeFileSync(join(office, ".office/packages/browser/.office.json"), JSON.stringify({ opencode: "host" }));

  const close = await plugin.setup({
    skill: { transform: async (callback: typeof transform) => ((transform = callback), { dispose: async () => {} }), reload: async () => void reloads++ },
    mcp: { transform: async () => ({ dispose: async () => {} }), reload: async () => {} },
  });

  const skill = () => {
    let added: Skill | undefined;

    transform?.({ add: (item) => (added = item) });

    return added?.content ?? "";
  };

  return { skill, reloads: () => reloads, close };
}

test("the skill follows the settings the office applied, and the package's defaults before it has any", async () => {
  const off = await started(join(scratch, "off"), { browser: { agent_browser_tools: "", browse: false, system_chrome: false } });

  expect(off.skill()).toContain("`agent-browser`: turned off");
  expect(off.skill()).toContain("`browse`: turned off");
  off.close();

  const unpublished = await started(join(scratch, "unpublished"), { other: {} });

  // On by default: registered or not installed, depending on the machine, but not turned off.
  expect(unpublished.skill()).toContain("## This session's servers");
  expect(unpublished.skill()).not.toContain("turned off");
  unpublished.close();
});

test("a published mode or this package's applied settings reload the skill", async () => {
  const office = join(scratch, "mode");
  const session = await started(office, { browser: { agent_browser_tools: "core", browse: true, system_chrome: false }, design: { port: 1 } });

  try {
    writeAppliedSnapshot(office, { browser: { agent_browser_tools: "core", browse: true, system_chrome: false }, design: { port: 2 } });
    await settle(() => session.reloads() > 0);
    expect(session.reloads()).toBe(0);

    replacePackage(office, "browser", folder => writeFileSync(join(folder, ".office.json"), JSON.stringify({ opencode: "container" })));
    await settle(() => session.reloads() > 0);
    expect(session.reloads()).toBe(1);
    expect(session.skill()).toContain("`browse`: not in this office");

    writeAppliedSnapshot(office, { browser: { agent_browser_tools: "core", browse: false, system_chrome: false }, design: { port: 2 } });
    await settle(() => session.reloads() > 1);
    expect(session.reloads()).toBe(2);
  } finally {
    session.close();
  }
});

test("a new package set reloads changed skill text with the same mode, settings and plugin", async () => {
  const office = join(scratch, "installed");
  const session = await started(office, { browser: { agent_browser_tools: "core", browse: true, system_chrome: false } });

  try {
    replacePackage(office, "browser", folder => appendFileSync(join(folder, "skills/browser-automation/SKILL.md"), "\nNew browser guidance.\n"));
    await settle(() => session.reloads() > 0);
    expect(session.reloads()).toBe(1);
    expect(session.skill()).toContain("New browser guidance.");
  } finally {
    session.close();
  }
});
