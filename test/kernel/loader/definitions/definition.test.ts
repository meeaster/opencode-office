import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { installedDefinition } from "../../../../src/loader/definitions/inventory.ts";
import { definitionText, packageJsonText } from "../../../support/test-package.ts";

let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "office-definition-unit-")); });

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

// Each case gets its own folder: Bun caches a required definition by path.
function folder(name: string, files: Record<string, string>) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });

  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }

  return dir;
}

const valid = definitionText('{}');


function definition(name: string, files: Record<string, string>) {
  return installedDefinition({ dir: root }, {
    entry: { name, settings: {}, source: undefined },
    kind: "local",
    dir: folder(`packages/${name}`, files),
  });
}

test("a definition loads from the path package.json names, as Package.define's result or a package.yaml; a plain module object doesn't", () => {
  // Reading a definition registers the executable's SDK itself. Neither
  // package.json has a description.
  expect(definition("module", { "package.json": packageJsonText("module", "src/definition.ts"), "src/definition.ts": valid })).toMatchObject({ ok: true, value: { file: "packages/module/src/definition.ts", manifest: { namespace: "module" } } });
  expect(definition("yaml", { "package.json": packageJsonText("yaml", "package.yaml"), "package.yaml": "namespace: notes\n", "office.ts": 'throw new Error("not the definition")' })).toMatchObject({ ok: true, value: { file: "packages/yaml/package.yaml", manifest: { namespace: "notes" } } });
  expect(definition("plain", { "package.json": packageJsonText("plain"), "office.ts": 'export default {}' })).toEqual({
    ok: false, errors: ["packages/plain/office.ts: the definition must be the result of Package.define from @office/sdk"],
  });
});

test("a definition that cannot be read names its file and reason, whatever went wrong", () => {
  for (const [name, files, reason] of [
    ["thrown", { "package.json": packageJsonText("thrown"), "office.ts": 'throw new Error("bad notes import")' }, "packages/thrown/office.ts: bad notes import"],
    ["shape", { "package.json": packageJsonText("shape"), "office.ts": definitionText('{ setup: "handler.ts" }') }, "packages/shape/office.ts: setup:"],
    ["named", { "package.json": packageJsonText("named"), "office.ts": definitionText('{ name: "named" }') }, "packages/named/office.ts: name: must be a mapping of"],
    ["described", { "package.json": packageJsonText("described", "package.yaml"), "package.yaml": "description: Notes\n" }, "packages/described/package.yaml: description: must be a mapping of"],
    ["none", { "office.ts": valid }, "packages/none: no package.json; add a package.json with \"name\": \"@office/none\""],
  ] as const) {
    const read = definition(name, files);

    expect(read.ok).toBe(false);
    expect(read.ok ? "" : read.errors.join("\n")).toContain(reason);
  }
});

test("loading a definition lists the providers package.json maps without importing their modules; a definition still declaring an activation policy or an Executor app fails on the unknown key", () => {
  const thrower = 'throw new Error("integration module imported")';

  const files = (name: string, body: string) => ({
    "package.json": JSON.stringify({ name: `@office/${name}`, office: { definition: "./office.ts", integrations: { "@office/skills": "./skills.ts" } } }),
    "office.ts": definitionText(body),
    "skills.ts": thrower,
  });

  expect(definition("plain", files("plain", "{}"))).toMatchObject({ ok: true, value: { integrations: [{ provider: "skills", module: "skills.ts" }] } });

  for (const [name, body, key] of [
    ["requested", '{ integrations: { "@office/skills": { requested: () => true } } }', "integrations"],
    ["by-default", '{ integrations: { "@office/skills": { enabledByDefault: true } } }', "integrations"],
    ["executor-app", "{ executor_app: {} }", "executor_app"],
  ] as const) {
    expect(definition(name, files(name, body))).toEqual({ ok: false, errors: [`packages/${name}/office.ts: ${key}: must be a mapping of namespace, settings, commands, setup, sync, fullSync, session, check, up, down, committed, secrets, tools, host, system and spawns`] });
  }
});
