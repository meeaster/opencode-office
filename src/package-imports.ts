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
  const config = dirname(dirname(folder));
  const nodePath = join(folder, "node_modules");

  for (const [alias, { path }] of publicModules(packages)) {
    const link = join(nodePath, `${alias}.ts`);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(relative(dirname(link), path), link);
    paths[alias] = [`./${relative(config, path)}`];
  }

  writeFileSync(join(folder, "tsconfig.contracts.json"), JSON.stringify({ compilerOptions: { paths }, include: packages.map(pkg => `./${relative(config, pkg.dir)}/office.ts`) }, null, 2));

  return nodePath;
}

/** One native module cache per evaluating process. The scan also catches an owner dependency
 * shadowing NODE_PATH; the reserved import must resolve to exactly the selected source. */
export function importGuard(dir: string, packages: ResolvedPackage[]) {
  const modules = publicModules(packages);
  const selected = packages.flatMap(pkg => pkg.kind === "local" ? [] : [pkg.dir]);
  const managed = join(dir, ".office");
  const seen = new Set<string>();
  const verified = new Set<string>();

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
          const target = modules.get(spec);

          if (!target) throw new Error(`${path}: ${spec} is not a public export of a selected package`);
          const actual = realpathSync(Bun.resolveSync(spec, dirname(path)));

          if (actual !== target.path) throw new Error(`${path}: ${spec} resolves to ${actual}, expected ${target.path}`);

          if (!verified.has(target.pkg.dir)) {
            verifyInstalledCopy(target.pkg);
            verified.add(target.pkg.dir);
          }

          visit(target.path, realpathSync(target.pkg.dir));
        } else if (spec.startsWith(".") || isAbsolute(spec)) {
          let resolved;

          try { resolved = realpathSync(Bun.resolveSync(spec, dirname(path))); }
          catch { resolved = resolve(dirname(path), spec); }

          const sameManagedSet = selected.includes(root) && selected.some(dir => inside(dir, resolved));

          if (!inside(root, resolved) && inside(managed, resolved) && !sameManagedSet) {
            throw new Error(`${path}: ${spec} crosses into ${resolved}; import the selected public module as @office/<package>/<export>`);
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

export function bindImports(dir: string, packages: ResolvedPackage[]) {
  guard = importGuard(dir, packages);
}

export function verifyImports(path: string) {
  try {
    if (existsSync(path)) guard?.(path);
  } catch (error) {
    rejected = error instanceof Error ? error : new Error(String(error));
    throw rejected;
  }
}
