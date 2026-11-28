import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadOffice } from "../../../../src/office.ts";
import { installedPackages } from "../../../../src/loader/definitions/inventory.ts";
import { requiredPackages } from "../../../../src/loader/sources/selection.ts";
import { publishAppliedSettings } from "../../../../src/applied-settings.ts";
import { readAppliedSettings } from "../../../../sdk/applied-settings.ts";
import { definitionText, settingsSchema, writePackage } from "../../../support/test-package.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-packages-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** The office's package named `name`, read with its settings. */
function read(office: string, name: string) {
  const loaded = loadOffice(office);
  // The fixtures exercise one package; the required packages aren't part of this inventory.
  const skip = new Set(requiredPackages.filter(required => required !== name));
  const inventory = installedPackages(loaded, skip);
  const item = inventory.installed.find(candidate => candidate.entry.name === name);

  if (item) return { loaded, result: { ok: true as const, value: item } };

  const errors = inventory.problems.filter(problem => problem.packages.includes(name)).map(problem => problem.message);
  const settings = inventory.invalidSettings.filter(problem => problem.packages.includes(name)).map(problem => problem.message);

  return { loaded, result: { ok: false as const, errors, settings } };
}

test("settings are one JSON Schema, checked with its defaults applied: types, unknown and required settings, nested $defs, and none when undeclared", () => {
  const path = join(dir, "packages/demo/office.ts");

  const define = (body: string) => {
    delete require.cache[path];
    writePackage(path, definitionText(body));
  };

  const config = (settings: string) => write(join(dir, "office.yaml"), `name: t\npackages:\n  - name: demo\n    settings: ${settings}\n`);

  const errors = (settings: string) => {
    config(settings);
    const { result } = read(dir, "demo");

    return result.ok ? [] : result.errors;
  };

  const nested = `{ settings: {
    type: "object",
    additionalProperties: false,
    properties: {
      port: { type: "integer", default: 4566 },
      enabled: { type: "boolean", default: true },
      roles: { type: "object", properties: { review: { type: "array", items: { $ref: "#/$defs/model" } } } },
    },
    $defs: { model: { enum: ["fast", "deep"] } },
  } }`;

  define(nested);
  config("{ port: 4600, roles: { review: [fast, deep] } }");

  const { loaded, result } = read(dir, "demo");

  if (!result.ok) throw new Error(result.errors.join("\n"));

  publishAppliedSettings(loaded, [result.value]);
  expect(readAppliedSettings(dir, "demo")).toEqual({ port: 4600, enabled: true, roles: { review: ["fast", "deep"] } });
  expect(errors("{ roles: { review: [other] } }")).toEqual(["packages.demo.settings.roles.review.0: must be equal to one of the allowed values"]);
  // A quoted port is text, not an integer.
  expect(errors('{ port: "4600" }')).toEqual(["packages.demo.settings.port: must be integer"]);
  expect(errors("{ colour: blue }")).toEqual(["packages.demo.settings.colour: the package declares no such setting; remove it from office.yaml"]);

  define(`{ settings: ${settingsSchema({ title: "Shared" }, { url: "string" })} }`);
  expect(errors("{}")).toEqual(["packages.demo.settings.url: is required; add it to office.yaml"]);
  expect(errors("{ url: https://example.com/site }")).toEqual([]);
  expect(read(dir, "demo").result).toMatchObject({ ok: true, value: { settings: { url: "https://example.com/site", title: "Shared" } } });

  // A package that declares no settings accepts none.
  define("{}");
  expect(errors("{ label: x }")).toEqual(["packages.demo.settings.label: the package declares no such setting; remove it from office.yaml"]);

  // The root is an object schema; a removed key is an unknown one; an invalid schema names the file.
  const root = 'its root must have type: "object"';

  define('{ settings: { type: "array" } }');
  expect(errors("{}")).toEqual([`packages/demo/office.ts: settings: ${root}`]);
  define('{ settings: { $ref: "#/$defs/all" } }');
  expect(errors("{}")).toEqual([`packages/demo/office.ts: settings: ${root}`]);
  define("{ settings: null }");
  expect(read(dir, "demo").result).toMatchObject({ ok: false, errors: ["packages/demo/office.ts: settings: must be a JSON Schema object"], settings: ["packages/demo/office.ts: settings: must be a JSON Schema object"] });
  define('{ settings_schema: { type: "object" } }');
  expect(errors("{}")).toEqual([expect.stringContaining("packages/demo/office.ts: settings_schema: must be a mapping of ")]);
  define(nested.replace('type: "boolean"', 'type: "invalid"'));
  expect(errors("{}")).toEqual([expect.stringContaining("packages/demo/office.ts: settings: schema is invalid")]);
});

test("two packages' schemas with the same $id each validate, with their own $refs and defaults", () => {
  const schema = (type: string, value: string) => definitionText(`{ settings: {
    $id: "https://example.com/settings", type: "object", additionalProperties: false,
    properties: { size: { $ref: "#/$defs/size" }, label: { type: "string", default: "${value}" } },
    $defs: { size: { type: "${type}" } },
  } }`);

  writePackage(join(dir, "packages/one/office.ts"), schema("integer", "one"));
  writePackage(join(dir, "packages/two/office.ts"), schema("string", "two"));
  write(join(dir, "office.yaml"), "name: t\npackages:\n  - name: one\n    settings: {size: 3}\n  - name: two\n    settings: {size: large}\n");

  expect(read(dir, "one").result).toMatchObject({ ok: true, value: { settings: { size: 3, label: "one" } } });
  expect(read(dir, "two").result).toMatchObject({ ok: true, value: { settings: { size: "large", label: "two" } } });
  write(join(dir, "office.yaml"), "name: t\npackages:\n  - name: one\n    settings: {size: large}\n  - name: two\n    settings: {size: 3}\n");
  expect(read(dir, "one").result).toMatchObject({ ok: false, errors: ["packages.one.settings.size: must be integer"] });
  expect(read(dir, "two").result).toMatchObject({ ok: false, errors: ["packages.two.settings.size: must be string"] });
});
