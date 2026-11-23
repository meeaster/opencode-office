// Writes a package for a test: its definition and the package.json that names it.
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export type PackageOptions = {
  /** The name the office selects it under; defaults to the folder's name. */
  name?: string;
  dependencies?: string[];
  exports?: unknown;
};

/** The package.json of a package selected as `name` whose definition is `definition`. */
type PackageJson = { name: string; exports?: unknown; office: { definition: string; dependencies?: string[] } };

export function packageJsonText(name: string, definition = "office.ts", { dependencies, exports }: Omit<PackageOptions, "name"> = {}) {
  const json: PackageJson = { name: `@office/${name}`, office: { definition: `./${definition}` } };

  if (exports !== undefined) json.exports = exports;

  if (dependencies) json.office.dependencies = dependencies.map(dep => `@office/${dep}`);

  return `${JSON.stringify(json, null, 2)}\n`;
}

type SettingType = "string" | "integer" | "number" | "boolean";

/**
 * A settings schema as JSON, which reads the same in a definition module and a package.yaml: each
 * of `defaults` typed by its value, and each of `required` with its type and no default.
 */
export function settingsSchema(defaults: Record<string, string | number | boolean>, required: Record<string, SettingType> = {}) {
  const type = (value: string | number | boolean): SettingType => typeof value === "number" ? Number.isInteger(value) ? "integer" : "number" : typeof value === "string" ? "string" : "boolean";

  const properties = Object.fromEntries([
    ...Object.entries(defaults).map(([key, value]) => [key, { type: type(value), default: value }]),
    ...Object.entries(required).map(([key, value]) => [key, { type: value }]),
  ]);

  const schema = { type: "object", additionalProperties: false, properties };

  return JSON.stringify(Object.keys(required).length ? { ...schema, required: Object.keys(required) } : schema);
}

/**
 * The source of a definition module whose default export is `Package.define(<body>)`: `body` is
 * the object's source, and `prelude` any statements before it (imports, a marker).
 */
export function definitionText(body: string, prelude = "") {
  return `import { Package } from "@office/sdk";\n${prelude}\nexport default Package.define(${body});\n`;
}

/**
 * Writes the definition `file` (office.ts, package.yaml, …) with `text`, and its package's
 * package.json. A module definition's `text` is usually `definitionText(...)`; raw text is for a
 * YAML definition, a broken one, or another filename.
 */
export function writePackage(file: string, text: string, options: PackageOptions = {}) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, text);
  writeFileSync(join(dir, "package.json"), packageJsonText(options.name ?? basename(dir), basename(file), options));
}
