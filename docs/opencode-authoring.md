# Register a package's OpenCode assets

A package reaches OpenCode only through what its `setup` registers with the core `opencode` package: at most one **server plugin directory**, which OpenCode loads directly, and at most one **desktop panel bundle**. A folder name alone registers nothing. Here is the Tracks consumer in a local office. Its `package.json` names the definition and declares `@office/opencode`, whose handles it imports:

```json
{
  "name": "@office/tracks",
  "description": "Tracks work in this office.",
  "private": true,
  "exports": {},
  "office": {
    "definition": "./office.ts",
    "dependencies": ["@office/opencode"]
  }
}
```

```ts
// office.ts
import { opencode } from "@office/opencode";
import { Package } from "@office/sdk";

export default Package.define({
  setup(ctx) {
    opencode.plugins.add(ctx, { directory: "plugin" });
    opencode.panels.add(ctx, { file: "gui/dist/gui-experimental.cjs" });
  },
});
```

A registration can depend on settings like any other entry `setup` adds:

```ts
setup(ctx) {
  if (ctx.settings.edition === "notes-only") return;
  opencode.plugins.add(ctx, { directory: "extensions/server" });
  if (ctx.settings.edition === "desktop") opencode.panels.add(ctx, { file: "dist/review.cjs" });
}
```

`edition` here is an ordinary setting of the example package. On the next `office sync --packages`, `notes-only` withdraws the package's server plugin. Not registering a desktop panel stops copying and registering it; it **does not uninstall** a shared bundle or edit the machine's existing registration. For a managed package, sync updates the same real folder even when the registered server directory changes.

**What the plugin owns.** OpenCode discovers `.opencode/plugins/<name>` for every folder of the office. For a built-in or Git package it is a copy of the registered directory; for a local package it is a relative link into `packages/<name>/`. Keep the plugin self-contained: put imported files within the registered directory and bundle dependencies OpenCode doesn't provide. For package assets outside that directory, find the office from the plugin's own folder (for example with `officeRootOf` from `@office/sdk/applied-settings`, bundled into the plugin), then read `.office/packages/<name>/` for a managed package or `packages/<name>/` for a local one. The plugin registers its own skills, tools, MCP servers, hooks and RPC. Use `skills.add` from `@office/skills` to offer a standalone skill the office can enable by ID.

**Contract.** Use relative paths from this package's directory: one existing directory for the server and one existing regular `.cjs` file for the panel. Absolute, traversal and redirected paths are refused, as are symlinks inside a copy source. Each registry's parser refuses a malformed path, and a second server directory or panel from the same package fails gathering before publication. A missing path fails delivery, naming the package. Sync owns plugin copies by [receipt](opencode-sources.md#who-owns-each-source) and recognizes local plugin links by their target. Sync never edits an OpenCode config for server plugins.

**Applied record.** Sync records what it applied in `.office/resolved/opencode-assets.json`: each package's relative paths, or an unavailable status, bound to its selection, settings and, for a pulled package, its source identity. It holds no functions or settings values and confers no ownership of links. `office opencode inspect` and `office gui dev <local-package>` read only this record, so neither runs package code; sync reads it to name a withdrawn package's panel. `office check` gathers every package, so it reports what they register now. `gui dev` watches the recorded bundle and refuses a package whose settings or source changed since the last sync; restart it after changing the registration. Each time it starts or the build writes, it checks the files themselves before copying: a bundle folder that leads outside the package through a link, or a bundle that isn't a regular file there, stops it, while a build removing its output is only waited out.

From the CLI checkout, `./bin/test ./src/features/opencode/test/opencode-scope-registrations.e2e.test.ts` exercises conditional registration, failure retention, pinned repair, a dev watcher, machine registration and owner replacements through a compiled executable. The [native test](opencode-sources.md#reproduce-the-native-check) has its own opt-in launcher.
