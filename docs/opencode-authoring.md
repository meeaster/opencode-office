# Register a package's OpenCode assets

`office.ts` can declare a server plugin directory and a desktop bundle in code. Here is the Tracks consumer in a local office:

```ts
import type { OpenCodeContext } from "../../.office/packages/office/package-context.ts";

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

`edition` here is an ordinary setting of the example package; there is no Office `when` field. On the next `office sync --packages`, `notes-only` withdraws the package's receipted server link, even when its conventional `plugin/` still exists. Not claiming a desktop panel stops copying and registering it; it **does not uninstall** a shared bundle or edit the machine's existing registration. Removing the callback entirely returns to convention discovery. A conventional file, an authored declaration, a creation receipt, and an active OpenCode plugin are different observations.

**Contract.** Use relative paths from this package's directory, one directory for the server and one existing regular `.cjs` file for the GUI. Absolute, traversal and redirected paths are refused. A duplicate claim, throw, invalid type, missing asset or asynchronous return rejects the owner's whole collection. A failed collection keeps an existing receipted link and cannot install a panel. Successful empty collection can withdraw an owned link. Unrelated native plugins, desk JSONC and unrecorded links remain the owner's. See [link custody and upgrade recovery](opencode-sources.md).

**Why a separate callback?** `setup(ctx)` also participates in command discovery and direct handler dispatch. Neither command dispatch nor health, teardown or offline inspection should replay extension registrations. `opencode(ctx)` runs synchronously during package sync and when validating a staged built-in or pinned replacement. It may be called more than once: use only the supplied settings and registration methods; put filesystem mutations, installs and native hooks elsewhere. This is trusted package code, not a sandbox. Office validates the candidates, writes settings, manages a relative root link and installs the machine's panel. Only OpenCode loads the plugin code.

Inspect and health use recorded **data**: relative claims or an unavailable status, and a binding to the package selection/settings and, for a pulled package, its source identity. The record contains no functions or settings values. Changes to a local author's code need another sync. A desktop copy may still belong to a different office. `office gui dev <local-package>` watches the declared bundle; for authored packages it requires the selected owner's fresh collection to agree with the synced registration before writing. Restart it after changing the watched source.

**Rollout:** upgrade all Office writers before switching a consumer's definition. The older CLI (including the `a969014` inspection/receipts build) rejects `opencode(ctx)`; it has no equivalent feature under another key. For a rollback, restore the previous definition before using the older writer. Conventional links retain their existing receipt format. Nonconventional targets have separate custody records; older readers do not acquire authority to prune them. A moved office can still resolve its relative links, but cannot inherit deletion authority merely by copying the files.

From the CLI checkout, `bun test ./src/opencode-scope.cli.test.ts` exercises conditional collection, failure retention, pinned repair, a dev watcher, machine registration and owner replacements through a compiled executable. To include the old-writer control, set `OFFICE_TEST_PRE_ASSETS` to the compiled inspection/receipts-only CLI. The [native test](opencode-sources.md#reproduce-the-native-check) has its own opt-in launcher.
