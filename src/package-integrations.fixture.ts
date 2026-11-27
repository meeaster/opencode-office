// The optional-integrations example packages in a compiled office: copies of
// examples/optional-integrations/packages, whose integration modules record in $PROBE that they
// were evaluated, and the example's stand-in runtime, which reads the
// office's applied settings as a separate process.
import { expect } from "bun:test";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DefinitionFixture } from "./package-definition.fixture.ts";
import { toolPath } from "./tool.ts";

const example = toolPath("examples/optional-integrations/packages");

/** The modules that record their evaluation, by package. */
const probed = { "review-kit": "skills.ts", "chatgpt-routing": "executor.ts" };

/** Copies the example packages into the office's packages/, each integration module recording `<package>/<module>`. */
export function copyExample(f: DefinitionFixture) {
  cpSync(example, join(f.dir, "packages"), { recursive: true });

  for (const [name, module] of Object.entries(probed)) {
    const path = join(f.dir, "packages", name, module);

    writeFileSync(path, `import { appendFileSync } from "node:fs";\nappendFileSync(process.env.PROBE ?? "", ${JSON.stringify(`${name}/${module}\n`)});\n${readFileSync(path, "utf8")}`);
  }
}

/** The modules evaluated since the last call, in order; clears the record. */
export function evaluated(f: DefinitionFixture) {
  if (!existsSync(f.probe)) return [];
  const lines = readFileSync(f.probe, "utf8").split("\n").filter(Boolean);

  rmSync(f.probe);

  return lines;
}

/** A package command's standard output from the executable `exe`, parsed as JSON; the command must succeed. */
export function json(exe: string, f: DefinitionFixture, ...args: string[]) {
  const result = Bun.spawnSync([exe, "--office", f.dir, ...args], { cwd: f.dir, env: f.env });

  expect(result.exitCode, result.stderr.toString()).toBe(0);

  return JSON.parse(result.stdout.toString());
}

/** What the example's stand-in runtime reads from the applied settings, run by Bun as its own process. */
export function runtime(f: DefinitionFixture) {
  const result = Bun.spawnSync([process.execPath, "--no-install", join(f.dir, "packages/chatgpt-routing/runtime.ts")], { cwd: f.dir, env: { ...f.env, PATH: process.env.PATH } });

  expect(result.exitCode, result.stderr.toString()).toBe(0);

  return JSON.parse(result.stdout.toString());
}
