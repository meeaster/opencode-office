import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "yaml";

const packageDir = join(import.meta.dir, "..");

// `office apps deploy` replaces executor-app/package.ts with one generated from the office's
// resolved settings; the app is type-checked against the copy in the package, so it must hold the
// same settings with their defaults.
test("the app's package.ts holds every setting of package.yaml at its default", async () => {
  const manifest: { settings: Record<string, { default: string | number | boolean }> } = parse(readFileSync(join(packageDir, "package.yaml"), "utf8"));
  const { settings }: { settings: Record<string, string | number | boolean> } = await import(join(packageDir, "executor-app/package.ts"));
  const defaults = Object.fromEntries(Object.entries(manifest.settings).map(([key, setting]) => [key, setting.default]));

  expect(settings).toEqual(defaults);
});

test("the app is gated on the executor_app setting, which is off by default", () => {
  const manifest: { executor_app: { setting: string }; settings: Record<string, { default: unknown }> } = parse(readFileSync(join(packageDir, "package.yaml"), "utf8"));

  expect(manifest.executor_app.setting).toBe("executor_app");
  expect(manifest.settings.executor_app?.default).toBe(false);
});
