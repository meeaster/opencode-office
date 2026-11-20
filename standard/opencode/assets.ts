import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import * as v from "valibot";
import type { InstalledPackage } from "../../src/packages.ts";

// Portable package-relative names. A link receipt never authorizes a path outside this owner.
const asset = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_-][\w.-]*(?:\/[a-zA-Z0-9_-][\w.-]*)*$/));
const bundle = v.pipe(asset, v.endsWith(".cjs"));
export const assetPaths = v.strictObject({ server: v.optional(asset), panel: v.optional(bundle) });

export type AssetPaths = v.InferOutput<typeof assetPaths>;

export function packageTarget(name: string, target: string) {
  return [`../../packages/${name}/`, `../../.office/packages/${name}/`].some(prefix => target.startsWith(prefix) && v.is(asset, target.slice(prefix.length)));
}

export function validateAssets(root: string, dir: string, paths: AssetPaths) {
  for (const [part, path] of Object.entries(paths)) {
    const dest = join(dir, path);
    const inside = relative(root, dest);
    const info = lstatSync(dest, { throwIfNoEntry: false });

    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside) || !(part === "server" ? info?.isDirectory() : info?.isFile()) || realpathSync(dest) !== join(realpathSync(root), inside)) {
      throw new Error(`OpenCode ${part} asset must be an existing ${part === "server" ? "directory" : "regular file"} inside the package, without redirected paths`);
    }
  }
}

/** No host operations in the registration context. Never hand a partially collected list to apply. */
export function collectAssets(root: string, item: InstalledPackage): AssetPaths {
  const paths: AssetPaths = {};
  const register = item.manifest.opencode;

  if (register) {
    let invalid = false;

    const returned = register({
      settings: structuredClone(item.settings),
      serverPlugin(path) {
        if (paths.server !== undefined || !v.is(asset, path)) invalid = true;
        else paths.server = path;
      },
      desktopPanel(path) {
        if (paths.panel !== undefined || !v.is(bundle, path)) invalid = true;
        else paths.panel = path;
      },
    });

    if (returned !== undefined) {
      void Promise.resolve(returned).catch(() => {});
      throw new Error("opencode(ctx) must register synchronously and return nothing");
    }

    if (invalid) throw new Error("expected at most one package-relative server directory and one .cjs desktop bundle");
  } else {
    if (item.plugin) paths.server = "plugin";

    if (item.panel) paths.panel = relative(item.dir, item.panel);
  }

  validateAssets(root, item.dir, paths);

  return { ...paths };
}
