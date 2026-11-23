import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readDefinition } from "./package-definition.ts";
import { readPackageJson } from "./package-manifest.ts";
import { definitionText, packageJsonText } from "./test-package.ts";

let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "office-definition-unit-")); });

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

// Each case gets its own folder: Bun caches a required definition by path.
function folder(name: string, files: Record<string, string>) {
  const dir = join(root, name);
  mkdirSync(dir);

  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }

  return dir;
}

const definition = (name: string, files: Record<string, string>) => readDefinition(folder(name, files), name, `packages/${name}`);
const valid = definitionText('{}');

type Json = { exports?: Record<string, string>; private?: boolean; description?: string; office?: { definition: string; dependencies: string[] } };

const json = (name: string, definition: string, extra: Json = {}) => JSON.stringify({ name: `@office/${name}`, office: { definition }, ...extra });

test("package.json names the definition, the declared dependencies, what the package shares and, optionally, its description", () => {
  const exports = { "./token": "./lib/token.ts" };
  const dir = folder("case", { "package.json": json("case", "./src/definition.ts", { exports, private: true, description: "Notes for the office", office: { definition: "./src/definition.ts", dependencies: ["@office/tooling"] } }), "src/definition.ts": valid });

  expect(readPackageJson(dir, "case")).toEqual({ ok: true, value: { description: "Notes for the office", definition: "src/definition.ts", dependencies: ["tooling"], exports } });
});

test("a package.json that can't name the definition says what is wrong, naming the path or the names", () => {
  const outside = folder("outside", { "office.ts": valid });

  for (const [name, files, reason] of [
    ["missing", { "office.ts": valid }, 'no package.json; add a package.json with "name": "@office/missing", an optional "description" and "office": { "definition": "./office.ts" }'],
    ["invalid", { "package.json": "{" }, "package.json: JSON Parse error: Expected '}'"],
    ["renamed", { "package.json": json("other", "./office.ts"), "office.ts": valid }, "package.json names @office/other; expected @office/renamed"],
    ["undefined", { "package.json": JSON.stringify({ name: "@office/undefined", office: {} }) }, "package.json: office.definition: must give the definition's path inside the package"],
    ["parent", { "package.json": json("parent", "../outside/office.ts") }, "office.definition ../outside/office.ts is outside the package"],
    ["absent", { "package.json": json("absent", "./office.ts") }, "office.definition ./office.ts is not a file in the package"],
    ["dependency", { "package.json": json("dependency", "./office.ts", { office: { definition: "./office.ts", dependencies: ["tooling"] } }), "office.ts": valid }, "package.json: office.dependencies[0]: must be an @office/<name> string"],
  ] as const) {
    expect(readPackageJson(folder(name, files), name)).toEqual({ ok: false, errors: [reason] });
  }

  const linked = folder("linked", { "package.json": json("linked", "./office.ts") });
  symlinkSync(join(outside, "office.ts"), join(linked, "office.ts"));
  expect(readPackageJson(linked, "linked")).toEqual({ ok: false, errors: ["office.definition ./office.ts links outside the package"] });

  // A filesystem error is a problem naming the path, not an exception.
  const loop = folder("loop", { "package.json": json("loop", "./office.ts") });
  symlinkSync("office.ts", join(loop, "office.ts"));
  const looped = readPackageJson(loop, "loop");
  expect(looped.ok).toBe(false);
  expect(!looped.ok && looped.errors[0]).toContain(join(loop, "office.ts"));

  // The advice for a missing package.json depends on where the package comes from.
  const old = folder("old", { "office.ts": valid });
  expect(readPackageJson(old, "old", "built-in")).toEqual({ ok: false, errors: ["no package.json; the copy isn't this office executable's; run office sync"] });
  expect(readPackageJson(old, "old", "remote")).toEqual({ ok: false, errors: ['no package.json; its repository needs a package.json with "name": "@office/old", an optional "description" and "office": { "definition": … }; then run office packages update'] });
});

test("a definition loads from the path package.json names, as Package.define's result or a package.yaml; a plain module object doesn't", () => {
  // No entrypoint is imported here: readDefinition registers the executable's SDK itself. Neither
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
