import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { parse } from "yaml";
import type { PackageContext, SettingValue } from "../packages/office/package-context.ts";
import { toolPath } from "./tool.ts";
import { verifyImports } from "./package-imports.ts";
import { check, type PackageManifest, packageManifestSchema, type Parsed, scalarSetting, settingVariable } from "./schema.ts";

const names = ["office.ts", "package.yaml"] as const;

export function standardImports(packages: string): Pick<PackageContext, "importStandard"> {
  return { importStandard(module) {
    // Compatibility for offices upgrading their executable before changing their definitions.
    // This legacy surface does not participate in resolving static @office imports.
    if (module !== "tooling/requirements" && module !== "mise-integration/claims") throw new Error(`unknown legacy standard contract ${module}`);

    const path = join(packages, `${module}.ts`);

    if (!readFileSync(path).equals(readFileSync(toolPath(`packages/${module}.ts`)))) throw new Error(`standard contract ${module} differs from this executable; sync to repair it`);

    return import(path);
  } };
}

type Registrations = Omit<PackageContext, "booleanSetting" | "scalarSetting">;

/** Setup owns declarations not present in the static manifest. Validate the complete override
 * only after that revision's setup has finished, including any conditional declarations. */
export async function runPackageSetup(manifest: PackageManifest, overrides: Readonly<Record<string, SettingValue>>, context: Registrations) {
  const declared = new Set(Object.keys(manifest.settings));
  const booleans: Record<string, boolean> = {};
  const scalars: Record<string, string | number | boolean> = {};
  await manifest.setup?.(setupContext(context, overrides, declared, booleans, scalars));

  for (const key of Object.keys(scalars)) {
    if (manifest.secrets[settingVariable(manifest.namespace, key)] || manifest.settings_schema) throw new Error(`settings.${key}: conflicts with a secret or settings_schema`);
  }

  if (!manifest.settings_schema) {
    for (const key of Object.keys(overrides)) if (!declared.has(key)) throw new Error(`settings.${key}: ${manifest.name} has no such setting`);
  }

  return { booleans, scalars };
}

export function setupContext(context: Registrations, settings: Readonly<Record<string, SettingValue>>, declared: Set<string>, booleans: Record<string, boolean> = {}, scalars: Record<string, string | number | boolean> = {}): PackageContext {
  const booleanSetting: PackageContext["booleanSetting"] = (name, definition) => {
    if (!/^[a-z][a-z0-9_]*$/.test(name) || !v.is(v.pipe(v.string(), v.nonEmpty()), definition.description) || !v.is(v.boolean(), definition.default) || declared.has(name)) throw new Error(`invalid or duplicate boolean setting ${name}`);
    const value = Object.hasOwn(settings, name) ? settings[name] : definition.default;

    if (!v.is(v.boolean(), value)) throw new Error(`settings.${name}: must be true or false`);
    declared.add(name);
    booleans[name] = value;

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

export function definitionFiles(dir: string) {
  return names.filter((name) => lstatSync(join(dir, name), { throwIfNoEntry: false }) !== undefined);
}

/** Read one definition. Both inputs go through the same validation and defaults. */
export function readDefinition(dir: string, where: string, verifyCopy?: (file: string) => void): Parsed<{ manifest: PackageManifest; file: string }> {
  let file = where;

  try {
    const [name, other] = definitionFiles(dir);

    if (other !== undefined) return { ok: false, errors: [`${where} has both office.ts and package.yaml; keep exactly one package definition`] };

    if (name === undefined) return { ok: false, errors: [`${where} has no office.ts or package.yaml; office sync installs built-in and remote packages`] };

    const path = join(dir, name);

    file = `${where}/${name}`;
    verifyCopy?.(name);

    if (name === "office.ts") verifyImports(path);

    // Bun loads external TypeScript synchronously in both the launcher and the executable.
    const document = name === "office.ts" ? require(path).default : parse(readFileSync(path, "utf8"), { stringKeys: true });
    const result = check(v.safeParse(packageManifestSchema, document));

    if (!result.ok) return { ok: false, errors: result.errors.map((error) => `${file}: ${error}`) };

    return { ok: true, value: { manifest: result.value, file } };
  } catch (error) {
    return { ok: false, errors: [`${file}: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
