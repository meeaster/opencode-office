import { afterAll, beforeAll, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { AppliedSettings } from "../../../sdk/applied-settings.ts";
import { writeAppliedSnapshot } from "../../../src/applied-settings.ts";
import { officePlugin, replacePackage, settle } from "../../../test/support/plugin-office.fixture.ts";
import type browserPlugin from "../plugin/index.ts";

type Skill = { id: string; content: string };

type Plugin = typeof browserPlugin;

const scratch = mkdtempSync(join(tmpdir(), "browser-plugin-"));
const saved = { home: process.env.OPENCODE_BROWSER_HOME, path: process.env.PATH };

beforeAll(() => {
  // No agent-browser: what the skill says then depends on the settings and the mode.
  process.env.OPENCODE_BROWSER_HOME = join(scratch, "no-browse");
  process.env.PATH = join(scratch, "no-bin");
});

afterAll(() => {
  process.env.OPENCODE_BROWSER_HOME = saved.home;
  process.env.PATH = saved.path;
  rmSync(scratch, { recursive: true, force: true });
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
