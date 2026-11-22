import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { parse } from "yaml";
import type { PackageContext, SettingValue } from "../packages/office/package-context.ts";
import { readPackageJson } from "./package-manifest.ts";
import { check, type PackageManifest, packageManifestSchema, type Parsed, scalarSetting, settingVariable } from "./schema.ts";

type Registrations = Omit<PackageContext, "booleanSetting" | "scalarSetting">;

/** Setup owns declarations not present in the static manifest. Validate the complete override
 * only after that revision's setup has finished, including any conditional declarations. */
export async function runPackageSetup(manifest: PackageManifest, overrides: Readonly<Record<string, SettingValue>>, context: Registrations) {
  const declared = new Set(Object.keys(manifest.settings));
  const scalars: Record<string, string | number | boolean> = {};
  await manifest.setup?.(setupContext(context, overrides, declared, scalars));

  for (const key of Object.keys(scalars)) {
    if (manifest.secrets[settingVariable(manifest.namespace, key)] || manifest.settings_schema) throw new Error(`settings.${key}: conflicts with a secret or settings_schema`);
  }

  if (!manifest.settings_schema) {
    for (const key of Object.keys(overrides)) if (!declared.has(key)) throw new Error(`settings.${key}: ${manifest.name} has no such setting`);
  }

  return { scalars };
}

function setupContext(context: Registrations, settings: Readonly<Record<string, SettingValue>>, declared: Set<string>, scalars: Record<string, string | number | boolean>): PackageContext {
  const booleanSetting: PackageContext["booleanSetting"] = (name, definition) => {
    if (!/^[a-z][a-z0-9_]*$/.test(name) || !v.is(v.pipe(v.string(), v.nonEmpty()), definition.description) || !v.is(v.boolean(), definition.default) || declared.has(name)) throw new Error(`invalid or duplicate boolean setting ${name}`);
    const value = Object.hasOwn(settings, name) ? settings[name] : definition.default;

    if (!v.is(v.boolean(), value)) throw new Error(`settings.${name}: must be true or false`);
    declared.add(name);

    return value;
  };

  const scalar: PackageContext["scalarSetting"] = (name, definition) => {
    if (!/^[a-z][a-z0-9_]*$/.test(name) || !v.is(v.pipe(v.string(), v.nonEmpty()), definition.description) || !v.is(scalarSetting, definition.default) || declared.has(name)) throw new Error(`invalid or duplicate scalar setting ${name}`);
    const value = Object.hasOwn(settings, name) ? settings[name] : definition.default;

    if (!v.is(scalarSetting, value)) throw new Error(`settings.${name}: must be text, a number or true/false`);
    declared.add(name);
    scalars[name] = value;

    return value;
  };

  // Diagnose a misplaced cron registration even when untyped setup guards it with `?.`.
  return Object.defineProperty({ ...context, booleanSetting, scalarSetting: scalar }, "cron", {
    get() { throw new Error("ctx.cron belongs in registerCron(ctx), not setup(ctx)"); },
  });
}

/**
 * Read one definition: the file the package's package.json names in `office.definition`, loaded
 * from `root` (the folder itself, or the set's link to it) after `verifyCopy` passes. A `.yaml` or
 * `.yml` file is a package.yaml; any other is a module. Both go through the same validation and defaults.
 */
export function readDefinition(dir: string, name: string, where: string, { verifyCopy, root = dir }: { verifyCopy?: () => void; root?: string } = {}): Parsed<{ manifest: PackageManifest; file: string }> {
  let file = where;

  try {
    // A pulled-in copy is checked against its record first, its package.json included.
    verifyCopy?.();
    const json = readPackageJson(dir, name);

    if (!json.ok) return { ok: false, errors: json.errors.map(error => `${where}: ${error}`) };
    const { definition } = json.value;

    file = `${where}/${definition}`;
    const path = join(root, definition);
    const yaml = /\.ya?ml$/.test(definition);

    // Bun loads external TypeScript synchronously in both the launcher and the executable.
    const document = yaml ? parse(readFileSync(path, "utf8"), { stringKeys: true }) : require(path).default;
    const result = check(v.safeParse(packageManifestSchema, document));

    if (!result.ok) return { ok: false, errors: result.errors.map((error) => `${file}: ${error}`) };

    return { ok: true, value: { manifest: result.value, file } };
  } catch (error) {
    return { ok: false, errors: [`${file}: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
