import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import * as v from "valibot";

const localManifest = v.object({ name: v.string(), exports: v.unknown() });

export function pluginEntrypoints(source: string): ReadonlySet<string> {
  const directory = realpathSync(source);
  const files = new Set<string>();
  let manifest: unknown;

  try {
    manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof Error && "code" in error && ["ENOENT", "EISDIR"].includes(String(error.code)))) throw error;
  }

  const read = v.safeParse(localManifest, manifest);
  const name = read.success && read.output.exports !== undefined ? read.output.name : undefined;
  const parts = [["server", ""], ["tui"], ["rpc"], name ? ["gui-experimental"] : ["gui-experimental.cjs", "gui-experimental.js"]];

  // Use the same resolver and entrypoint order as OpenCode's Host.resolve.
  for (const candidates of parts) {
    for (const candidate of candidates) {
      const specifier = name ? (candidate ? `${name}/${candidate}` : name) : join(directory, candidate || "index");
      let resolved: string;

      try {
        resolved = Bun.resolveSync(specifier, directory);
      } catch {
        continue;
      }

      const path = relative(directory, resolved);

      if (path && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)) files.add(path);
      break;
    }
  }

  files.add("package.json");

  return files;
}
