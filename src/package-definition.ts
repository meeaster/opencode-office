import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { parse } from "yaml";
import type { PackageContext, SettingValue } from "../packages/office/package-context.ts";
import { check, type PackageManifest, packageManifestSchema, type Parsed } from "./schema.ts";

const names = ["office.ts", "package.yaml"] as const;

export function setupContext(context: Omit<PackageContext, "booleanSetting">, settings: Readonly<Record<string, SettingValue>>, declared: Set<string>, booleans: Record<string, boolean> = {}): PackageContext {
  const booleanSetting: PackageContext["booleanSetting"] = (name, definition) => {
    if (!/^[a-z][a-z0-9_]*$/.test(name) || !v.is(v.pipe(v.string(), v.nonEmpty()), definition.description) || !v.is(v.boolean(), definition.default) || declared.has(name)) throw new Error(`invalid or duplicate boolean setting ${name}`);
    const value = Object.hasOwn(settings, name) ? settings[name] : definition.default;

    if (!v.is(v.boolean(), value)) throw new Error(`settings.${name}: must be true or false`);
    declared.add(name);
    booleans[name] = value;

    return value;
  };

  // Diagnose a misplaced cron registration even when untyped setup guards it with `?.`.
  return Object.defineProperty({ ...context, booleanSetting }, "cron", {
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

    // Bun loads external TypeScript synchronously in both the launcher and the executable.
    const document = name === "office.ts" ? require(path).default : parse(readFileSync(path, "utf8"), { stringKeys: true });
    const result = check(v.safeParse(packageManifestSchema, document));

    if (!result.ok) return { ok: false, errors: result.errors.map((error) => `${file}: ${error}`) };

    return { ok: true, value: { manifest: result.value, file } };
  } catch (error) {
    return { ok: false, errors: [`${file}: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
