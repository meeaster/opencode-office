import { expect, test } from "bun:test";

import { schemaSettings } from "../../../../src/loader/definitions/settings.ts";
import { MalformedSettings, parseManifest } from "../../../../src/loader/sources/manifest-schema.ts";

test("removed definition fields fail with the usual unknown-key error", () => {
  for (const key of ["tools", "system"]) {
    expect(parseManifest("demo", { [key]: {} })).toMatchObject({
      ok: false, errors: [expect.stringContaining(`${key}: must be a mapping of`)],
    });
  }

  for (const key of ["tools", "install", "services", "env", "setting"]) {
    expect(parseManifest("demo", { host: { path: ["bin"], [key]: {} } })).toEqual({
      ok: false, errors: [`host.${key}: must be a mapping of the fields this schema knows`],
    });
  }
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
