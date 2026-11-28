import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { MalformedSettings, type PackageManifest } from "../sources/manifest-schema.ts";
import type { SettingValue } from "../../schema.ts";
import type { Parsed } from "../../parse.ts";
import type { ResolvedPackage } from "../sources/selection.ts";

/**
 * The package's settings in office.yaml checked against its own schema only, with the schema's
 * defaults applied: what `office down` gives a package's `down`, without the checks for its
 * compose file and system setup.
 */
export function schemaSettings({ entry }: Pick<ResolvedPackage, "entry">, manifest: PackageManifest, file: string): Parsed<Record<string, SettingValue>> {
  const validator = settingsValidator(manifest, file);

  if (!validator.ok) return validator;
  const validate = validator.value;
  const settings = structuredClone(entry.settings ?? {});
  const path = `packages.${entry.name}.settings`;

  if (validate(settings)) return { ok: true, value: settings };

  return { ok: false, errors: (validate.errors ?? []).map(issue => {
    const at = `${path}${issue.instancePath.replaceAll("/", ".")}`;

    if (issue.keyword === "additionalProperties") return `${at}.${String(issue.params.additionalProperty)}: the package declares no such setting; remove it from office.yaml`;

    if (issue.keyword === "required") return `${at}.${String(issue.params.missingProperty)}: is required; add it to office.yaml`;

    return `${at}: ${issue.message}`;
  }) };
}

// One Ajv for every package's settings schema. It registers no schema under its `$id`, so two
// packages can use the same one, and a `$ref` reaches only within its own schema, as with an Ajv
// of its own. Compiled validators are kept by schema text, so reading a package again reuses one.
const settingsAjv = new Ajv2020({ useDefaults: true, allErrors: true, ownProperties: true, strict: false, validateFormats: false, addUsedSchema: false });
const settingsValidators = new Map<string, ValidateFunction>();

/** The validator of a package's settings schema, or the problem, naming the file, with a root that isn't an object or an invalid schema. */
function settingsValidator(manifest: PackageManifest, file: string): Parsed<ValidateFunction> {
  if (manifest.settings instanceof MalformedSettings) return { ok: false, errors: [`${file}: settings: ${manifest.settings.problem}`] };

  if (manifest.settings.type !== "object") return { ok: false, errors: [`${file}: settings: its root must have type: "object"`] };
  const text = JSON.stringify(manifest.settings);

  try {
    const validate = settingsValidators.get(text) ?? settingsAjv.compile(manifest.settings);

    if ("$async" in validate) throw new Error("must be a synchronous schema");
    settingsValidators.set(text, validate);

    return { ok: true, value: validate };
  } catch (error) {
    return { ok: false, errors: [`${file}: settings: ${error instanceof Error ? error.message : String(error)}`] };
  }
}
