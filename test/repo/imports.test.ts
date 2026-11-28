import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { compilerOptions } from "../../tsconfig.json";
import { toolPath } from "../../src/tool.ts";

type Feature = `features/${string}`;

type Package = `packages/${string}`;

type Location = "kernel" | "kernel/commands" | Feature | Package | undefined;

type Allowed = { from: string; to: Feature | Package | "kernel/commands"; needsApi?: true };

const allowed: readonly Allowed[] = [
  { from: "src/cli.ts", to: "packages/office", needsApi: true },
  { from: "src/commands/check/repository.ts", to: "packages/office", needsApi: true },
  { from: "src/commands/sync.ts", to: "packages/references", needsApi: true },
  { from: "src/direct-commands.ts", to: "features/executor", needsApi: true },
  { from: "src/exclude-plumbing.ts", to: "features/opencode", needsApi: true },
  { from: "src/gather.ts", to: "features/mise-integration", needsApi: true },
  { from: "src/gather.ts", to: "features/opencode", needsApi: true },
  { from: "src/gather.ts", to: "features/references" },
  { from: "src/gather.ts", to: "features/tools", needsApi: true },
  { from: "src/gather.ts", to: "packages/references", needsApi: true },
  { from: "src/git.ts", to: "packages/references" },
  { from: "src/github.ts", to: "features/tools" },
  { from: "src/features/tools/host-tools.ts", to: "packages/office", needsApi: true },
  { from: "src/layout.ts", to: "features/opencode", needsApi: true },
  { from: "src/lifecycle-inputs.ts", to: "features/executor", needsApi: true },
  { from: "src/lifecycle-inputs.ts", to: "features/systemd", needsApi: true },
  { from: "src/lifecycle-inputs.ts", to: "features/tools", needsApi: true },
  { from: "src/loader/publication/application.ts", to: "features/machine", needsApi: true },
  { from: "src/loader/publication/application.ts", to: "features/mise-integration", needsApi: true },
  { from: "src/loader/publication/application.ts", to: "features/opencode", needsApi: true },
  { from: "src/loader/publication/application.ts", to: "features/tools", needsApi: true },
  { from: "src/loader/publication/admission.ts", to: "features/mise-integration", needsApi: true },
  { from: "src/loader/publication/admission.ts", to: "features/opencode", needsApi: true },
  { from: "src/loader/publication/admission.ts", to: "features/references", needsApi: true },
  { from: "src/loader/publication/admission.ts", to: "features/tools", needsApi: true },
  { from: "src/loader/definitions/inventory.ts", to: "features/compose", needsApi: true },
  { from: "src/features/mise-integration/projection.ts", to: "packages/tools" },
  { from: "src/features/systemd/units.ts", to: "packages/tools" },
];

// Read tokens rather than matching lines: type imports, comments between tokens and semicolon-free
// declarations all count. The scanner only needs to distinguish code from literals and comments.
function tokens(source: string): string[] {
  const result: string[] = [];
  const token = /\s+|#![^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\\r\n])*"|'(?:\\[\s\S]|[^'\\\r\n])*'|[\p{ID_Continue}$]+|\?\.|=>|\+\+|--|[^\s]/uy;
  const regex = /\/(?:\\[^\r\n]|\[(?:\\[^\r\n]|[^\]\\\r\n])*\]|[^/[\\\r\n])+\/[a-z]*/y;
  const template = /(?:\\[\s\S]|[^\\`$]|\$(?!\{))*(?:\$\{|`)/y;
  const beforeRegex = new Set(["(", "[", "{", ",", ";", ":", "=", "!", "?", "&", "|", "^", "~", "+", "-", "*", "/", "%", "<", ">", "=>", "return", "throw", "case", "yield", "await", "else", "typeof", "void", "delete", "in"]);
  const controls = new Set(["if", "while", "for", "with"]);
  const blockStarters = new Set([";", ")", "else", "try", "finally", "do"]);

  function code(inTemplate: boolean) {
    let afterBlock = false;
    let afterControl = false;
    const blocks: boolean[] = [];
    const parens: boolean[] = [];

    while (token.lastIndex < source.length) {
      const text = token.exec(source)?.[0];

      if (text === undefined) break;

      if (!text.trim() || text.startsWith("//") || text.startsWith("/*") || text.startsWith("#!")) continue;

      if (inTemplate && text === "}" && blocks.length === 0) return;

      const previous = result.at(-1) ?? ";";
      const canStartRegex = afterControl || afterBlock || beforeRegex.has(previous);

      if (text === "{") {
        const startsStatement = afterBlock || blockStarters.has(previous) || (previous === "{" && blocks.at(-1) === true);

        blocks.push(startsStatement);
      }

      afterBlock = text === "}" && blocks.pop() === true;
      afterControl = text === ")" && parens.pop() === true;

      if (text === "(") {
        const receiver = result.at(-2);

        parens.push(controls.has(previous) && receiver !== "." && receiver !== "?.");
      }

      if (text === "`") {
        const start = result.push("`") - 1;
        let interpolated = false;

        while (token.lastIndex < source.length) {
          template.lastIndex = token.lastIndex;
          const part = template.exec(source)?.[0];

          if (part === undefined) break;

          token.lastIndex = template.lastIndex;

          if (part.endsWith("`")) {
            if (!interpolated) result[start] = "`" + part;
            break;
          }

          interpolated = true;
          result.push("{");
          code(true);
          result.push("}");
        }
      } else if (text === "/" && canStartRegex) {
        regex.lastIndex = token.lastIndex - 1;

        if (regex.exec(source)) {
          token.lastIndex = regex.lastIndex;
          result.push("/regex/");
        } else result.push(text);
      } else {
        // A TypeScript postfix non-null assertion ends an expression, unlike prefix `!`.
        result.push(text === "!" && !canStartRegex ? "postfix!" : text);
      }
    }
  }

  code(false);

  return result;
}

const escapes = new Map(Object.entries({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" }));

function quoted(text: string | undefined, dynamic = false): string | undefined {
  if (text === undefined || text.length < 2 || (text[0] !== "'" && text[0] !== '"' && !(dynamic && text[0] === "`"))) return undefined;

  return text.slice(1, -1).replace(/\\(?:u\{([\da-fA-F]+)\}|u([\da-fA-F]{4})|x([\da-fA-F]{2})|(\r\n|[\s\S]))/g, (_match, codePoint, unicode, hex, char) => {
    const digits = codePoint ?? unicode ?? hex;

    if (digits !== undefined) return String.fromCodePoint(Number.parseInt(digits, 16));

    if (/^[\r\n\u2028\u2029]/.test(char)) return "";

    return escapes.get(char) ?? char;
  });
}

type ImportKind = "static" | "type-only" | "import-call" | "deferred-build-import";

type Specifier = { specifier: string; kind: ImportKind };

function inPlaceExecutable(code: readonly string[], index: number): boolean {
  const declaration = code.findIndex((token, at) =>
    token === "function" && code[at - 2] === "export" && code[at - 1] === "async" &&
    code[at + 1] === "placeExecutable" && code[at + 2] === "(");

  if (declaration === -1) return false;

  const body = code.indexOf("{", declaration + 3);

  if (body === -1 || body >= index) return false;

  let depth = 1;

  for (let at = body + 1; at < index; at++) {
    if (code[at] === "{") depth++;

    if (code[at] === "}") depth--;

    if (depth === 0) return false;
  }

  return true;
}

function importSpecifiers(source: string): Specifier[] {
  const code = tokens(source);
  const specifiers: Specifier[] = [];

  for (const [index, keyword] of code.entries()) {
    if (keyword !== "import" && keyword !== "export") continue;

    if (code[index - 1] === "." || code[index - 1] === "?.") continue;

    let next = index + 1;
    const first = code[next];
    const sideEffect = keyword === "import" ? quoted(first) : undefined;

    if (sideEffect !== undefined) {
      specifiers.push({ specifier: sideEffect, kind: "static" });
      continue;
    }

    if (keyword === "import" && first === "(") {
      const dynamic = quoted(code[next + 1], true);
      const after = code[next + 2];

      // An import call can also be a type query. Only the exception needs proof it runs.
      if (dynamic !== undefined && (after === ")" || after === ",")) {
        const beforeAwait = code[index - 2];

        const deferred = dynamic === "./build.ts" && code[index - 1] === "await" &&
          beforeAwait !== "." && beforeAwait !== "?." && inPlaceExecutable(code, index);

        specifiers.push({ specifier: dynamic, kind: deferred ? "deferred-build-import" : "import-call" });
      }

      continue;
    }

    const typeOnly = first === "type" && code[next + 1] !== "from" && code[next + 1] !== ",";
    const kind = typeOnly ? "type-only" : "static";

    if (typeOnly) next++;

    if (keyword === "import" && /^[\p{ID_Start}$_]/u.test(code[next] ?? "")) {
      next++;

      if (code[next] === "=" && code[next + 1] === "require" && code[next + 2] === "(" && code[next + 4] === ")") {
        const imported = quoted(code[next + 3]);

        if (imported !== undefined) specifiers.push({ specifier: imported, kind });
        continue;
      }

      if (code[next] === ",") next++;
    } else if (code[next] !== "{" && code[next] !== "*") continue;

    if (code[next] === "{") {
      next = code.indexOf("}", next + 1);

      if (next === -1) continue;
      next++;
    } else if (code[next] === "*") {
      next++;

      if (code[next] === "as") next += 2;
    }

    const specifier = code[next] === "from" ? quoted(code[next + 1]) : undefined;

    if (specifier !== undefined) specifiers.push({ specifier, kind });
  }

  return specifiers;
}

const aliases = new Map(Object.entries(compilerOptions.paths));

function targetPath(from: string, specifier: string, requireAlias = true): string | undefined {
  if (specifier.startsWith("./") || specifier.startsWith("../")) return posix.join(posix.dirname(from), specifier);

  if (!specifier.startsWith("@office/")) return undefined;

  const path = aliases.get(specifier)?.[0];

  if (path === undefined) {
    if (requireAlias) throw new Error(`${from}: ${specifier} has no tsconfig.json path`);

    return undefined;
  }

  return posix.normalize(path);
}

type ResolvedImport = { to: string; kind: ImportKind };

function resolvedImports(from: string, source: string, files: ReadonlySet<string>, requireAlias: boolean): ResolvedImport[] {
  const imports: ResolvedImport[] = [];

  for (const { specifier, kind } of importSpecifiers(source)) {
    const path = targetPath(from, specifier, requireAlias);

    if (path === undefined || path.startsWith("sdk/")) continue;

    const typescriptPath = path.replace(/\.js$/, ".ts");
    const to = [path, typescriptPath, `${path}.ts`, posix.join(path, "index.ts")].find(candidate => files.has(candidate)) ?? path;

    imports.push({ to, kind });
  }

  return imports;
}

function cycleTargets(from: string, imports: readonly ResolvedImport[], production: ReadonlySet<string>): Set<string> {
  const targets = new Set<string>();
  let exempted = false;

  for (const { to, kind } of imports) {
    if (!to.startsWith("src/") || !production.has(to)) continue;

    if (!exempted && from === "src/tool.ts" && to === "src/build.ts" && kind === "deferred-build-import") {
      exempted = true;
      continue;
    }

    targets.add(to);
  }

  return targets;
}

function cycleProblems(graph: ReadonlyMap<string, ReadonlySet<string>>): string[] {
  const visited = new Set<string>();
  const active = new Map<string, number>();
  const stack: string[] = [];
  const problems: string[] = [];

  // Tarjan's algorithm: the earliest reachable active vertex is the root of a component.
  function visit(from: string): number {
    const index = visited.size;
    let low = index;

    visited.add(from);
    active.set(from, index);
    stack.push(from);

    for (const to of graph.get(from) ?? []) {
      const reachable = visited.has(to) ? active.get(to) : visit(to);

      if (reachable !== undefined) low = Math.min(low, reachable);
    }

    if (low === index) {
      const component = stack.splice(stack.lastIndexOf(from));

      for (const file of component) active.delete(file);

      if (component.length > 1 || graph.get(from)?.has(from)) {
        problems.push(`source import cycle: ${component.sort().join(", ")}`);
      }
    }

    return low;
  }

  for (const file of graph.keys()) {
    if (!visited.has(file)) visit(file);
  }

  return problems.sort();
}

const root = toolPath(".");
const typescript = new Bun.Glob("{src,packages,test,sdk,bin,examples}/**/*.ts");
const testFolders = /^(?:src\/features|packages)\/[^/]+\/test\//;

function packageFolder(path: string): Package | undefined {
  const name = /^packages\/([^/]+)(?:\/|$)/.exec(path)?.[1];

  return name === undefined ? undefined : `packages/${name}`;
}

function fileFolder(path: string): Location {
  const feature = /^src\/features\/([^/]+)\//.exec(path)?.[1];

  if (feature !== undefined) return `features/${feature}`;

  if (path.startsWith("src/commands/")) return "kernel/commands";

  if (path.startsWith("src/")) return "kernel";

  return packageFolder(path);
}

function isFeature(folder: Location): folder is Feature {
  return folder?.startsWith("features/") ?? false;
}

const loaderEntries = new Map<string, readonly string[]>([
  ["sources", ["sources/selection.ts", "sources/manifest.ts", "sources/manifest-schema.ts", "sources/copies.ts", "sources/drift.ts"]],
  ["definitions", ["definitions/inventory.ts", "definitions/settings.ts", "definitions/registration.ts", "definitions/sdk.ts"]],
  ["access", ["access.ts"]],
  ["worker", ["worker.ts"]],
  ["installed", ["installed/paths.ts", "installed/reader.ts", "installed/links.ts"]],
  ["publication", ["publication/publish.ts", "publication/admission.ts", "publication/install.ts"]],
  ["lifecycle", ["lifecycle/full-sync.ts", "lifecycle/session.ts", "lifecycle/shutdown.ts"]],
]);

function loaderModule(path: string) {
  return /^src\/loader\/([^/]+)\//.exec(path)?.[1] ?? /^src\/loader\/([^/]+)\.ts$/.exec(path)?.[1];
}

function privateLoaderImport(from: string, to: string): boolean {
  const module = loaderModule(to);

  if (module === undefined || loaderModule(from) === module) return false;
  const entries = loaderEntries.get(module);

  return entries?.includes(to.slice("src/loader/".length)) !== true;
}

function workerImportsHandler(from: string, to: string): boolean {
  const module = loaderModule(to);

  return from === "src/loader/worker.ts" && (module === "access" || module === "installed" || module === "publication" || module === "lifecycle");
}

const machineCore = new Set([
  "src/features/machine/paths.ts",
  "src/features/machine/record.ts",
  "src/features/machine/owned-files.ts",
]);

const machinePlanCallers = new Set([
  "src/loader/publication/application.ts",
  "src/commands/check/run.ts",
  "src/commands/compose.ts",
  "src/commands/setup.ts",
]);

function violation(from: string, origin: Location, destination: Location, pkg: Package | undefined): Allowed["to"] | undefined {
  if (pkg && (origin === "kernel" || origin === "kernel/commands")) return pkg;

  if (pkg && isFeature(origin) && pkg.slice("packages/".length) !== origin.slice("features/".length)) return pkg;

  if (origin === "kernel" && from !== "src/cli.ts" && isFeature(destination)) return destination;

  if (isFeature(origin) && destination === "kernel/commands") return destination;

  return undefined;
}

test("imports follow loader entry points, and production imports follow the layout and have no src/ cycles", () => {
  const files = [...typescript.scanSync({ cwd: root, dot: true })].filter(path => !path.split("/").includes("node_modules")).sort();
  const production = new Set(files.filter(path => /^(src|packages)\//.test(path) && !testFolders.test(path) && !/\.(test|fixture)\.ts$/.test(path)));

  const seen = new Set(files);
  const problems: string[] = [];
  const graph = new Map<string, ReadonlySet<string>>();
  const key = (from: string, to: string) => `${from} → ${to}`;
  const exceptions = new Set(allowed.map(entry => key(entry.from, entry.to)));
  const matched = new Set<string>();
  const packageImports = new Set<string>();
  const distance = new Map<Feature, { kernel: Set<string>; commands: number }>();

  for (const file of production) {
    const folder = fileFolder(file);

    if (isFeature(folder) && !distance.has(folder)) distance.set(folder, { kernel: new Set(), commands: 0 });
  }

  for (const from of files) {
    const origin = fileFolder(from);
    const productionFile = production.has(from);
    const imports = resolvedImports(from, readFileSync(join(root, from), "utf8"), seen, productionFile);
    const targets = new Set(imports.map(({ to }) => to));

    if (productionFile && from.startsWith("src/")) graph.set(from, cycleTargets(from, imports, production));

    for (const to of targets) {
      if (privateLoaderImport(from, to)) problems.push(`private loader import: ${key(from, to)}`);

      if (workerImportsHandler(from, to)) problems.push(`worker transport imports a handler: ${key(from, to)}`);

      if (!productionFile) continue;
      const destination = fileFolder(to);

      if (machineCore.has(from) && isFeature(destination) && !machineCore.has(to)) problems.push(`machine core imports a feature: ${key(from, to)}`);

      if (to === "src/features/machine/plan.ts" && !machinePlanCallers.has(from)) problems.push(`machine plan import outside its callers: ${key(from, to)}`);

      if (packageFolder(from) && to.startsWith("src/")) packageImports.add(key(from, to));

      if (isFeature(origin) && (destination === "kernel" || destination === "kernel/commands")) {
        distance.get(origin)?.kernel.add(to);
      }

      if (isFeature(destination) && (origin === "kernel/commands" || from === "src/cli.ts")) {
        const feature = distance.get(destination);

        if (feature) feature.commands++;
      }

      const forbidden = violation(from, origin, destination, packageFolder(to));

      if (forbidden === undefined) continue;

      const edge = key(from, forbidden);

      if (exceptions.has(edge)) matched.add(edge);
      else problems.push(`disallowed import: ${edge} (${to})`);
    }
  }

  for (const edge of exceptions) {
    if (!matched.has(edge)) problems.push(`stale allowlist entry: ${edge}`);
  }

  if (exceptions.size !== allowed.length) problems.push("duplicate allowlist entries");

  problems.push(...cycleProblems(graph));

  console.log("Package imports into the CLI:\n" + [...packageImports].sort().join("\n"));
  console.log("Feature import distance:");

  for (const [folder, { kernel, commands }] of [...distance].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`${folder}: ${commands} from commands/cli; kernel: ${[...kernel].sort().join(", ") || "none"}`);
  }

  if (problems.length) throw new Error(problems.sort().join("\n"));
});

function fixtureCycleProblems(sources: Record<string, string>): string[] {
  const files = new Set(Object.keys(sources));
  const graph = new Map<string, ReadonlySet<string>>();

  for (const [from, source] of Object.entries(sources)) {
    graph.set(from, cycleTargets(from, resolvedImports(from, source, files, true), files));
  }

  return cycleProblems(graph);
}

test("finds a transitive cycle closed by a type re-export", () => {
  expect(fixtureCycleProblems({
    "src/c.ts": 'export type { A } from "./a.js";',
    "src/b.ts": 'import "./c.ts";',
    "src/a.ts": 'import "./b";',
  })).toEqual(["source import cycle: src/a.ts, src/b.ts, src/c.ts"]);
});

test("finds a file importing itself", () => {
  expect(fixtureCycleProblems({
    "src/self.ts": 'import "./self.ts";',
  })).toEqual(["source import cycle: src/self.ts"]);
});

test("allows a diamond with a shared dependency", () => {
  expect(fixtureCycleProblems({
    "src/a.ts": 'import "./b.ts"; import "./c.ts";',
    "src/b.ts": 'import "./d.ts";',
    "src/c.ts": 'import "./d.ts";',
    "src/d.ts": "",
  })).toEqual([]);
});

test("exempts only the deferred import from tool.ts to build.ts", () => {
  const build = 'import "./tool.ts";';
  const call = 'const { compile } = await import("./build.ts");';
  const place = (body: string) => `export async function placeExecutable(): Promise<void> { ${body} }`;
  const lazy = place(call);
  const cycle = ["source import cycle: src/build.ts, src/tool.ts"];

  expect(fixtureCycleProblems({ "src/tool.ts": lazy, "src/build.ts": build })).toEqual([]);
  expect(fixtureCycleProblems({ "src/tool.ts": call, "src/build.ts": build })).toEqual(cycle);
  expect(fixtureCycleProblems({
    "src/tool.ts": place('obj.await\nimport("./build.ts");'),
    "src/build.ts": build,
  })).toEqual(cycle);
  expect(fixtureCycleProblems({
    "src/tool.ts": place(`${call} const second = await import("./build.ts");`),
    "src/build.ts": build,
  })).toEqual(cycle);

  for (const other of [
    'import { compile as eager } from "./build.ts";',
    'type Compile = typeof import("./build.ts").compile;',
    call,
  ]) {
    expect(fixtureCycleProblems({ "src/tool.ts": `${lazy}\n${other}`, "src/build.ts": build })).toEqual(cycle);
  }
});

test("only loader entry files can be imported from outside their module", () => {
  const from = "src/loader/definitions/inventory.ts";

  const source = `
    import type { ResolvedPackage } from "../sources/selection.ts";
    import type { PackageRecord } from "../sources/records.ts";
    import type Records = require("../sources/records.ts");
    export { readDefinition } from "./definition.ts";
  `;

  const forbidden = importSpecifiers(source).map(({ specifier }) => targetPath(from, specifier))
    .filter(path => path !== undefined && privateLoaderImport(from, path));

  expect(forbidden).toEqual(["src/loader/sources/records.ts", "src/loader/sources/records.ts"]);
  expect(privateLoaderImport("src/gather.ts", "src/loader/definitions/nested/registration.ts")).toBe(true);
  expect(privateLoaderImport("src/gather.ts", "src/loader/definitions/registration.ts")).toBe(false);
  expect(privateLoaderImport("src/gather.ts", "src/loader/unlisted/entry.ts")).toBe(true);
  expect(privateLoaderImport("src/gather.ts", "src/loader/unlisted.ts")).toBe(true);
  expect(privateLoaderImport("src/loader/definitions/inventory.ts", "src/loader/installed/paths.ts")).toBe(false);
  expect(privateLoaderImport("src/loader/lifecycle/session.ts", "src/loader/publication/stage.ts")).toBe(true);
  expect(privateLoaderImport("src/loader/lifecycle/session.ts", "src/loader/publication/publish.ts")).toBe(false);
  expect(privateLoaderImport("src/loader/publication/publish.ts", "src/loader/publication/stage.ts")).toBe(false);
});

test("worker transport cannot import handlers even through their entry files", () => {
  const from = "src/loader/worker.ts";

  expect(loaderModule(from)).toBe("worker");
  expect(loaderModule("src/loader/access.ts")).toBe("access");

  for (const entry of ["access.ts", "installed/reader.ts", "publication/admission.ts", "lifecycle/shutdown.ts"]) {
    const to = `src/loader/${entry}`;

    expect(privateLoaderImport(from, to)).toBe(false);
    expect(workerImportsHandler(from, to)).toBe(true);
    expect(workerImportsHandler(to, from)).toBe(false);
  }
});

test("reads multiline, type-only, re-export, side-effect, import-equals and literal dynamic imports", () => {
  expect(importSpecifiers(`
    import type { A } /* comment */ from "./a.ts"
    import defaultValue, {
      type B, value
    } from './b.ts'
    export type { X } from "./x.ts"
    export * as y from "./y.ts"
    import "./side-effect.ts"
    import Legacy = require("./legacy.ts")
    import type LegacyType = require("./legacy-type.ts")
    const lazy = import("./lazy.ts", { with: { type: "text" } })
    type FromQuery = import("./query.ts").Query
    const escaped = import("./\\u0065scaped.ts")
    const template = import(\`./literal.ts\`)
  `)).toEqual([
    { specifier: "./a.ts", kind: "type-only" },
    { specifier: "./b.ts", kind: "static" },
    { specifier: "./x.ts", kind: "type-only" },
    { specifier: "./y.ts", kind: "static" },
    { specifier: "./side-effect.ts", kind: "static" },
    { specifier: "./legacy.ts", kind: "static" },
    { specifier: "./legacy-type.ts", kind: "type-only" },
    { specifier: "./lazy.ts", kind: "import-call" },
    { specifier: "./query.ts", kind: "import-call" },
    { specifier: "./escaped.ts", kind: "import-call" },
    { specifier: "./literal.ts", kind: "import-call" },
  ]);
});

test("ignores comments, code inside literals, computed imports, require and member calls", () => {
  expect(importSpecifiers([
    `const quoted = 'fake import("./string.ts")'`,
    'const example = `fake import "./template.ts" ${`${import("./real.ts")}`}`',
    `const pattern = /import("./regex.ts")/`,
    `if (condition) /import("./regex-condition.ts")/.test(text)`,
    `if (condition) {} /"/.test(text); import "./after-regex.ts"`,
    `const ratio = {} / (await import("./divisor.ts")) / 2`,
    `const assertedRatio = count! / (await import("./asserted-divisor.ts")).length`,
    `const negated = !/import("./regex-negated.ts")/.test(text)`,
    `// import "./line.ts"`,
    `/* export { x } from "./block.ts" */`,
    `const computed = import("./" + name)`,
    'const interpolated = import(`./${name}.ts`)',
    `const required = require("./require.ts")`,
    `obj?.import("./member.ts")`,
    `export { value }; const from = "./no-edge.ts"`,
  ].join("\n")).map(({ specifier }) => specifier)).toEqual(["./real.ts", "./after-regex.ts", "./divisor.ts", "./asserted-divisor.ts"]);
});
