// What other packages import: `opencode.plugins.add` and `opencode.panels.add`, which a package's
// `setup` calls to have OpenCode load a folder of its own as a server plugin, or install a bundle
// of its own as a desktop panel. Nothing is found by folder name. The office CLI's OpenCode
// integration reads these registries at sync, check and `office gui dev`.
import { Registry, type RegistryEntry, type SetupContext } from "@office/sdk";

/** A path inside the package, relative and portable, so a registration never leads outside it. */
export const assetPath = /^[a-zA-Z0-9_-][\w.-]*(?:\/[a-zA-Z0-9_-][\w.-]*)*$/;

/** A server plugin: a directory of the package OpenCode loads as a plugin. */
export type ServerPlugin = { directory: string };

/** A desktop panel: a `.cjs` bundle of the package the desktop app loads. */
export type DesktopPanel = { file: string };

function only(input: RegistryEntry, field: string, what: string): string {
  const value = input[field];
  const unknown = Object.keys(input).filter(key => key !== field);

  if (unknown.length) throw new Error(`${what}: unknown key ${unknown.join(", ")}; it has only ${field}`);

  if (typeof value !== "string" || !assetPath.test(value)) throw new Error(`${what}: ${field} must be a relative path inside the package, such as plugin`);

  return value;
}

const plugins = Registry.define<ServerPlugin>({
  id: "opencode.plugins",
  key: () => "server directory",
  keyScope: "package",
  parse: input => ({ directory: only(input, "directory", "an OpenCode server plugin") }),
});

const panels = Registry.define<DesktopPanel>({
  id: "opencode.panels",
  key: () => "desktop panel",
  keyScope: "package",
  parse(input) {
    const file = only(input, "file", "an OpenCode desktop panel");

    if (!file.endsWith(".cjs")) throw new Error("an OpenCode desktop panel: file must be a .cjs bundle");

    return { file };
  },
});

/** The plugin and panel registries, each with `add`: one of each per package. */
export const opencode = {
  plugins: {
    ...plugins,
    /** Has OpenCode load `directory`, a folder of the calling package, as its server plugin. */
    add(ctx: Pick<SetupContext, "add">, plugin: ServerPlugin): void {
      ctx.add(plugins, plugin);
    },
  },
  panels: {
    ...panels,
    /** Installs `file`, a `.cjs` bundle of the calling package, as its desktop panel. */
    add(ctx: Pick<SetupContext, "add">, panel: DesktopPanel): void {
      ctx.add(panels, panel);
    },
  },
};
