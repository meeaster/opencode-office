import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeFiles } from "./claude.ts";
import { sync } from "./commands/sync.ts";
import { loadOffice } from "./office.ts";

let root: string;
let bin: string;
let launcher: string;
let settings: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "office claude ")));
  bin = join(root, ".office/claude/bin");
  launcher = join(bin, "claude");
  settings = join(root, ".office/claude/settings.json");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

test("sync reconciles the launcher, mode and instruction-only settings, not owner config", async () => {
  const config = join(root, "mise.toml");
  const original = '[env]\nCLAUDE_CODE_PLUGIN_DIRS = "/owner/plugin"\n';

  writeFileSync(join(root, "office.yaml"), "name: claude-test\n");
  writeFileSync(config, original);
  expect(await sync(loadOffice(root), { scope: "references" })).toEqual([]);
  expect(claudeFiles(root)).toHaveLength(2);

  const first = await sync(loadOffice(root));

  expect(first).toContain("wrote .office/claude/bin/claude");
  expect(first).toContain("wrote .office/claude/settings.json");
  expect(readFileSync(config, "utf8")).toBe(original);
  expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({
    pluginConfigs: { "cc-plugin-agents-md@builtin": { options: { instructionFiles: "claude-md-and-agents-md" } } },
  });
  expect(statSync(launcher).mode & 0o777).toBe(0o755);
  expect(claudeFiles(root)).toEqual([]);
  expect(await sync(loadOffice(root))).toEqual([]);

  chmodSync(launcher, 0o644);
  writeFileSync(settings, "{}");
  expect(claudeFiles(root)).toHaveLength(2);
  expect(await sync(loadOffice(root))).toEqual(["wrote .office/claude/bin/claude", "wrote .office/claude/settings.json"]);
  expect(claudeFiles(root)).toEqual([]);

  rmSync(settings);
  symlinkSync(config, settings);

  expect(await sync(loadOffice(root))).toEqual(["FAILED: .office/claude/settings.json is not a regular file; move it aside and run office sync"]);
  expect(readFileSync(config, "utf8")).toBe(original);
});

function fakeNative(folder: string): string {
  mkdirSync(folder);

  const path = join(folder, "claude");

  writeFileSync(path, '#!/bin/bash\nprintf "%s\\0" "$PWD" "$CLAUDE_CONFIG_DIR" "$@"\nexit 42\n', { mode: 0o755 });

  return path;
}

function launch(path: string[], args: string[], env: Record<string, string> = {}, cwd = root) {
  return spawnSync("claude", args, {
    cwd,
    encoding: "utf8",
    env: { PATH: [...path, "/usr/bin", "/bin"].join(":"), HOME: root, CLAUDE_CONFIG_DIR: "custom profile", ...env },
    timeout: 2000,
  });
}

test("launcher forwards cwd, environment, arguments and status, skipping copies on PATH", () => {
  claudeFiles(root, true);

  const alias = join(root, "alias bin");
  const native = join(root, "native bin");

  mkdirSync(alias);
  symlinkSync(launcher, join(alias, "claude"));
  fakeNative(native);

  const args = ["-p", "", "with spaces", "--", "--settings=dangling"];
  const result = launch([bin, alias, bin, native], args);

  expect(result.status).toBe(42);
  expect(result.stdout.split("\0")).toEqual([root, "custom profile", "--settings", settings, ...args, ""]);

  for (const args of [["-p", "--settings", "local settings.json"], ["--settings={}", "-p"]]) {
    const explicit = launch([bin, native], args);

    expect(explicit.status).toBe(42);
    expect(explicit.stdout.split("\0")).toEqual([root, "custom profile", ...args, ""]);
  }

  const outside = launch([bin, native], args, {}, tmpdir());

  expect(outside.status).toBe(42);
  expect(outside.stdout.split("\0").slice(2)).toEqual([...args, ""]);
});

test("launcher resolves mise shims and falls back to native when the shim is stale", () => {
  claudeFiles(root, true);

  const shims = join(root, "custom shims");
  const tools = join(root, "mise bin");
  const fallback = join(root, "native bin");
  const selected = fakeNative(join(root, "mise managed claude"));

  mkdirSync(shims);
  mkdirSync(tools);
  fakeNative(fallback);
  writeFileSync(join(tools, "mise"), '#!/bin/bash\n[[ $* == "which claude" && -n $SELECTED ]] || exit 1\nprintf "%s\\n" "$SELECTED"\n', { mode: 0o755 });
  symlinkSync(join(tools, "mise"), join(shims, "claude"));

  const resolved = launch([bin, shims, tools], [], { SELECTED: selected });
  const stale = launch([bin, shims, tools, fallback], [], { MISE_SHIMS_DIR: shims });

  expect(resolved.status).toBe(42);
  expect(stale.status).toBe(42);
  expect(stale.stdout).toBe(resolved.stdout);

  const missing = spawnSync(launcher, [], {
    encoding: "utf8",
    env: { HOME: root, PATH: bin },
    timeout: 2000,
  });

  expect(missing.status).toBe(127);
  expect(missing.stderr).toContain("no Claude Code executable found on PATH");
});
