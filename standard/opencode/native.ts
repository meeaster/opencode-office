// Read native source declarations, never substitute variables or evaluate OpenCode's config.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as v from "valibot";
import { OfficeError } from "../../src/office.ts";
import { check } from "../../src/schema.ts";

export const pluginSource = v.union([
  v.string(),
  v.pipe(v.object({ package: v.string() }), v.transform(entry => entry.package)),
  v.pipe(v.looseTuple([v.string()]), v.transform(([source]) => source)),
]);

const plugins = v.optional(v.array(v.fallback(pluginSource, "")), []);
const declaration = v.object({ plugin: plugins, plugins });

function within(root: string, path: string) {
  const part = relative(root, path);

  return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
}

export type Source = { origin: string; description: string; identity?: string };

function configured(root: string, path: string, origin: string, spec: string): Source {
  const npm = /^((?:@[\w.-]+\/)?[a-z0-9][\w.-]*)(?:@(?:[\d.~^*-]+|latest))?$/.exec(spec);

  // An apparent package name, path component or hostname can itself be a credential.
  // Use values for private comparisons only. The config path, field and index are the origin.
  if (npm) return { origin, description: "configured package or ID", identity: `npm:${npm[1]}` };

  if (/^-?[\w.*-]+$/.test(spec) && (spec.startsWith("-") || spec.includes("*"))) return { origin, description: "plugin control" };

  if (/^(?:git\+)?(?:https?|ssh):\/\//i.test(spec)) return { origin, description: "configured remote source" };

  let local: string | undefined;

  if (spec.startsWith("./") || spec.startsWith("../") || isAbsolute(spec)) local = resolve(dirname(path), spec);
  else if (spec.startsWith("file://")) {
    try {
      local = fileURLToPath(spec);
    } catch { /* Not an inspectable local file URL. */ }
  }

  if (!local || /[?#{}\p{Cc}]/u.test(spec)) return { origin, description: "configured source (details withheld)" };

  if (!within(root, local)) return { origin, description: "configured external path (not inspected)" };

  const info = statSync(local, { throwIfNoEntry: false });

  if (!info?.isDirectory()) return { origin, description: `configured local path (${info ? "not a plugin directory" : "missing"})` };

  return { origin, description: "configured local directory", identity: realpathSync(local) };
}

export function configSources(root: string, path: string, origin: string): Source[] {
  const file = lstatSync(path, { throwIfNoEntry: false });

  if (!file) return [];

  try {
    if (!within(root, realpathSync(path)) || !statSync(path).isFile()) return [{ origin, description: "native config (not inspected)" }];

    const read = check(v.safeParse(declaration, Bun.JSONC.parse(readFileSync(path, "utf8"))));

    if (read.ok) return [
      { origin, description: "native config" },
      ...(["plugin", "plugins"] as const).flatMap(field => read.value[field].map((spec, index) => configured(root, path, `${origin}#${field}[${index}]`, spec))),
    ];
  } catch { /* Parse and IO diagnostics can contain config values. */ }

  return [{ origin, description: "native config (unreadable; entries not inspected)" }];
}

/** Ordinary project discovery: all direct documents, then all .opencode directories.
 * Stop at the office; never interpret global/system config as an office source. */
export function projectDirectories(root: string, folder: string) {
  if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new OfficeError("inspect requires an existing folder");

  const current = realpathSync(folder);

  if (!within(root, current)) throw new OfficeError("inspect folder must be inside the selected office");

  const dirs = [current];

  while (dirs[0] !== root) dirs.unshift(dirname(dirs[0]));

  return dirs;
}

export function conventionSources(root: string, dir: string) {
  const sources: { path: string; identity?: string }[] = [];

  for (const name of ["plugin", "plugins"]) {
    const folder = join(dir, ".opencode", name);

    if (!existsSync(folder) || !within(root, realpathSync(folder)) || !statSync(folder).isDirectory()) continue;

    for (const entry of readdirSync(folder).sort()) {
      const path = join(folder, entry);
      const info = statSync(path, { throwIfNoEntry: false });

      if (info?.isDirectory() || (info?.isFile() && /\.(js|ts)$/.test(entry))) sources.push({ path, identity: realpathSync(path) });
      else if (!info && lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) sources.push({ path });
    }
  }

  return sources;
}
