import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import * as v from "valibot";
import type { Entries } from "../../../sdk/index.ts";
import { assetPath, opencode } from "../../../packages/opencode/handles.ts";

// Portable package-relative names, so a registered path never leads outside its package.
export const asset = v.pipe(v.string(), v.regex(assetPath));
const bundle = v.pipe(asset, v.endsWith(".cjs"));
export const assetPaths = v.strictObject({ server: v.optional(asset), panel: v.optional(bundle) });

export type AssetPaths = v.InferOutput<typeof assetPaths>;

export function validateAssets(root: string, dir: string, paths: AssetPaths) {
  for (const [part, path] of Object.entries(paths)) {
    const dest = join(dir, path);
    const inside = relative(root, dest);
    const info = lstatSync(dest, { throwIfNoEntry: false });

    const managed = join(root, ".office/packages");
    const expected = dirname(dir) === managed ? join(realpathSync(managed), basename(dir), path) : join(realpathSync(root), inside);

    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside) || !(part === "server" ? info?.isDirectory() : info?.isFile()) || realpathSync(dest) !== expected) {
      throw new Error(`OpenCode ${part} asset must be an existing ${part === "server" ? "directory" : "regular file"} inside the package, without redirected paths: ${path}`);
    }
  }
}

/**
 * What each package registered with `opencode.plugins.add` and `opencode.panels.add`, by package,
 * read from a complete gathering. The registries' keys already allow one of each per package.
 */
export function contributedAssets(entries: Entries): Map<string, AssetPaths> {
  const assets = new Map<string, AssetPaths>();

  for (const { owner, value } of entries(opencode.plugins)) assets.set(owner, { server: value.directory });

  for (const { owner, value } of entries(opencode.panels)) assets.set(owner, { ...assets.get(owner), panel: value.file });

  return assets;
}
