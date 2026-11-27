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
  { from: "src/applied-settings.ts", to: "features/secrets" },
  { from: "src/cli.ts", to: "packages/office", needsApi: true },
  { from: "src/commands/check.ts", to: "packages/office", needsApi: true },
  { from: "src/commands/sync.ts", to: "packages/references", needsApi: true },
  { from: "src/direct-commands.ts", to: "features/executor", needsApi: true },
  { from: "src/exclude-plumbing.ts", to: "features/opencode", needsApi: true },
  { from: "src/exclude-plumbing.ts", to: "features/secrets" },
  { from: "src/features/executor/executor.ts", to: "kernel/commands" },
  { from: "src/gather.ts", to: "features/mise-integration", needsApi: true },
  { from: "src/gather.ts", to: "features/opencode", needsApi: true },
  { from: "src/gather.ts", to: "features/references" },
  { from: "src/gather.ts", to: "features/tools", needsApi: true },
  { from: "src/gather.ts", to: "packages/references", needsApi: true },
  { from: "src/git.ts", to: "packages/references" },
  { from: "src/github.ts", to: "features/host" },
  { from: "src/features/host/host-tools.ts", to: "packages/office", needsApi: true },
  { from: "src/layout.ts", to: "features/opencode", needsApi: true },
  { from: "src/lifecycle-inputs.ts", to: "features/executor", needsApi: true },
  { from: "src/lifecycle-inputs.ts", to: "features/systemd", needsApi: true },
  { from: "src/lifecycle-inputs.ts", to: "features/tools", needsApi: true },
  { from: "src/features/opencode/opencode-request.ts", to: "kernel/commands" },
  { from: "src/loader/package-application.ts", to: "features/host", needsApi: true },
  { from: "src/loader/package-application.ts", to: "features/mise-integration", needsApi: true },
  { from: "src/loader/package-application.ts", to: "features/opencode", needsApi: true },
  { from: "src/loader/package-application.ts", to: "features/tools", needsApi: true },
  { from: "src/loader/package-generation.ts", to: "features/secrets" },
  { from: "src/loader/package-operation.ts", to: "features/mise-integration", needsApi: true },
  { from: "src/loader/package-operation.ts", to: "features/opencode", needsApi: true },
  { from: "src/loader/package-operation.ts", to: "features/references", needsApi: true },
  { from: "src/loader/package-operation.ts", to: "features/tools", needsApi: true },
  { from: "src/loader/packages.ts", to: "features/compose", needsApi: true },
  { from: "src/loader/packages.ts", to: "features/mise-integration", needsApi: true },
  { from: "src/versions.ts", to: "features/secrets" },
  { from: "src/features/mise-integration/projection.ts", to: "packages/tooling" },
  { from: "src/features/mise-integration/projection.ts", to: "packages/tools" },
  { from: "src/features/systemd/units.ts", to: "packages/tools" },
  { from: "src/features/tooling/requirements.ts", to: "packages/tools" },
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

function importSpecifiers(source: string): string[] {
  const code = tokens(source);
  const specifiers: string[] = [];

  for (const [index, keyword] of code.entries()) {
    if (keyword !== "import" && keyword !== "export") continue;

    if (code[index - 1] === "." || code[index - 1] === "?.") continue;

    let next = index + 1;
    const first = code[next];
    const sideEffect = keyword === "import" ? quoted(first) : undefined;

    if (sideEffect !== undefined) {
      specifiers.push(sideEffect);
      continue;
    }

    if (keyword === "import" && first === "(") {
      const dynamic = quoted(code[next + 1], true);
      const after = code[next + 2];

      if (dynamic !== undefined && (after === ")" || after === ",")) specifiers.push(dynamic);
      continue;
    }

    if (first === "type" && code[next + 1] !== "from" && code[next + 1] !== ",") next++;

    if (keyword === "import" && /^[\p{ID_Start}$_]/u.test(code[next] ?? "")) {
      next++;

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

    if (specifier !== undefined) specifiers.push(specifier);
  }

  return specifiers;
}

const aliases = new Map(Object.entries(compilerOptions.paths));

function targetPath(from: string, specifier: string): string | undefined {
  if (specifier.startsWith("./") || specifier.startsWith("../")) return posix.join(posix.dirname(from), specifier);

  if (!specifier.startsWith("@office/")) return undefined;

  const path = aliases.get(specifier)?.[0];

  if (path === undefined) throw new Error(`${from}: ${specifier} has no tsconfig.json path`);

  return posix.normalize(path);
}

const root = toolPath(".");
const production = new Bun.Glob("{src,packages}/**/*.ts");
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

function violation(from: string, origin: Location, destination: Location, pkg: Package | undefined): Allowed["to"] | undefined {
  if (pkg && (origin === "kernel" || origin === "kernel/commands")) return pkg;

  if (pkg && isFeature(origin) && pkg.slice("packages/".length) !== origin.slice("features/".length)) return pkg;

  if (origin === "kernel" && from !== "src/cli.ts" && isFeature(destination)) return destination;

  if (isFeature(origin) && destination === "kernel/commands") return destination;

  return undefined;
}

test("production imports follow the source layout", () => {
  const files = [...production.scanSync({ cwd: root, dot: true })].filter(path =>
    !testFolders.test(path) && !path.split("/").includes("node_modules")
    && !/\.(test|fixture)\.ts$/.test(path),
  ).sort();

  const seen = new Set(files);
  const problems: string[] = [];
  const key = (from: string, to: string) => `${from} → ${to}`;
  const exceptions = new Set(allowed.map(entry => key(entry.from, entry.to)));
  const matched = new Set<string>();
  const packageImports = new Set<string>();
  const distance = new Map<Feature, { kernel: Set<string>; commands: number }>();

  for (const file of files) {
    const folder = fileFolder(file);

    if (isFeature(folder) && !distance.has(folder)) distance.set(folder, { kernel: new Set(), commands: 0 });
  }

  for (const from of files) {
    const origin = fileFolder(from);

    const targets = new Set<string>();

    for (const specifier of importSpecifiers(readFileSync(join(root, from), "utf8"))) {
      const path = targetPath(from, specifier);

      if (path !== undefined && !path.startsWith("sdk/")) {
        const typescriptPath = path.replace(/\.js$/, ".ts");

        targets.add([path, typescriptPath, `${path}.ts`, posix.join(path, "index.ts")].find(candidate => seen.has(candidate)) ?? path);
      }
    }

    for (const to of targets) {
      const destination = fileFolder(to);

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

  console.log("Package imports into the CLI:\n" + [...packageImports].sort().join("\n"));
  console.log("Feature import distance:");

  for (const [folder, { kernel, commands }] of [...distance].sort(([a], [b]) => a.localeCompare(b))) {
    console.log(`${folder}: ${commands} from commands/cli; kernel: ${[...kernel].sort().join(", ") || "none"}`);
  }

  if (problems.length) throw new Error(problems.sort().join("\n"));
});

test("reads multiline, type-only, re-export, side-effect and literal dynamic imports", () => {
  expect(importSpecifiers(`
    import type { A } /* comment */ from "./a.ts"
    import defaultValue, {
      type B, value
    } from './b.ts'
    export type { X } from "./x.ts"
    export * as y from "./y.ts"
    import "./side-effect.ts"
    const lazy = import("./lazy.ts", { with: { type: "text" } })
    type FromQuery = import("./query.ts").Query
    const escaped = import("./\\u0065scaped.ts")
    const template = import(\`./literal.ts\`)
  `)).toEqual(["./a.ts", "./b.ts", "./x.ts", "./y.ts", "./side-effect.ts", "./lazy.ts", "./query.ts", "./escaped.ts", "./literal.ts"]);
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
  ].join("\n"))).toEqual(["./real.ts", "./after-regex.ts", "./divisor.ts", "./asserted-divisor.ts"]);
});
