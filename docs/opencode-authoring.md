# Register a package's OpenCode assets

A package definition (`office.ts`, or whatever file its `package.json` names) can declare a server plugin directory and a desktop bundle in code. Here is the Tracks consumer in a local office. Its `package.json` names the definition and declares the package it imports from:

```json
{
  "name": "@office/tracks",
  "private": true,
  "exports": {},
  "office": {
    "definition": "./office.ts",
    "dependencies": ["@office/office"]
  }
}
```

```ts
// office.ts
import type { OpenCodeContext } from "@office/office/context";

export default {
  name: "tracks",
  description: "Tracks work in this office.",
  opencode(ctx: OpenCodeContext) {
    ctx.serverPlugin("plugin");
    ctx.desktopPanel("gui/dist/gui-experimental.cjs");
  },
};
```

The callback **itself** selects explicit registration for both parts. Omit it to use the existing conventions (`plugin/`, `gui/dist/gui-experimental.cjs`) in either TS or YAML. Providing it with zero, one or two claims is meaningful. For example:

```ts
opencode(ctx: OpenCodeContext) {
  if (ctx.settings.edition === "notes-only") return;
  ctx.serverPlugin("extensions/server");
  if (ctx.settings.edition === "desktop") ctx.desktopPanel("dist/review.cjs");
}
```

`edition` here is an ordinary setting of the example package; there is no Office `when` field. On the next `office sync --packages`, `notes-only` withdraws the package's server link, even when its conventional `plugin/` still exists. Not claiming a desktop panel stops copying and registering it; it **does not uninstall** a shared bundle or edit the machine's existing registration. Removing the callback entirely returns to convention discovery. A conventional file, an authored declaration, an Office link, and an active OpenCode plugin are different observations. Changing the registered server directory relinks `.opencode/plugins/<name>` and prints a restart notice: a running OpenCode server keeps loading the directory it first found.

**Contract.** Use relative paths from this package's directory, one directory for the server and one existing regular `.cjs` file for the GUI. Absolute, traversal and redirected paths are refused. A duplicate claim, throw, invalid type, missing asset or asynchronous return rejects the owner's whole collection. A failed collection keeps the package's existing link and cannot install a panel. Successful empty collection withdraws its link. The link `.opencode/plugins/<name>` -> `../../packages/<name>/<path>` (or `.office/packages/`) is Office's by that text alone, so any such link is managed with the package; unrelated native plugins, desk JSONC and links elsewhere remain the owner's. See [which entries are Office's](opencode-sources.md#who-owns-each-source).

**Why a separate callback?** `setup(ctx)` also runs on every package command and on `office --help`, which load every selected package. Neither package commands nor health, teardown or offline inspection should replay extension registrations. `opencode(ctx)` runs synchronously during package sync and when validating a staged built-in or pinned replacement. It may be called more than once: use only the supplied settings and registration methods; put filesystem mutations, installs and native hooks elsewhere. This is trusted package code, not a sandbox. Office validates the candidates, writes settings, manages a relative root link and installs the machine's panel. Only OpenCode loads the plugin code.

Inspect and health use recorded **data**: relative claims or an unavailable status, and a binding to the package selection/settings and, for a pulled package, its source identity. The record, `.office/resolved/opencode-assets.json`, contains no functions or settings values and confers no ownership of links. Changes to a local author's code need another sync. A desktop copy may still belong to a different office. `office gui dev <local-package>` watches the declared bundle; for authored packages it requires the selected owner's fresh collection to agree with the synced registration before writing. Restart it after changing the watched source.

**Rollout:** upgrade all Office writers before switching a consumer's definition. Older CLIs reject `opencode(ctx)`; they have no equivalent feature under another key. For a rollback, restore the previous definition before using the older writer. An older writer that predates authored registrations doesn't recognize a link to a nonconventional server directory as a package link, so it leaves it in place. Links are relative, so a moved or copied office keeps working and stays manageable.

From the CLI checkout, `bun test ./src/opencode-scope-registrations.e2e.test.ts` exercises conditional collection, failure retention, pinned repair, a dev watcher, machine registration and owner replacements through a compiled executable. To include the old-writer control, set `OFFICE_TEST_PRE_ASSETS` to a compiled CLI from before authored registrations. The [native test](opencode-sources.md#reproduce-the-native-check) has its own opt-in launcher.
