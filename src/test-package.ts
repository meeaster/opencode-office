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

/** Writes the definition `file` (office.ts, package.yaml, …) with `text`, and its package's package.json. */
export function writePackage(file: string, text: string, options: PackageOptions = {}) {
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, text);
  writeFileSync(join(dir, "package.json"), packageJsonText(options.name ?? basename(dir), basename(file), options));
}
