// The package authoring examples under strict TypeScript. The optional-integrations one: it passes with the providers'
// sources as development types, its negative twin fails exactly where a setting or an entry is
// wrong, and without a provider's types only the adapter's import of it fails.
import { expect, test } from "bun:test";
import { join } from "node:path";

const checkout = join(import.meta.dir, "..");
const example = join(checkout, "examples/optional-integrations");

function typecheck(project: string) {
  const result = Bun.spawnSync([join(checkout, "node_modules/.bin/tsc"), "--pretty", "false", "-p", join(example, project)], { cwd: checkout });

  return { status: result.exitCode, diagnostics: result.stdout.toString().trim().split("\n").filter(Boolean).map(line => line.replace(/: error (TS\d+): .*/, " $1")) };
}

test("the author example typechecks; a misspelled setting, in an adapter or a base setup, a wrongly typed app tool, an unknown skill field and a forged contributor field don't; a missing provider fails only its adapter's import", () => {
  expect(typecheck(".")).toEqual({ status: 0, diagnostics: [] });
  expect(typecheck("negative")).toEqual({ status: 1, diagnostics: [
    "examples/optional-integrations/negative/executor.ts(9,86) TS2322",
    "examples/optional-integrations/negative/executor.ts(10,39) TS2551",
    "examples/optional-integrations/negative/executor.ts(11,23) TS2353",
    "examples/optional-integrations/negative/executor.ts(12,45) TS2353",
    "examples/optional-integrations/negative/executor.ts(19,22) TS2551",
  ] });
  expect(typecheck("no-provider-types")).toEqual({ status: 1, diagnostics: ["examples/optional-integrations/packages/chatgpt-routing/executor.ts(1,22) TS2307"] });
});

test("the package-work author example typechecks under strict TypeScript", () => {
  const result = Bun.spawnSync([join(checkout, "node_modules/.bin/tsc"), "--pretty", "false", "-p", join(checkout, "examples/package-work")], { cwd: checkout });

  expect({ status: result.exitCode, output: result.stdout.toString().trim() }).toEqual({ status: 0, output: "" });
});
