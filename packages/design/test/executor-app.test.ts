import { expect, test } from "bun:test";
import type { SettingValue } from "@office/sdk";
import { defaultOffSetting, settingProperties } from "../../../src/schema.ts";
import { settings } from "../executor-app/package.ts";
import manifest from "../office.ts";

// `office apps deploy` replaces executor-app/package.ts with one generated from the office's
// resolved settings; the app is type-checked against the copy in the package, so it must hold the
// same settings with their defaults.
test("the app's package.ts holds every declared setting at its default", () => {
  const defaults: Record<string, SettingValue> = Object.fromEntries(Object.entries(manifest.settings?.properties ?? {}).map(([key, setting]) => [key, setting.default]));

  expect(defaults).toEqual(settings);
});

test("the app is gated on the executor_app setting, a boolean that is off by default", () => {
  expect(manifest.executor_app?.setting).toBe("executor_app");
  expect(Object.keys(settingProperties(manifest.settings ?? {}))).toContain("executor_app");
  expect(defaultOffSetting(manifest.settings ?? {}, "executor_app")).toBe(true);
});
