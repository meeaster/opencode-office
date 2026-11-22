// A package's package.json: where its definition is, which office packages it depends on and
// what it shares. Office reads it here, once, for sync, the command path and the dependency check.
// Bun enforces `exports` when another package imports this one; office passes it through.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import * as v from "valibot";
import { check, type Parsed } from "./schema.ts";

export const scope = "@office/";

export type PackageJson = {
  /** The definition's path inside the package, normalized (`office.ts`, `src/definition.ts`). */
  definition: string;
  /** The office packages it declares, by name without the scope. */
  dependencies: string[];
  exports: unknown;
};

const dependency = v.pipe(v.string("must be an @office/<name> string"), v.regex(/^@office\/[a-z0-9][a-z0-9-]*$/, "must be an @office/<name> string"));

const definitionMessage = "must give the definition's path inside the package";

const schema = v.looseObject({
  name: v.string("must be a string"),
  exports: v.optional(v.unknown()),
  office: v.looseObject({
    definition: v.string(definitionMessage),
    dependencies: v.optional(v.array(dependency, "must be a list of @office/<name> strings")),
  }, definitionMessage),
});

function outside(path: string) {
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

/** What to add, for a package with no usable package.json. */
export function packageJsonHint(name: string) {
  return `add a package.json with "name": "${scope}${name}" and "office": { "definition": "./office.ts" }`;
}

/**
 * What to do about a package with no package.json, by where it comes from: a built-in copy an
 * executable from before package.json wrote is replaced by sync; a Git package's repository needs
 * one; the office's own package gets one added.
 */
function missingHint(name: string, kind: "local" | "built-in" | "remote") {
  if (kind === "built-in") return "the copy is from an older office executable; run office sync";

  if (kind === "remote") return `its repository needs a package.json with "name": "${scope}${name}" and "office": { "definition": … }; then run office packages update`;

  return packageJsonHint(name);
}

/**
 * Reads and checks the package.json of the package selected as `name`, whose folder is `dir` and
 * which comes from `kind`. Messages don't repeat the package's name; a filesystem error (such as a
 * link loop) is a problem naming the path, not an exception.
 */
export function readPackageJson(dir: string, name: string, kind: "local" | "built-in" | "remote" = "local"): Parsed<PackageJson> {
  try {
    return readChecked(dir, name, kind);
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
}

function readChecked(dir: string, name: string, kind: "local" | "built-in" | "remote"): Parsed<PackageJson> {
  const path = join(dir, "package.json");
  const fail = (message: string): Parsed<PackageJson> => ({ ok: false, errors: [message] });

  if (!existsSync(path)) return fail(`no package.json; ${missingHint(name, kind)}`);
  let document;

  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return fail(`package.json: ${error instanceof Error ? error.message : String(error)}`);
  }

  const read = check(v.safeParse(schema, document));

  if (!read.ok) return { ok: false, errors: read.errors.map(error => `package.json: ${error}`) };
  const { name: found, office, exports } = read.value;

  if (found !== `${scope}${name}`) return fail(`package.json names ${found}; expected ${scope}${name}`);
  const definition = normalize(office.definition);
  const file = join(dir, definition);

  if (outside(definition)) return fail(`office.definition ${office.definition} is outside the package`);

  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return fail(`office.definition ${office.definition} is not a file in the package`);

  if (outside(relative(realpathSync(dir), realpathSync(file)))) return fail(`office.definition ${office.definition} links outside the package`);

  return { ok: true, value: { definition, dependencies: (office.dependencies ?? []).map(entry => entry.slice(scope.length)), exports } };
}
