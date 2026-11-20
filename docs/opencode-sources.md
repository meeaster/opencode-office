# Which OpenCode config and plugins reach a desk?

`office opencode inspect [folder]` shows what is declared or present **on disk** for a location. Run it in the office, pass a folder from elsewhere, or use `--office /path/to/office` (a relative folder then starts there). Omit the folder to inspect the current directory, or the explicit `--office` directory. It works before OpenCode starts, including in container mode.

```text
office.yaml                                  # packages: [{name: common}]
packages/common/office.ts                    # Office package definition
packages/common/plugin/index.js              # OpenCode server plugin
.opencode/plugins/common                     # sync's relative link to ../../packages/common/plugin
.opencode/opencode.jsonc                     # owner config shared by both desks
builder/.opencode/opencode.jsonc              # owner config for builder and its descendants
builder/extensions/local/index.js             # explicitly configured by builder
builder/.opencode/plugins/independent.js      # discovered by OpenCode in builder
builder/repos/sample/opencode.json            # owner config at a nested repo
sibling/                                     # inherits common, not builder's sources
```

For example, in `builder/.opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  // Relative to this file, not to the CLI's current directory.
  "plugins": [{ "package": "../extensions/local" }],
  "commands": { "scope-setting": { "description": "builder-override", "template": "Builder" } },
}
```

`builder/extensions/local/index.js` can use the ordinary [OpenCode plugin API](https://opencode.ai/docs/build/plugins/server):

```js
export default {
  id: "builder-command",
  async setup(ctx) {
    await ctx.command.transform(editor => editor.add({
      name: "builder-command", description: "A command for builder",
      async execute() { /* your command here */ },
    }));
  },
};
```

Output excerpt from `office opencode inspect builder/repos/sample`:

```text
OpenCode sources for builder/<folder-2>/<folder-3> (office-relative; runtime not checked)
Ordinary project discovery inside the office only; external config, policies and runtime overrides are not evaluated.
[folder builder/<folder-2>/<folder-3>] native config: builder/<folder-2>/<folder-3>/opencode.json
[office] native config: .opencode/opencode.jsonc
[desk builder] native config: builder/.opencode/opencode.jsonc
[desk builder] configured local directory: builder/.opencode/opencode.jsonc#plugins[0]
[office] Office-created package link (selected local package): .opencode/plugins/common
[desk builder] convention plugin candidate: builder/.opencode/plugins/<entry-1>
```

## Who owns each source?

- **Native:** Edit models, permissions, MCP, commands and plugin entries in your own `opencode.json(c)`. Ordinary [V2 project discovery](https://opencode.ai/docs/config) applies direct files from farthest to nearest, then `.opencode` files from farthest to nearest (`.json` before `.jsonc`). A desk `.opencode` document can therefore override a **nested repo's direct** document. A Git boundary does not stop the search. Only ancestors of the chosen folder participate. For one desk, use its native config or its `.opencode/{plugin,plugins}/` immediate directories or `.js`/`.ts` files. A `plugins/` directory next to a direct config is not auto-discovered, and a configured local path must be a directory. Project settings need no Office sync.
- **Office package:** `office sync --packages` applies selected packages, including a root link for each installed `plugin/`. Package `.settings.json` and `.office.json` keep their existing readers. There is no desk package selector. Desk code or an explicit native desk entry is the way to narrow scope; selecting a package and referencing its linked plugin again in a desk does not make the root link desk-only.
- **Withdrawal:** A target that looks like a package path is not proof of creation. When sync creates a link it records its office name and physical root, package owner, office-relative link path, exact relative target, device, inode and change time in `.office/resolved/opencode-links.sqlite`. Keep `.office/resolved/` machine-local and ignored in Git. Only a matching receipt authorizes replacement or withdrawal. A still-selected unreadable package keeps its matching link. A changed link, even a different inode with the same spelling, stays. A missing receipt never disables independent package commands or cron. Sync refuses a redirected root plugin parent. Full sync retains the existing migrations for recognizable legacy **bundles** and the exact historical Executor MCP entry; it does not generate or merge native config.
- **Git plugin clones:** `office.yaml`'s `plugins:` selects separate office-wide clones at `.opencode/plugins/<name>`. Full sync handles these; `sync --packages` skips their fetch. Inspect reports the declaration and whether `.git` is present without running Git. The installer refuses to clear a symlink to make room for a checkout. Before refreshing an existing plugin checkout it checks the worktree, Git directory, declared origin and effective fetch URL; redirected/mismatched checkouts remain untouched. It also refuses a checkout whose HEAD names no commit (such as an empty `git init`), reading HEAD without lazy fetching and without changing its files or `.git`: move it aside so sync can clone afresh. This does not change the refresh rules for desk repos or references.
- **First plugin delivery:** Sync clones only into a destination that does not exist. Anything already there, even an empty folder, is the owner's: sync refuses it and asks you to move it aside. On Linux (glibc `renameat2` with `RENAME_NOREPLACE`) and macOS (`renamex_np` with `RENAME_EXCL`), sync initializes a claim (a folder holding `.git` with the declared origin and a file holding a random token) in a private `.office-plugin-*` staging folder in the office root, then renames it into place without replacement, so Git never writes into a folder that was already there. Git fetches into the claim's `.git`, so path-specific `includeIf` config and the effective-origin check apply at the real destination, and checks out into the staging folder. To publish, sync moves the whole claim back into staging in one rename and keeps it only if it is the same folder (device and inode), holds nothing but `.git`, and that `.git` is the same folder and still holds the token; then it renames the complete checkout into place, again without replacement. Device and inode alone are not identity: a freed inode number is reused by the next entry created (ext4 does so at once), so an owner who deletes the claim and creates a folder, `git init`s or clones there can match them, but cannot hold the token. Until publication OpenCode can see at most the empty claim holding `.git`. A folder or file that replaces the claim, enters it or takes the destination meanwhile is never deleted or replaced: if it was briefly moved into staging for the check, it is renamed straight back with the same inode and metadata (an entry that cannot be checked, such as a file, counts as not Office's), and if that fails, sync names where it is kept and leaves that staging folder, removing from it only Office's own `.git`, identified by the token. Cleanup after a failure removes the claim, or only its `.git`, by the same check. Sync removes only the parts of staging it created itself; it never deletes a staging folder that may hold an entry someone else made. The guarantee covers what appears at the destination; something written inside Office's `.office-plugin-*` staging folder while sync runs is not covered. Sync keeps `/.office-plugin-*/` out of commits through the repository's `info/exclude` (in a worktree office, the one its worktrees share). Elsewhere, or on a filesystem that cannot rename without replacing, the first clone fails and publishes nothing. Updating an existing checkout still checks out in place.

  **Recovering an interrupted first clone.** If the first sync of a plugin is killed (for example during the fetch), the destination keeps the claim, a folder holding only `.git`, and the office root keeps an `.office-plugin-*` folder. The next sync refuses the claim with “existing plugin checkout has no commit”: Office cannot prove the folder is its own, so it doesn't delete it. Check that `.opencode/plugins/<name>` holds nothing but `.git` and that the `.office-plugin-*` folder holds nothing you want, delete both, then run `office sync` again. A staging folder that sync names in a “kept at” message holds someone else's entry: move that entry back yourself before deleting the folder.
- **Desktop:** A bundle copy and a registration in the app machine's global `plugins` list are separate from the server link. Inspect looks for matching Office panel records on the local app machine and checks only their bundle presence and registration. It neither imports a bundle nor enumerates unrelated global plugins. If Windows discovery would require launching a process from WSL, or the CLI is inside the container, that machine is not inspected. For isolated fixtures, set **both** `OFFICE_APP_CONFIG_DIR` and `OFFICE_APP_PANELS_DIR`. Even a listed bundle may not be rendered.

## Reading the report

Inspect enumerates **office-local candidates**, not OpenCode's effective configuration. It does not evaluate schemas, substitutions, package definitions, plugin entrypoints/IDs, policy, disable/re-enable rules, or version resolution. It excludes global/system config, ancestor config above the office, explicit/inline service config and any differences on a remote machine. External config symlink targets are not read as project config. Filesystem matches use host paths; another server's namespace is not mapped.

The report uses structural names (declared Office package, clone, desk and repo IDs), the config file, and the field and **zero-based array index**. Arbitrary native plugin specs are never echoed, even if they look like safe npm names, hostnames or local paths. `<folder-N>` is the undeclared ancestor at depth N from the office root. `<entry-N>` is the one-based position among candidates in the desk's or root's sorted `plugin/` then `plugins/` scan. Desktop registration checks the name **and path** in a regular panel receipt file and a regular bundle; output omits machine-specific paths. An office can use pinned Git, built-in and local packages without exposing repo URLs or ref values.

For a configured local directory and a convention link resolving to it, the report repeats **both origins** under `same filesystem target`. Recognized npm names that might denote different revisions get a separate `same package name or ID; versions not resolved` note. Neither verifies activation. The CLI cannot detect equal plugin IDs implemented by unrelated source directories.

### Upgrading from a CLI without receipts or inspect

Already-working pre-ledger links can remain in place. `inspect`, `sync` and `check` identify them as unowned; a matching desired link need not be recreated to use it. If you want Office to **manage** one, inspect it yourself, move just that entry outside `.opencode/plugins/`, then run `office sync --packages` while the package is selected. Sync creates a new link and receipt. If you want to keep the owner entry instead, resolve any conflicting selection. This also applies after copying an office to a new machine, restoring only the workspace, losing the ledger, or Git replacing a link. Deselecting a package can remove its managed package files, so a preserved owner link into them may become dangling.

The old CLI allowed packages to register `opencode inspect`, including aliases and descendants. When the saved generation contains such a claim, the new CLI refuses inspection instead of shadowing or importing the author. Rename the route/alias in the package, or deselect its owner, then run `office sync --packages`. A renewed collision rejects publication; **keep the existing generation**, which remains readable by unrelated commands and retains the commit used for immutable pinned repair.

The compiled `standard/opencode/` owner implements this inspection and the existing package-link plan/apply used by sync and check. It exposes **no new package-author API**. A future typed contribution from an Office package's `setup(ctx)` could declare a server plugin directory; collection would record the declaration, leaving installation to apply and execution to OpenCode.

### Reproduce the native check

From the CLI checkout on Linux with a clean temporary-file hierarchy and no system OpenCode config:

```sh
OFFICE_TEST_OPENCODE="$(command -v opencode)" \
OFFICE_TEST_PRE_INSPECT=/path/to/compiled-ee0bbc2/office \
bun test ./src/opencode-scope.cli.test.ts
```

The tests compile the production CLI, create their own homes, offices, app and machine paths, and use a local request trap for inspect. The optional old binary publishes real pre-inspect generations, exercises the author commands, then upgrades with a moved tag and missing package copy. The independent native case starts only the supplied V2 binary on an ephemeral loopback port, with its own password, no inherited account environment and model fetching disabled. It reads `/api/command` at the root, both desks, a nested Git repo, and a fresh location after withdrawal. Without either variable the offline ledger, inventory and checkout tests still run.
