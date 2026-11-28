import { expect, test } from "bun:test";

import { schemaSettings } from "../../../../src/loader/definitions/settings.ts";
import { MalformedSettings, parseManifest } from "../../../../src/loader/sources/manifest-schema.ts";
import type { SettingValue } from "../../../../src/schema.ts";

test("a setting that gates a host block or a host service is a boolean; one that gates a system setup also defaults to off", () => {
  const settings = { type: "object", properties: { on: { type: "boolean", default: true }, off: { type: "boolean", default: false }, text: { type: "string", default: "x" } } };
  const system = (setting: string) => ({ setting, description: "D", platforms: ["ubuntu-24.04-amd64-wsl"], bootstrap: "system/b.toml", ready: ["/usr/bin/d"] });

  const gates = {
    "host.setting": (setting: string) => ({ host: { setting } }),
    "host.services": (setting: string) => ({ host: { services: { watch: { description: "Watch", script: "watch.sh", setting } } } }),
  };

  const problems = (definition: Record<string, SettingValue>) => {
    const read = parseManifest("demo", { settings, ...definition });

    return read.ok ? [] : read.errors;
  };

  for (const [path, gate] of Object.entries(gates)) {
    expect(problems(gate("on"))).toEqual([]);
    expect(problems(gate("text"))).toEqual([expect.stringMatching(new RegExp(`^${path.replace(".", "\\.")}: .*declared type: boolean`))]);
    expect(problems(gate("missing"))).toHaveLength(1);
  }

  expect(problems({ system: system("off") })).toEqual([]);
  expect(problems({ system: system("on") })).toEqual(["system.setting: must name one of the package's settings declared type: boolean with default: false: an office opts in"]);
  expect(problems({ system: system("text") })).toHaveLength(1);
});

test("a secret can't share a variable with a setting the schema declares, set in office.yaml or not", () => {
  const read = parseManifest("demo", { settings: { type: "object", properties: { key: { type: "string" } } }, secrets: { DEMO_KEY: { generate: "hex", bytes: 16 } } });

  expect(read).toEqual({ ok: false, errors: ["secrets: DEMO_KEY is also the variable of the setting key"] });
});

test("malformed settings leave commands readable and are rejected when validating settings", () => {
  const read = parseManifest("demo", {
    settings: null,
    commands: { hello: { summary: "Say hello", result: () => "hello" } },
  });

  if (!read.ok) throw new Error(read.errors.join("\n"));

  expect(read.value.commands.hello?.result).toBeFunction();
  expect(read.value.settings).toBeInstanceOf(MalformedSettings);
  expect(schemaSettings({ entry: { name: "demo", settings: {}, source: undefined } }, read.value, "office.ts")).toEqual({
    ok: false,
    errors: ["office.ts: settings: must be a JSON Schema object"],
  });
});
