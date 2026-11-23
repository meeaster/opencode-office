import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describeOutside, type Places, scanOutside, sessionPlaces, shadowing, withLoaded } from "./outside.ts";

let dir: string;
let home: string;
let office: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-outside-"));
  home = join(dir, "home");
  office = join(home, "work/office");
  mkdirSync(office, { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function file(path: string, text = "x\n"): void {
  mkdirSync(dirname(join(home, path)), { recursive: true });
  writeFileSync(join(home, path), text);
}

function places(): Places {
  return sessionPlaces({ dir: office, state: join(dir, "state"), opencode: { mode: "host" } }, {}, home);
}

const lines = () => describeOutside(scanOutside(places()), home);

test("an empty home has nothing outside the office", () => {
  expect(lines()).toEqual([]);
});

test("lists the global config folder's skills, plugins, agents, commands and instructions", () => {
  file(".config/opencode/AGENTS.md");
  file(".config/opencode/skills/review/SKILL.md");
  file(".config/opencode/skills/teams/release/SKILL.md");
  file(".config/opencode/skills/quick.md");
  file(".config/opencode/plugins/notify.js");
  file(".config/opencode/plugins/acme/index.ts");
  file(".config/opencode/agents/helper.md");
  file(".config/opencode/agents/team/reviewer.md");
  file(".config/opencode/modes/focus.md");
  file(".config/opencode/commands/ship.md");

  expect(lines()).toEqual([
    "instructions ~/.config/opencode/AGENTS.md",
    "skill quick: ~/.config/opencode/skills/quick.md",
    "skill review: ~/.config/opencode/skills/review",
    "skill release: ~/.config/opencode/skills/teams/release",
    "plugin acme: ~/.config/opencode/plugins/acme",
    "plugin notify: ~/.config/opencode/plugins/notify.js",
    "agent helper: ~/.config/opencode/agents/helper.md",
    "agent team/reviewer: ~/.config/opencode/agents/team/reviewer.md",
    "agent focus: ~/.config/opencode/modes/focus.md",
    "command ship: ~/.config/opencode/commands/ship.md",
  ]);
});

test("skips leftovers: folders without SKILL.md, backups, trash, dotfiles, node_modules and lockfiles", () => {
  file(".claude/skills/notes/README.md");
  file(".claude/skills/.trash/old/SKILL.md");
  file(".claude/skills/backup/gone/SKILL.md");
  file(".claude/skills/review.bak-123/SKILL.md");
  file(".claude/skills/node_modules/dep/SKILL.md");
  file(".config/opencode/plugins/README.md");
  file(".config/opencode/plugins/.hidden.js");
  file(".config/opencode/plugins/node_modules/x/index.js");
  file(".config/opencode/plugins/bun.lock");
  file(".config/opencode/opencode.jsonc.bak-1", "{}");
  file(".config/opencode/agents.bak/a.md");
  file(".agents/skills-backup/kept/SKILL.md");
  file(".claude/skills/backup-restore/SKILL.md");

  expect(lines()).toEqual(["skill backup-restore: ~/.claude/skills/backup-restore"]);
});

test("shows a link's target, the CLAUDE.md fallback and the skills installer's record", () => {
  file("elsewhere/review/SKILL.md");
  file("elsewhere/CLAUDE.md");
  mkdirSync(join(home, ".claude/skills"), { recursive: true });
  symlinkSync("../../elsewhere/review", join(home, ".claude/skills/review"));
  symlinkSync(join(home, "elsewhere/CLAUDE.md"), join(home, ".claude/CLAUDE.md"));
  file(".agents/skills/fetch/SKILL.md");
  // Another tool's copy with the installer's name, nested deeper: not the one the lock records.
  file(".claude/skills/synced/bucket/fetch/SKILL.md");
  file(".agents/.skill-lock.json", JSON.stringify({ version: 3, skills: { fetch: { source: "acme/skills", sourceUrl: "https://example.com/x" }, other: { source: "not a slug" } } }));

  expect(lines()).toEqual([
    `instructions ~/.claude/CLAUDE.md (links to ${join(home, "elsewhere/CLAUDE.md")}; read because there is no global AGENTS.md)`,
    "skill review: ~/.claude/skills/review (links to ../../elsewhere/review)",
    "skill fetch: ~/.claude/skills/synced/bucket/fetch",
    "skill fetch: ~/.agents/skills/fetch (recorded in ~/.agents/.skill-lock.json by the skills installer, from acme/skills)",
  ]);
});

test("names a global config's plugins and MCP servers without printing its other values", () => {
  file(
    ".config/opencode/opencode.jsonc",
    `{
  // a comment
  "plugin": ["legacy-plugin@1.0.0", ["tuple-plugin", { "token": "SECRET-1" }]],
  "plugins": ["*", "-opencode.fork-notice", { "package": "acme-plugin", "options": { "key": "SECRET-2" } }],
  "mcp": {
    "servers": { "docs": { "type": "remote", "url": "https://example.com", "headers": { "Authorization": "SECRET-3" } } },
    "timeout": { "catalog": 1000 },
    "legacy": { "type": "local", "command": ["run", "SECRET-4"] },
    "off": { "enabled": false },
  },
  "provider": { "x": { "apiKey": "SECRET-5" } },
}`,
  );

  const output = lines();

  expect(output).toEqual([
    "config ~/.config/opencode/opencode.jsonc",
    "plugin legacy-plugin@1.0.0: ~/.config/opencode/opencode.jsonc (listed in its plugins)",
    "plugin tuple-plugin: ~/.config/opencode/opencode.jsonc (listed in its plugins)",
    "plugin acme-plugin: ~/.config/opencode/opencode.jsonc (listed in its plugins)",
    "MCP server docs: ~/.config/opencode/opencode.jsonc",
    "MCP server legacy: ~/.config/opencode/opencode.jsonc",
  ]);
  expect(output.join("\n")).not.toContain("SECRET");
});

test("an unreadable config is listed without its contents", () => {
  file(".config/opencode/opencode.json", '{ "token": "SECRET", ');

  expect(lines()).toEqual(["config ~/.config/opencode/opencode.json (isn't valid JSON, so its plugins and MCP servers aren't listed)"]);
});

test("reads the folders above the office: .opencode/, config files and AGENTS.md up to the home", () => {
  file(".opencode/skills/near/SKILL.md");
  file(".opencode/commands/go.md");
  file("work/AGENTS.md");
  file("work/opencode.json", JSON.stringify({ mcp: { servers: { tracker: { type: "remote", url: "https://example.com" } } } }));
  file("work/.claude/skills/old-style/SKILL.md");
  file("CLAUDE.md");
  // The office's own files aren't outside it.
  file("work/office/AGENTS.md");
  file("work/office/.opencode/skills/mine/SKILL.md");

  expect(lines()).toEqual([
    "config ~/work/opencode.json",
    "instructions ~/work/AGENTS.md",
    "instructions ~/CLAUDE.md",
    "skill old-style: ~/work/.claude/skills/old-style",
    "skill near: ~/.opencode/skills/near",
    "command go: ~/.opencode/commands/go.md",
    "MCP server tracker: ~/work/opencode.json",
  ]);
});

test("honors XDG_CONFIG_HOME and OPENCODE_CONFIG_DIR on the host", () => {
  const hostOffice = { dir: office, state: join(dir, "state"), opencode: { mode: "host" as const } };

  expect(sessionPlaces(hostOffice, { XDG_CONFIG_HOME: join(dir, "xdg") }, home).configDir).toBe(join(dir, "xdg/opencode"));
  expect(sessionPlaces(hostOffice, { XDG_CONFIG_HOME: join(dir, "xdg"), OPENCODE_CONFIG_DIR: join(dir, "custom") }, home).configDir).toBe(join(dir, "custom"));

  const host = sessionPlaces(hostOffice, {}, home);

  expect(host.label).toBe(`the host's home (${home})`);
  expect(host.ancestors.filter((ancestor) => ancestor.instructions).map((ancestor) => ancestor.dir)).toEqual([join(home, "work"), home]);
  expect(host.ancestors.at(-1)).toEqual({ dir: "/", instructions: false });
});

test("in container mode, reads the container's home in the office's state", () => {
  const state = join(dir, "state");
  const container = sessionPlaces({ dir: office, state, opencode: { mode: "container" } }, {}, home);
  const hostHome = join(state, "opencode-home");

  expect(container.label).toBe(`the container's home (/home/office, kept at ${hostHome})`);
  expect(container.home).toBe(hostHome);
  expect(container.configDir).toBe(join(hostHome, ".config/opencode"));
  expect(container.systemDir).toBeUndefined();
  expect(container.ancestors).toEqual([{ dir: hostHome, instructions: true }]);
  expect(container.fromSession("/home/office/.claude/skills/a/SKILL.md")).toBe(join(hostHome, ".claude/skills/a/SKILL.md"));
  expect(container.fromSession("/home/office/workspace/.opencode/skills/b/SKILL.md")).toBe(join(office, ".opencode/skills/b/SKILL.md"));
  expect(container.fromSession("/etc/opencode/skills/c/SKILL.md")).toBeUndefined();

  mkdirSync(join(hostHome, ".agents/skills/shared"), { recursive: true });
  writeFileSync(join(hostHome, ".agents/skills/shared/SKILL.md"), "x\n");
  // The host's home doesn't matter in container mode.
  file(".agents/skills/host-only/SKILL.md");

  expect(describeOutside(scanOutside(container), container.home)).toEqual(["skill shared: ~/.agents/skills/shared"]);
});

test("the server's answer marks shadowed and failed items and adds what the scan missed", () => {
  file(".claude/skills/review/SKILL.md");
  file(".agents/skills/review/SKILL.md");
  file(".claude/skills/unused/SKILL.md");
  file(".config/opencode/plugins/notify.js");
  file(".config/opencode/plugins/broken.js");
  file(".config/opencode/plugins/idle.js");

  const items = withLoaded(
    scanOutside(places()),
    {
      skills: new Map([
        ["review", join(home, ".agents/skills/review/SKILL.md")],
        ["extra", join(dir, "shared/extra/SKILL.md")],
        ["mine", join(office, ".opencode/skills/mine/SKILL.md")],
      ]),
      plugins: [
        { id: "acme.notify", path: join(home, ".config/opencode/plugins/notify.js"), active: true },
        { id: "acme.broken", path: join(home, ".config/opencode/plugins/broken.js"), active: false },
        { id: "office", path: join(office, ".opencode/plugins/office"), active: true },
      ],
    },
    office,
  );

  expect(describeOutside(items, home)).toEqual([
    "skill review: ~/.claude/skills/review (not loaded: ~/.agents/skills/review has the same name and wins)",
    "skill unused: ~/.claude/skills/unused (not loaded)",
    "skill review: ~/.agents/skills/review",
    `skill extra: ${join(dir, "shared/extra")} (reported by the server)`,
    "plugin acme.broken: ~/.config/opencode/plugins/broken.js (failed to load)",
    "plugin idle: ~/.config/opencode/plugins/idle.js (not loaded)",
    "plugin acme.notify: ~/.config/opencode/plugins/notify.js",
  ]);
});

test("warns about an outside skill or plugin with the name of one the office provides, saying which loads", () => {
  file(".claude/skills/writing/SKILL.md");
  file(".claude/skills/office/SKILL.md");
  file(".config/opencode/plugins/tracks.js");
  file(".agents/skills/unrelated/SKILL.md");

  const items = scanOutside(places());

  const provided = {
    skills: new Map([
      ["writing", "the office's skill .agents/skills/writing"],
      ["office", "package office's skill"],
    ]),
    plugins: new Map([["tracks", "package tracks's plugin"]]),
  };

  expect(shadowing(items, provided, home, office)).toEqual([
    "plugin tracks at ~/.config/opencode/plugins/tracks.js has the name of package tracks's plugin; OpenCode loads plugins outside the office first, and of two with the same plugin ID it keeps the first and rejects the office's as a duplicate",
    "skill office at ~/.claude/skills/office has the name of package office's skill; which one loads depends on the server; office check reports it while OpenCode runs",
    "skill writing at ~/.claude/skills/writing has the name of the office's skill .agents/skills/writing; which one loads depends on the server; office check reports it while OpenCode runs",
  ]);

  const loaded = { skills: new Map([["writing", join(office, ".agents/skills/writing/SKILL.md")], ["office", join(home, ".claude/skills/office/SKILL.md")]]), plugins: [] };

  expect(shadowing(items, provided, home, office, loaded).slice(1)).toEqual([
    "skill office at ~/.claude/skills/office has the name of package office's skill; the server loads this outside one instead of the office's",
    "skill writing at ~/.claude/skills/writing has the name of the office's skill .agents/skills/writing; the server loads the office's",
  ]);

  // A running server that loaded no folder of that name, or another outside one, credits nobody in the office.
  const elsewhere = { skills: new Map([["writing", join(home, ".agents/skills/writing/SKILL.md")]]), plugins: [] };

  expect(shadowing(items, provided, home, office, elsewhere).slice(1)).toEqual([
    "skill office at ~/.claude/skills/office has the name of package office's skill; the server reports no skill folder of that name loaded",
    "skill writing at ~/.claude/skills/writing has the name of the office's skill .agents/skills/writing; the server loads another one outside the office, at ~/.agents/skills/writing",
  ]);
});
