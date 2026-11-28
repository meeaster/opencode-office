import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import type { OptionalIntegration } from "./integrations.ts";
import { readPackageJson } from "../sources/manifest.ts";
import { marked as madeWithSdk } from "../../../sdk/mark.ts";
import { registerSdk } from "./sdk.ts";
import { type PackageManifest, parseManifest } from "../sources/manifest-schema.ts";
import type { Parsed } from "../../parse.ts";

/**
 * Read one definition: the file the package's package.json names in `office.definition`, loaded
 * from `root` (the folder itself, or the set's link to it) after `verifyCopy` passes. A `.yaml` or
 * `.yml` file is a package.yaml; any other is a module. Both go through the same validation and defaults.
 * Its optional integrations are listed from package.json; no integration module is imported here.
 */
export function readDefinition(dir: string, name: string, where: string, { verifyCopy, root = dir }: { verifyCopy?: () => void; root?: string } = {}): Parsed<{ manifest: PackageManifest; file: string; integrations: OptionalIntegration[] }> {
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

    if (!yaml) registerSdk();
    // Bun loads external TypeScript synchronously in both the launcher and the executable.
    const document = yaml ? parse(readFileSync(path, "utf8"), { stringKeys: true }) : require(path).default;

    if (!yaml && !madeWithSdk(document)) return { ok: false, errors: [`${file}: the definition must be the result of Package.define from @office/sdk`] };
    const result = parseManifest(name, document);

    if (!result.ok) return { ok: false, errors: result.errors.map((error) => `${file}: ${error}`) };

    return { ok: true, value: { manifest: result.value, file, integrations: [...json.value.integrations].map(([provider, module]) => ({ provider, module })) } };
  } catch (error) {
    return { ok: false, errors: [`${file}: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
