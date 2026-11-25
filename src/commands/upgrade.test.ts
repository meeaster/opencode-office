import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as v from "valibot";
import { parse } from "yaml";

import { check, officeSchema, resolveTools } from "../schema.ts";
import { setVersions } from "./upgrade.ts";

/** The runtimes' versions an office.yaml asks for, read back through the schema. */
function versionsOf(text: string) {
  const result = check(v.safeParse(officeSchema, parse(text)));

  if (!result.ok) throw new Error(result.errors.join("\n"));

  return Object.fromEntries(Object.entries(resolveTools(result.value).runtimes).map(([tool, runtime]) => [tool, runtime.version]));
}

test("upgrade-tools changes only the version of each form of a tools entry, keeping comments, quotes and layout", () => {
  const text = `name: t
# The tools.
tools:
  opencode: { version: 2.3.2, minimum_release_age: 0d }  # flow
  claude: '2.1.327'  # short, quoted
  executor:
    # Betas almost daily.
    minimum_release_age: 7d
    version: "2.0.0-beta.49"
  mise: 2026.11.9
  sfw: { enabled: false }
  codex:
    minimum_release_age: 1d
# After tools.
references: []
`;

  const result = setVersions(text, [
    { tool: "opencode", to: "2.3.5" },
    { tool: "claude", to: "2.1.330" },
    { tool: "executor", to: "2.0.0-beta.52" },
    { tool: "mise", to: "2026.11.10" },
    { tool: "sfw", to: "1.17.0" },
    { tool: "codex", to: "0.171.0" },
  ]);

  expect(result).toBe(`name: t
# The tools.
tools:
  opencode: { version: 2.3.5, minimum_release_age: 0d }  # flow
  claude: '2.1.330'  # short, quoted
  executor:
    # Betas almost daily.
    minimum_release_age: 7d
    version: "2.0.0-beta.52"
  mise: 2026.11.10
  sfw: { version: 1.17.0, enabled: false }
  codex:
    version: 0.171.0
    minimum_release_age: 1d
# After tools.
references: []
`);
  expect(versionsOf(result)).toEqual({ opencode: "2.3.5", claude: "2.1.330", codex: "0.171.0", executor: "2.0.0-beta.52", mise: "2026.11.10", sfw: "1.17.0" });
});

test("a runtime tools doesn't list is added after its last entry, in the short form", () => {
  const text = "name: t\ntools:\n  executor:\n    version: 2.0.0-beta.49\n    minimum_release_age: 7d\n# Next.\nreferences: []\n";

  expect(setVersions(text, [{ tool: "claude", to: "2.1.330" }])).toBe("name: t\ntools:\n  executor:\n    version: 2.0.0-beta.49\n    minimum_release_age: 7d\n  claude: 2.1.330\n# Next.\nreferences: []\n");
  expect(setVersions("name: t\ntools:\n    opencode: 2.3.2", [{ tool: "sfw", to: "1.17.0" }])).toBe("name: t\ntools:\n    opencode: 2.3.2\n    sfw: 1.17.0\n");
});

test("a tools block the writer can't edit safely is left for the user", () => {
  expect(() => setVersions("name: t\ntools: { opencode: 2.3.2 }\n", [{ tool: "sfw", to: "1.17.0" }])).toThrow("set tools.sfw to 1.17.0 in office.yaml by hand");
});

test("batch lookup honors the age, leaves ranges and failed installs alone, and upgrades a shadowed machine pin", () => {
  const dir = mkdtempSync(join(tmpdir(), "office-upgrade-"));
  const project = '[tools]\nnode = "20"\njq = "1.7.1" # required\ngh = "2.75.0"\n';
  const machine = '[tools]\nnode = "18.0.0"\n';

  try {
    writeFileSync(join(dir, "office.yaml"), "name: test\nminimum_release_age: 5d\n");
    writeFileSync(join(dir, "mise.toml"), project);
    writeFileSync(join(dir, "machine.toml"), machine);
    writeFileSync(join(dir, "mise"), `#!/bin/sh
case "$1" in
  --version) echo 9999.1.0 ;;
  outdated)
    echo "$MISE_MINIMUM_RELEASE_AGE $*" >> batches
    case "$*" in
      *node@20*) echo '{"node":{"requested":"20","current":"20.5.0","latest":"24.0.0"},"jq":{"requested":"1.7.1","current":"1.7.1","latest":"1.8.0"},"gh":{"requested":"2.75.0","current":"2.75.0","latest":"2.80.0"}}' ;;
      *) echo '{"node":{"requested":"18.0.0","current":null,"latest":"24.0.0"}}' ;;
    esac ;;
  latest) [ "$2" = node@18.0.0 ] && echo 18.0.0 ;;
  install) [ "$2" != gh@2.80.0 ] ;;
  *) exit 1 ;;
esac
`, { mode: 0o755 });

    const result = Bun.spawnSync([process.execPath, join(import.meta.dir, "../cli.ts"), "upgrade-tools"], {
      cwd: dir, env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, XDG_DATA_HOME: dir },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toContain("gh 2.75.0 → 2.80.0: install failed");
    expect(readFileSync(join(dir, "batches"), "utf8").trim().split("\n")).toEqual([
      "5d outdated --bump --json -- node@20 jq@1.7.1 gh@2.75.0",
      "5d outdated --bump --json -- node@18.0.0",
    ]);
    expect(readFileSync(join(dir, "mise.toml"), "utf8")).toBe(project.replace("1.7.1", "1.8.0"));
    expect(readFileSync(join(dir, "machine.toml"), "utf8")).toBe(machine.replace("18.0.0", "24.0.0"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
