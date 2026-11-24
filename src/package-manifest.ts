// A package's package.json: its name and description, where its definition is, which office
// packages it depends on and what it shares. Office reads it here, once, for sync, the command path and the dependency check.
// Bun enforces `exports` when another package imports this one; office passes it through.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, normalize, relative, sep } from "node:path";
import * as v from "valibot";
import { check, ownEntries, type Parsed } from "./schema.ts";

export const scope = "@office/";

export type PackageJson = {
  /** What the package is for, when it says. */
  description?: string;
  /** The definition's path inside the package, normalized (`office.ts`, `src/definition.ts`). */
  definition: string;
  /** The office packages it declares, by name without the scope. */
  dependencies: string[];
  /** Each optional provider it integrates with, by name without the scope, and the module, inside the package, that office loads only while the integration is active. */
  integrations: ReadonlyMap<string, string>;
  exports: unknown;
};

const dependency = v.pipe(v.string("must be an @office/<name> string"), v.regex(/^@office\/[a-z0-9][a-z0-9-]*$/, "must be an @office/<name> string"));

const definitionMessage = "must give the definition's path inside the package";

const schema = v.looseObject({
  name: v.string("must be a string"),
  description: v.optional(v.string("must be a string")),
  exports: v.optional(v.unknown()),
  office: v.looseObject({
    definition: v.string(definitionMessage),
    dependencies: v.optional(v.array(dependency, "must be a list of @office/<name> strings")),
    integrations: v.optional(v.pipe(ownEntries("must map @office/<name> strings to module paths"), v.map(dependency, v.pipe(v.string("must map @office/<name> to a module path"), v.nonEmpty("must map @office/<name> to a module path"))))),
  }, definitionMessage),
});

function outside(path: string) {
  return path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path);
}

/** The name of the SDK every package can import as `@office/sdk`, which no package can have. */
export const sdkName = "sdk";

/**
 * `path`, normalized, when it names a file inside the package `dir`, followed through links, with
 * the real file it resolves to; else what is wrong, starting with `path`.
 */
function packageFile(dir: string, path: string): { ok: true; path: string; real: string } | { ok: false; problem: string } {
  const normalized = normalize(path);
  const file = join(dir, normalized);

  if (outside(normalized)) return { ok: false, problem: `${path} is outside the package` };

  if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return { ok: false, problem: `${path} is not a file in the package` };
  const real = realpathSync(file);

  if (outside(relative(realpathSync(dir), real))) return { ok: false, problem: `${path} links outside the package` };

  return { ok: true, path: normalized, real };
}

/**
 * The packages whose code this one's may import, given the names `selected`: what it declares in
 * office.dependencies, and each optional provider that is selected, whether or not its integration
 * is active. An unselected provider couples nothing. Updates, replacement checks and shutdown
 * follow these edges.
 */
export function importEdges(json: Pick<PackageJson, "dependencies" | "integrations">, selected: ReadonlySet<string>): string[] {
  return [...json.dependencies, ...[...json.integrations.keys()].filter(provider => selected.has(provider))];
}

/** What to add, for a package with no usable package.json. */
export function packageJsonHint(name: string) {
  return `add a package.json with "name": "${scope}${name}", an optional "description" and "office": { "definition": "./office.ts" }`;
}

/**
 * What to do about a package with no package.json, by where it comes from: sync replaces a
 * built-in copy; a Git package's repository needs one; the office's own package gets one added.
 */
function missingHint(name: string, kind: "local" | "built-in" | "remote") {
  if (kind === "built-in") return "the copy isn't this office executable's; run office sync";

  if (kind === "remote") return `its repository needs a package.json with "name": "${scope}${name}", an optional "description" and "office": { "definition": … }; then run office packages update`;

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
  const { name: found, description, office, exports } = read.value;

  if (found !== `${scope}${name}`) return fail(`package.json names ${found}; expected ${scope}${name}`);
  const definition = packageFile(dir, office.definition);

  if (!definition.ok) return fail(`office.definition ${definition.problem}`);
  const dependencies = (office.dependencies ?? []).map(entry => entry.slice(scope.length));
  const integrations = new Map<string, string>();
  // An integration module that is also the definition or another provider's would load while its own integration is off.
  const claimed = new Map([[definition.real, "office.definition"]]);

  for (const [provider, path] of office.integrations ?? []) {
    const key = provider.slice(scope.length);
    const at = `office.integrations ${provider}`;

    if (key === sdkName) return fail(`${at}: ${scope}${sdkName} is always available, so it is no optional provider; remove it`);

    if (key === name) return fail(`${at}: names the package itself; remove it`);

    if (dependencies.includes(key)) return fail(`${at}: is also in office.dependencies; a provider is either required or optional, so remove one`);
    const module = packageFile(dir, path);

    if (!module.ok) return fail(`${at}: ${module.problem}`);
    const owner = claimed.get(module.real);

    if (owner !== undefined) return fail(`${at}: ${path} is the same file as ${owner}; give each integration a module of its own`);
    claimed.set(module.real, `office.integrations ${provider}`);
    integrations.set(key, module.path);
  }

  const value: PackageJson = { definition: definition.path, dependencies, integrations, exports };

  if (description !== undefined) value.description = description;

  return { ok: true, value };
}
