// Writes a package for a test: its definition and the package.json that names it.
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { floors } from "../packages/office/floors.ts";
import { activate, type AppliedExecutable, type AppliedTool } from "../standard/tools/applied.ts";
import { defaultPins } from "./versions.ts";

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

/** A seed as a test package declares it to the seeds package: a destination and one of source and text. */
export type TestSeed = { destination: string; source: string } | { destination: string; text: string };

/**
 * A definition that declares `seeds` in its setup, through a handle with the seeds registry's id
 * (handles match by id), so a package run from source needs no `@office/seeds` import.
 */
export function seedingDefinition(seeds: TestSeed[]) {
  return definitionText(`{ setup(ctx) { for (const seed of ${JSON.stringify(seeds)}) ctx.add({ id: "seeds.seed", parse: value => value }, seed); } }`);
}

/** A definition whose `sync` writes `text` to `file` in the office, so a test sees whether, and from which version, it ran. */
export function markingDefinition(file: string, text: string, fields = "") {
  return definitionText(`{ ${fields}${fields ? ", " : ""}sync({ office }) { mkdirSync(dirname(join(office.dir, ${JSON.stringify(file)})), { recursive: true }); writeFileSync(join(office.dir, ${JSON.stringify(file)}), ${JSON.stringify(text)}); } }`, 'import { mkdirSync, writeFileSync } from "node:fs"; import { dirname, join } from "node:path";');
}

/**
 * A definition that registers its `directory` as its OpenCode server plugin and, with `panel`, that
 * bundle as its desktop panel; `fields` are more of its fields, each followed by a comma. Write it
 * with `{ dependencies: ["opencode"] }`; from source, its office must have synced once before.
 */
export function pluginDefinition(directory = "plugin", { panel, fields = "" }: { panel?: string; fields?: string } = {}) {
  const calls = [`opencode.plugins.add(ctx, ${JSON.stringify({ directory })});`, ...(panel === undefined ? [] : [`opencode.panels.add(ctx, ${JSON.stringify({ file: panel })});`])];

  return definitionText(`{ ${fields} setup(ctx) { ${calls.join(" ")} } }`, 'import { opencode } from "@office/opencode";');
}

/** The office package's shared tools by the backends mise's registry names, each at its floor, with the executables it exposes. */
export const officeTools = [
  { short: "sops", tool: "aqua:getsops/sops", version: floors.sops, bin: ["sops"] },
  { short: "age", tool: "aqua:FiloSottile/age", version: floors.age, bin: ["age", "age-keygen"] },
  { short: "gh", tool: "aqua:cli/cli", version: floors.gh, bin: ["gh"] },
  { short: "pre-commit", tool: "aqua:pre-commit/pre-commit", version: floors["pre-commit"], bin: ["pre-commit"] },
];

/** `mise registry --json` entries for the office package's tools, for a fake mise's registry. */
export const officeRegistry = officeTools.map(({ short, tool }) => ({ short, backends: [tool] }));

/** A shell line for a fake mise script: it answers `mise registry --json` with the built-ins' short names, as a host-mode office reads them. */
export const fakeRegistry = `[ "$1" != registry ] || { echo '${JSON.stringify([...officeRegistry, { short: "bun", backends: ["core:bun"] }, { short: "aws-cli", backends: ["aqua:aws/aws-cli"] }])}'; exit 0; }\n`;

/** A dry run's lines planning the office package's tools at their floors, as `mise upgrade --bump --dry-run` prints them. */
export const officePlan = officeTools.map(({ tool, version }) => `Would install ${tool}@${version}\n`).join("");

/** Whether a tool is one of the office package's, which every host-mode office requires. */
export function isOfficeTool(name: string): boolean {
  return officeTools.some(({ tool }) => tool === name);
}

/**
 * office.lock's `tools:` section recording the office package's shared tools at their floors,
 * so a host-mode office's sync finds them served and asks mise
 * nothing; `more` adds lines such as `  core:bun: { version: 1.4.4 }`.
 */
export function sharedToolsLock(...more: string[]): string {
  return ["tools:", ...officeTools.map(({ tool, version }) => `  ${tool}: { version: ${version} }`), ...more, ""].join("\n");
}

/** The other built-ins' shared tools at the versions the definition fixture's office.lock records, for a fixture that runs a host-mode up. */
export const builtinTools = [
  { short: "npm:agent-browser", tool: "npm:agent-browser", version: "0.43.0", bin: ["agent-browser"] },
  { short: "bun", tool: "core:bun", version: "1.4.4", bin: ["bun"] },
  { short: "aws-cli", tool: "aqua:aws/aws-cli", version: "2.40.4", bin: ["aws"] },
];

/** The applied record of `state` with the office package's tools, and `more`, active at their floors, as stand-in executables in `state` with their SHA-256. */
export function applyOfficeTools(state: string, more: readonly (typeof officeTools)[number][] = []): void {
  const folder = join(state, "tools/fixture");
  const tools = new Map<string, AppliedTool>();

  mkdirSync(folder, { recursive: true });

  for (const { short, tool, version, bin } of [...officeTools, ...more]) {
    const executables = bin.map((name): [string, AppliedExecutable] => {
      const text = `#!/bin/sh\necho "${name} ${version}"\n`;

      writeFileSync(join(folder, name), text, { mode: 0o755 });

      return [name, { path: join(folder, name), sha256: `sha256:${createHash("sha256").update(text).digest("hex")}` }];
    });

    tools.set(tool, { version, identity: executables.map(([name, { sha256 }]) => `${name} ${sha256}`).join(", "), names: [short], bin: Object.fromEntries(executables) });
  }

  activate({ state }, { tools, highest: new Map([...officeTools, ...more].map(({ tool, version }) => [tool, version])) });
}

/**
 * A stand-in for the mise version the tests' offices pin, as `folder/mise`: the shared tools run
 * only that version (standard/tools/registry.ts). It reports the pin and hands every other call,
 * such as the offline registry, to `machineMise`, the runner's own.
 */
export function pinnedMise(folder: string, machineMise: string): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "mise"), `#!/bin/sh\n[ "$*" != --version ] || { echo "${defaultPins.mise.version} (test double)"; exit 0; }\nexec '${realpathSync(machineMise)}' "$@"\n`, { mode: 0o755 });
}
