import { beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { atomicWrite } from "./secrets.ts";
import { toolPath } from "./tool.ts";

let dir = "";
let launcher = "";
let credential = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-claude-"));
  launcher = join(dir, "launcher");
  credential = join(dir, "gateway.json");

  const child = join(dir, "child");

  writeFileSync(child, '#!/bin/sh\nprintf "%s\\n" "$ANTHROPIC_AUTH_TOKEN" "$ANTHROPIC_BASE_URL" "$ANTHROPIC_DEFAULT_SONNET_MODEL" "$@"\nexit 23\n', { mode: 0o700 });
  writeFileSync(launcher, readFileSync(toolPath("image/claude.sh"), "utf8")
    .replace("/usr/local/lib/office/claude", child)
    .replace("/run/office-claude/gateway.json", credential), { mode: 0o700 });
});

function invoke() {
  return spawnSync(launcher, ["--settings", '{"disableAllHooks":true}', "--model", "sonnet"], {
    encoding: "utf8",
    env: { PATH: process.env.PATH, OFFICE_CLAUDE_GATEWAY: "1", ANTHROPIC_AUTH_TOKEN: "fake-ambient-must-not-win" },
  });
}

test("missing or malformed credential refuses to exec even with ambient authentication", () => {
  expect(invoke().status).toBe(1);

  for (const content of ["not JSON", '{"token":"","baseUrl":"http://localhost"}', '{"token":"   ","baseUrl":"http://localhost"}']) {
    writeFileSync(credential, content);
    const result = invoke();

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain("fake-ambient");
  }
});

test("fresh child sees atomic rotation, model aliases and unchanged arguments and exit status", () => {
  writeFileSync(credential, JSON.stringify({ token: "fake-one", baseUrl: "http://localhost:1234", models: { sonnet: "custom-sonnet" } }));
  const first = invoke();

  expect(first.status).toBe(23);
  expect(first.stdout.split("\n")).toEqual(["fake-one", "http://localhost:1234", "custom-sonnet", "--settings", '{"disableAllHooks":true}', "--model", "sonnet", ""]);

  atomicWrite(credential, JSON.stringify({ token: "fake-two", baseUrl: "http://localhost:1234" }));
  const second = invoke();

  expect(second.status).toBe(23);
  expect(second.stdout.startsWith("fake-two\n")).toBe(true);
});
