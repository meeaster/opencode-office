import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { parse } from "yaml";
import { check, type PackageManifest, packageManifestSchema, type Parsed } from "./schema.ts";

const names = ["office.ts", "package.yaml"] as const;

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
