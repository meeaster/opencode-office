# Register a package's OpenCode assets

A package reaches OpenCode only through what its `setup` registers with the core `opencode` package: at most one **server plugin directory**, which OpenCode loads directly, and at most one **desktop panel bundle**. No folder is found by its name: a package with a `plugin/` or `gui/dist/` folder and no registration gets no link and no panel. Here is the Tracks consumer in a local office. Its `package.json` names the definition and declares `@office/opencode`, whose handles it imports:

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

`edition` here is an ordinary setting of the example package. On the next `office sync --packages`, `notes-only` withdraws the package's server link. Not registering a desktop panel stops copying and registering it; it **does not uninstall** a shared bundle or edit the machine's existing registration. Changing the registered server directory relinks `.opencode/plugins/<name>` and prints a restart notice: a running OpenCode server keeps loading the directory it first found.

**What the plugin owns.** OpenCode loads the registered directory as a native plugin, through the root link `.opencode/plugins/<name>`, so every desk and nested repository gets it. The plugin's own code registers its skills, tools, MCP servers, hooks and RPC, as the `office`, `knowledge`, `design`, `browser`, `aws-emulator` and `artifact-share` plugins do: a skill bundled with a plugin is the plugin's, not a standalone skill, and the `skills` package's catalog doesn't list it. A package that wants a folder of its own offered as a standalone skill, which the office enables by ID, registers it with `skills.add` from `@office/skills` instead (see the README's "Standalone skills").

**Contract.** Use relative paths from this package's directory: one existing directory for the server and one existing regular `.cjs` file for the panel. Absolute, traversal and redirected paths are refused. Each registry's parser refuses a malformed path, and a second server directory or panel from the same package fails the gathering naming the package, so no package set is published. A path that doesn't exist fails delivery, naming the package, and keeps its existing link and panel. The link `.opencode/plugins/<name>` -> `../../packages/<name>/<path>` (or `.office/packages/`) is Office's by that text alone, so any such link is managed with the package; unrelated native plugins, desk JSONC and links elsewhere remain the owner's. See [which entries are Office's](opencode-sources.md#who-owns-each-source).

**Applied record.** Sync records what it applied in `.office/resolved/opencode-assets.json`: each package's relative paths, or an unavailable status, bound to its selection, settings and, for a pulled package, its source identity. It holds no functions or settings values and confers no ownership of links. `office opencode inspect` and `office gui dev <local-package>` read only this record, so neither runs package code; sync reads it to name a withdrawn package's panel. `office check` gathers every package, so it reports what they register now. `gui dev` watches the recorded bundle and refuses a package whose settings or source changed since the last sync; restart it after changing the registration. Each time it starts or the build writes, it checks the files themselves before copying: a bundle folder that leads outside the package through a link, or a bundle that isn't a regular file there, stops it, while a build removing its output is only waited out.

From the CLI checkout, `bun test ./src/opencode-scope-registrations.e2e.test.ts` exercises conditional registration, failure retention, pinned repair, a dev watcher, machine registration and owner replacements through a compiled executable. The [native test](opencode-sources.md#reproduce-the-native-check) has its own opt-in launcher.
