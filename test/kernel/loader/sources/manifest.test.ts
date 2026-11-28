import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { readPackageJson } from "../../../../src/loader/sources/manifest.ts";
import { definitionText } from "../../../support/test-package.ts";

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

const valid = definitionText('{}');

type Json = { exports?: Record<string, string>; private?: boolean; description?: string; office?: { definition: string; dependencies?: string[]; integrations?: Record<string, string> } };

const json = (name: string, definition: string, extra: Json = {}) => JSON.stringify({ name: `@office/${name}`, office: { definition }, ...extra });


test("package.json names the definition, the declared dependencies, what the package shares and, optionally, its description", () => {
  const exports = { "./token": "./lib/token.ts" };
  const dir = folder("case", { "package.json": json("case", "./src/definition.ts", { exports, private: true, description: "Notes for the office", office: { definition: "./src/definition.ts", dependencies: ["@office/tools"] } }), "src/definition.ts": valid });

  expect(readPackageJson(dir, "case")).toEqual({ ok: true, value: { description: "Notes for the office", definition: "src/definition.ts", dependencies: ["tools"], integrations: new Map(), exports } });
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
    ["dependency", { "package.json": json("dependency", "./office.ts", { office: { definition: "./office.ts", dependencies: ["tools"] } }), "office.ts": valid }, "package.json: office.dependencies[0]: must be an @office/<name> string"],
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

test("office.integrations maps each optional provider to a file inside the package, distinct from the package, the SDK and its required dependencies", () => {
  const outside = folder("integrations-outside", { "skills.ts": valid });
  const office = (integrations: Record<string, string>, dependencies: string[] = []) => ({ office: { definition: "./office.ts", dependencies, integrations } });
  const mapped = folder("mapped", { "package.json": json("mapped", "./office.ts", office({ "@office/skills": "./adapters/../skills.ts" })), "office.ts": valid, "skills.ts": valid });

  expect(readPackageJson(mapped, "mapped")).toMatchObject({ ok: true, value: { dependencies: [], integrations: new Map([["skills", "skills.ts"]]) } });

  for (const [name, integrations, reason, dependencies] of [
    ["self", { "@office/self": "./skills.ts" }, "office.integrations @office/self: names the package itself; remove it"],
    ["sdk", { "@office/sdk": "./skills.ts" }, "office.integrations @office/sdk: @office/sdk is always available, so it is no optional provider; remove it"],
    ["overlap", { "@office/skills": "./skills.ts" }, "office.integrations @office/skills: is also in office.dependencies; a provider is either required or optional, so remove one", ["@office/skills"]],
    ["escape", { "@office/skills": "../integrations-outside/skills.ts" }, "office.integrations @office/skills: ../integrations-outside/skills.ts is outside the package"],
    ["missing", { "@office/skills": "./absent.ts" }, "office.integrations @office/skills: ./absent.ts is not a file in the package"],
    ["unscoped", { skills: "./skills.ts" }, "package.json: office.integrations.skills: must be an @office/<name> string"],
  ] as const) {
    expect(readPackageJson(folder(name, { "package.json": json(name, "./office.ts", office(integrations, dependencies && [...dependencies])), "office.ts": valid, "skills.ts": valid }), name)).toEqual({ ok: false, errors: [reason] });
  }

  const linked = folder("integration-linked", { "package.json": json("integration-linked", "./office.ts", office({ "@office/skills": "./skills.ts" })), "office.ts": valid });
  symlinkSync(join(outside, "skills.ts"), join(linked, "skills.ts"));
  expect(readPackageJson(linked, "integration-linked")).toEqual({ ok: false, errors: ["office.integrations @office/skills: ./skills.ts links outside the package"] });

  // Valibot's record would drop these own keys, and take an array for a mapping.
  for (const [name, integrations, reason] of [
    ["proto", '{ "__proto__": "./skills.ts" }', "package.json: office.integrations.__proto__: must be an @office/<name> string"],
    ["constructor", '{ "constructor": "./skills.ts" }', "package.json: office.integrations.constructor: must be an @office/<name> string"],
    ["list", '["./skills.ts"]', "package.json: office.integrations: must map @office/<name> strings to module paths"],
    ["empty-list", "[]", "package.json: office.integrations: must map @office/<name> strings to module paths"],
  ] as const) {
    const text = `{ "name": "@office/${name}", "office": { "definition": "./office.ts", "integrations": ${integrations} } }`;

    expect(readPackageJson(folder(name, { "package.json": text, "office.ts": valid, "skills.ts": valid }), name)).toEqual({ ok: false, errors: [reason] });
  }
});

test("an integration module is a file of its own: not the definition or another provider's module under another path or through a link, though modules may share helpers", () => {
  const office = (integrations: Record<string, string>) => ({ office: { definition: "./office.ts", integrations } });
  const helper = 'import { shared } from "./shared.ts"; void shared;';
  const files = (name: string, integrations: Record<string, string>) => folder(name, { "package.json": json(name, "./office.ts", office(integrations)), "office.ts": valid, "skills.ts": helper, "apps.ts": helper, "shared.ts": "export const shared = 1;" });

  expect(readPackageJson(files("distinct", { "@office/skills": "./skills.ts", "@office/apps": "./apps.ts" }), "distinct")).toMatchObject({ ok: true, value: { integrations: new Map([["skills", "skills.ts"], ["apps", "apps.ts"]]) } });

  const definitionLink = files("definition-link", { "@office/skills": "./alias.ts" });
  symlinkSync("office.ts", join(definitionLink, "alias.ts"));
  const moduleLink = files("module-link", { "@office/skills": "./skills.ts", "@office/apps": "./adapters/apps.ts" });
  mkdirSync(join(moduleLink, "adapters"));
  symlinkSync("../skills.ts", join(moduleLink, "adapters/apps.ts"));

  for (const [dir, reason] of [
    [files("definition-path", { "@office/skills": "./adapters/../office.ts" }), "office.integrations @office/skills: ./adapters/../office.ts is the same file as office.definition; give each integration a module of its own"],
    [definitionLink, "office.integrations @office/skills: ./alias.ts is the same file as office.definition; give each integration a module of its own"],
    [files("module-path", { "@office/skills": "./skills.ts", "@office/apps": "skills.ts" }), "office.integrations @office/apps: skills.ts is the same file as office.integrations @office/skills; give each integration a module of its own"],
    [moduleLink, "office.integrations @office/apps: ./adapters/apps.ts is the same file as office.integrations @office/skills; give each integration a module of its own"],
  ] as const) {
    expect(readPackageJson(dir, dir.split("/").at(-1) ?? "")).toEqual({ ok: false, errors: [reason] });
  }
});
