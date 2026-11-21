import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { type ResolvedPackage, verifyInstalledCopy } from "./packages.ts";

const namespace = "@office/";
const moduleName = /^[a-zA-Z0-9][a-zA-Z0-9_-]*\.ts$/;
const typescript = new Bun.Transpiler({ loader: "tsx" });
const javascript = new Bun.Transpiler({ loader: "jsx" });

function inside(root: string, file: string) {
  const rel = relative(root, file);

  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function publicModules(packages: ResolvedPackage[]) {
  const modules = new Map<string, { path: string; pkg: ResolvedPackage }>();

  for (const pkg of packages) {
    const directory = join(pkg.dir, "exports");

    if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) continue;
    const root = realpathSync(pkg.dir);

    for (const file of readdirSync(directory).sort()) {
      if (!moduleName.test(file)) continue;
      const path = realpathSync(join(directory, file));

      if (inside(root, path) && statSync(path).isFile()) modules.set(`${namespace}${pkg.entry.name}/${file.slice(0, -3)}`, { path, pkg });
    }
  }

  return modules;
}

export function createImportMap(folder: string, packages: ResolvedPackage[]) {
  const paths: Record<string, string[]> = {};
  const physical = realpathSync(folder);
  const config = dirname(dirname(physical));
  const nodePath = join(physical, "node_modules");

  for (const [alias, { path }] of publicModules(packages)) {
    const link = join(nodePath, `${alias}.ts`);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(relative(dirname(link), path), link);
    paths[alias] = [`./${relative(config, path)}`];
  }

  // A selected local definition can be missing. Its lexical path and the
  // candidate folder share the office prefix even when it is a symlink.
  const include = packages.map(pkg => `./${relative(dirname(dirname(folder)), pkg.dir)}/office.ts`);
  writeFileSync(join(folder, "tsconfig.contracts.json"), JSON.stringify({ compilerOptions: { paths }, include }, null, 2));

  return nodePath;
}

/** Which changed packages must advance together? Walk the static imports of each definition
 * and its public modules, including relative helpers. Sharing an unchanged standard provider
 * doesn't couple two independent consumers. An unreadable graph is not evidence of independence. */
export function packageDependencies(packages: ResolvedPackage[]) {
  const roots = packages.flatMap(pkg => statSync(pkg.dir, { throwIfNoEntry: false })?.isDirectory() ? [{ name: pkg.entry.name, root: realpathSync(pkg.dir) }] : []);
  const deps = new Map<string, Set<string>>();

  for (const { name, root } of roots) {
    const seen = new Set<string>();
    const imports = new Set<string>();

    const visit = (path: string) => {
      if (seen.has(path) || !/\.(?:[mc]?[jt]s|[jt]sx)$/.test(path)) return;
      seen.add(path);

      for (const { path: spec } of (extname(path).includes("ts") ? typescript : javascript).scanImports(readFileSync(path, "utf8"))) {
        if (spec.startsWith(namespace)) imports.add(spec.split("/")[1]);
        else if (spec.startsWith(".") || isAbsolute(spec)) {
          const dep = realpathSync(Bun.resolveSync(spec, dirname(path)));
          const owner = roots.find(pkg => inside(pkg.root, dep));

          if (owner && owner.name !== name) imports.add(owner.name);
          else if (inside(root, dep)) visit(dep);
        }
      }
    };

    if (existsSync(join(root, "office.ts"))) visit(join(root, "office.ts"));
    const exports = join(root, "exports");

    if (existsSync(exports)) for (const file of readdirSync(exports)) if (moduleName.test(file)) visit(join(exports, file));
    deps.set(name, imports);
  }

  return deps;
}

export function coupledFailures(rejected: string[], pending: string[], views: ResolvedPackage[][]) {
  try {
    const graphs = views.map(packageDependencies);
    const failed = new Set(rejected.filter(name => pending.includes(name)));

    const reachable = (from: string) => {
      const seen = new Set([from]);

      for (const name of seen) for (const graph of graphs) for (const dependency of graph.get(name) ?? []) seen.add(dependency);

      return seen;
    };

    const paths = new Map(pending.map(name => [name, reachable(name)]));

    for (const name of failed) {
      for (const [peer, imports] of paths) if (imports.has(name) || paths.get(name)?.has(peer)) failed.add(peer);
    }

    return [...failed];
  } catch {
    return pending;
  }
}

/** One native module cache per evaluating process. The scan also catches an owner dependency
 * shadowing NODE_PATH; the reserved import must resolve to exactly the selected source. */
export function importGuard(dir: string, packages: ResolvedPackage[], checkSelection?: (pkg: ResolvedPackage) => void) {
  const selected = packages.flatMap(pkg => pkg.kind !== "local" && existsSync(pkg.dir) ? [{ pkg, root: realpathSync(pkg.dir) }] : []);
  const managed = join(realpathSync(dir), ".office");
  const seen = new Set<string>();
  const verified = new Set<string>();

  function targetOf(spec: string) {
    const [, name, member, ...extra] = spec.split("/");
    const pkg = packages.find(item => item.entry.name === name);

    if (!pkg || extra.length || !member || !moduleName.test(`${member}.ts`)) return;
    const file = join(pkg.dir, "exports", `${member}.ts`);

    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) return;
    const path = realpathSync(file);

    if (inside(realpathSync(pkg.dir), path)) return { pkg, path };
  }

  function verify(pkg: ResolvedPackage) {
    if (verified.has(pkg.dir)) return;
    checkSelection?.(pkg);
    verifyInstalledCopy(pkg);
    verified.add(pkg.dir);
  }

  function visit(path: string, root: string) {
    if (seen.has(path)) return;
    const ext = extname(path);

    if (!/^\.(?:[mc]?[jt]s|[jt]sx)$/.test(ext)) return;
    const parser = ext.includes("ts") ? typescript : javascript;
    seen.add(path);

    try {
      for (const edge of parser.scanImports(readFileSync(path, "utf8"))) {
        const spec = edge.path;

        if (spec.startsWith(namespace)) {
          const target = targetOf(spec);

          if (!target) throw new Error(`${path}: ${spec} is not a public export of a selected package`);
          const actual = realpathSync(Bun.resolveSync(spec, dirname(path)));

          if (actual !== target.path) throw new Error(`${path}: ${spec} resolves to ${actual}, expected ${target.path}`);

          verify(target.pkg);
          visit(target.path, realpathSync(target.pkg.dir));
        } else if (spec.startsWith(".") || isAbsolute(spec)) {
          let resolved;

          try { resolved = realpathSync(Bun.resolveSync(spec, dirname(path))); }
          catch { resolved = resolve(dirname(path), spec); }

          if (!inside(root, resolved) && inside(managed, resolved)) {
            const peer = selected.some(item => item.root === root) && selected.find(item => inside(item.root, resolved));

            if (peer) {
              verify(peer.pkg);
              visit(resolved, peer.root);
              continue;
            }

            const target = resolved.match(/\/packages\/([^/]+)\/(?:exports\/)?([^/]+)\.ts$/);
            const alias = target && `${namespace}${target[1]}/${target[2]}`;
            const suggestion = alias && targetOf(alias) ? alias : "@office/<package>/<export>";
            throw new Error(`${path}: ${spec} crosses into ${resolved}; import the selected public module as ${suggestion}`);
          }

          if (existsSync(resolved)) visit(resolved, root);
        }
      }
    } catch (error) {
      seen.delete(path);
      throw error;
    }
  }

  return (path: string) => visit(realpathSync(path), realpathSync(dirname(path)));
}

let guard: ReturnType<typeof importGuard> | undefined;
let rejected: Error | undefined;

export function requireCoherentImports() {
  if (rejected) throw rejected;
}

export function bindImports(dir: string, packages: ResolvedPackage[], checkSelection?: (pkg: ResolvedPackage) => void) {
  guard = importGuard(dir, packages, checkSelection);
}

export function verifyImports(path: string) {
  try {
    if (existsSync(path)) guard?.(path);
  } catch (error) {
    rejected = error instanceof Error ? error : new Error(String(error));
    throw rejected;
  }
}
