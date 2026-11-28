# Which OpenCode config and plugins reach a folder of the office?

`office opencode inspect [folder]` shows what is declared or present **on disk** for a location. Run it in the office, pass a folder from elsewhere, or use `--office /path/to/office` (a relative folder then starts there). Omit the folder to inspect the current directory, or the explicit `--office` directory. It works before OpenCode starts, including in container mode.

```text
office.yaml                                  # packages: [{name: common}]
packages/common/package.json                 # names the definition: "office": { "definition": "./office.ts" }
packages/common/office.ts                    # Office package definition: opencode.plugins.add(ctx, { directory: "plugin" })
packages/common/plugin/index.js              # OpenCode server plugin
.opencode/plugins/common                     # sync's relative link to ../../packages/common/plugin
.opencode/plugins/office/                    # sync's real copy from .office/packages/office/plugin/
.opencode/plugins/imported                   # sync's link to ../../.office/plugins/imported, a plugins: clone
.opencode/plugins/mine/                      # the owner's own plugin, committed; sync never touches it
.opencode/opencode.jsonc                     # owner config shared by every folder of the office
repos/builder/.opencode/opencode.jsonc       # a working repository's own config, for it and its descendants
repos/builder/extensions/local/index.js      # explicitly configured by builder
repos/builder/.opencode/plugins/independent.js  # discovered by OpenCode in builder
repos/builder/sample/opencode.json           # owner config at a repository nested in builder
repos/sibling/                               # inherits common, not builder's sources
```

For example, in `repos/builder/.opencode/opencode.jsonc`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  // Relative to this file, not to the CLI's current directory.
  "plugins": [{ "package": "../extensions/local" }],
  "commands": { "scope-setting": { "description": "builder-override", "template": "Builder" } },
}
```

`repos/builder/extensions/local/index.js` can use the ordinary [OpenCode plugin API](https://opencode.ai/docs/build/plugins/server):

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

Output excerpt from `office opencode inspect repos/builder/sample`:

```text
OpenCode sources for repos/<folder-2>/<folder-3> (office-relative; runtime not checked)
Ordinary project discovery inside the office only; external config, policies and runtime overrides are not evaluated.
[folder repos/<folder-2>/<folder-3>] native config: repos/<folder-2>/<folder-3>/opencode.json
[office] native config: .opencode/opencode.jsonc
[folder repos/<folder-2>] native config: repos/<folder-2>/.opencode/opencode.jsonc
[folder repos/<folder-2>] configured local directory: repos/<folder-2>/.opencode/opencode.jsonc#plugins[0]
[office] Office package link (selected local package): .opencode/plugins/common
[folder repos/<folder-2>] convention plugin candidate: repos/<folder-2>/.opencode/plugins/<entry-1>
```

## Who owns each source?

- **Native:** Edit models, permissions, MCP, commands and plugin entries in your own `opencode.json(c)`. Ordinary [V2 project discovery](https://opencode.ai/docs/config) applies direct files from farthest to nearest, then `.opencode` files from farthest to nearest (`.json` before `.jsonc`). A working repository's `.opencode` document can therefore override a **nested repo's direct** document. A Git boundary does not stop the search. Only ancestors of the chosen folder participate. For one working repository, use its native config or its `.opencode/{plugin,plugins}/` immediate directories or `.js`/`.ts` files. A `plugins/` directory next to a direct config is not auto-discovered, and a configured local path must be a directory. Project settings need no Office sync.
- **Office package:** Sync delivers the directory registered with [`opencode.plugins.add`](opencode-authoring.md) at `.opencode/plugins/<name>`, which every folder in the office inherits. Built-in and Git packages are copied from `.office/packages/<name>/`; local packages stay linked to `packages/<name>/`. Use an ordinary native plugin in a repository to narrow its scope. Sync never adds server plugins to `opencode.json(c)`.
- **Which entries are Office's:** `.office/opencode/copies.json` lists the copied folders by office-relative path. Sync restores edited files there and withdraws the folder when it no longer has a package plugin; `office check` reports differences. Links to `../../packages/<name>/<path>` (local packages) or `../../.office/plugins/<name>` (`plugins:` clones) are owned by their target text, even when dangling. The name in the target must match the destination name. Everything else at the destination belongs to the owner; a conflict stops delivery and names the path. A package still selected but unreadable keeps its existing delivery. Office manages this folder only at the root; a repository's plugin folder and any `.opencode/skills/` are the owner's.
- **Reload:** For a copy, sync replaces only changed files, retaining their modes and staging each write in `.office/tmp/`. Entrypoints and the manifest are written last, and obsolete files are removed after writes. A running OpenCode server sees the changes without a restart. Local package plugins and clones also reload edits in their existing folders. If a plugin changes from a link to a copy or vice versa, or a link changes targets, a running server may keep the old resolution until restarted. To upgrade an office that linked managed plugins, remove links whose target is `../../.office/packages/<name>/<path>` before the first sync and restart OpenCode once after sync.
- **Keeping plumbing out of Git:** Sync maintains a block in the repository's `info/exclude`, preserving the owner's lines. It excludes `/.office/*` (except each folder declared `committed`), `/packages/node_modules/`, and each managed plugin and skill by its exact office-relative path. A copy's destination is recorded and excluded before its first file is written. If sync is interrupted, run it again to finish the copy; unchanged files stay untouched. Sync refuses an ambiguous exclude block and never changes `.gitignore` or untracks files. Worktree offices use their repository's shared exclude file. If the office is a subfolder of another repository, that repository's own rules must ignore the copy destinations; Office doesn't edit its exclude file.
- **Git plugin clones:** `office.yaml`'s `plugins:` selects separate office-wide clones. Each is checked out in `.office/plugins/<name>` and linked as `.opencode/plugins/<name>` -> `../../.office/plugins/<name>` only after the checkout is published (OpenCode doesn't notice a checkout appearing behind an existing link, so a link that was already there is made again). Links are made in `.office/tmp/` and renamed into place without replacement, never as a dot-name in `.opencode/plugins/`, which OpenCode would load as a plugin; where the filesystem can't rename without replacing, the link is created in place, which also never replaces anything. Full sync handles clones; `sync --packages` skips their fetch and keeps their links. Updates fetch and check out inside the existing checkout; a new clone is never renamed over one. Withdrawing a `plugins:` entry removes its link and keeps its checkout, which may hold local work. An existing checkout is linked before it is fetched, so a fetch that fails (offline, or an auth problem) never leaves it unlinked: a checkout whose link was deleted is linked again if sync can verify it. `office check` lists any `.office/plugins/<name>` that no `plugins:` entry declares, with the path to remove if you don't want it; sync never deletes one. If a withdrawn name is selected again with another repository, sync refuses the old checkout and names the folder to move aside. A real folder at `.opencode/plugins/<name>` is the owner's: sync refuses to link the clone there and leaves it. Inspect reports the declaration, whether `.git` is present and whether the link is in place, without running Git. The installer refuses to clear a symlink to make room for a checkout. Before refreshing an existing plugin checkout it checks the worktree, Git directory, declared origin and effective fetch URL; redirected/mismatched checkouts remain untouched. It also refuses a checkout whose HEAD names no commit (such as an empty `git init`), reading HEAD without lazy fetching and without changing its files or `.git`: move it aside so sync can clone afresh. This does not change the refresh rules for working repositories or references.
- **First plugin delivery:** Sync clones only into a destination that does not exist. Anything already there, even an empty folder, is the owner's: sync refuses it and asks you to move it aside. On Linux (glibc `renameat2` with `RENAME_NOREPLACE`) and macOS (`renamex_np` with `RENAME_EXCL`), sync initializes a claim (a folder holding `.git` with the declared origin and a file holding a random token) in a private `.office/tmp/plugin-*` staging folder, on the same filesystem as `.office/plugins/`, then renames it into place without replacement, so Git never writes into a folder that was already there. Git fetches into the claim's `.git`, so path-specific `includeIf` config and the effective-origin check apply at the real destination, and checks out into the staging folder. To publish, sync moves the whole claim back into staging in one rename and keeps it only if it is the same folder (device and inode), holds nothing but `.git`, and that `.git` is the same folder and still holds the token; then it renames the complete checkout into place, again without replacement. Device and inode alone are not identity: a freed inode number is reused by the next entry created (ext4 does so at once), so an owner who deletes the claim and creates a folder, `git init`s or clones there can match them, but cannot hold the token. Until publication OpenCode can see at most the empty claim holding `.git`. A folder or file that replaces the claim, enters it or takes the destination meanwhile is never deleted or replaced: if it was briefly moved into staging for the check, it is renamed straight back with the same inode and metadata (an entry that cannot be checked, such as a file, counts as not Office's), and if that fails, sync names where it is kept and leaves that staging folder, removing from it only Office's own `.git`, identified by the token. Cleanup after a failure removes the claim, or only its `.git`, by the same check. Sync removes only the parts of staging it created itself; it never deletes a staging folder that may hold an entry someone else made. The guarantee covers what appears at the destination; something written inside Office's staging folder while sync runs is not covered. Staging is under `.office/`, which sync keeps out of commits. Elsewhere, or on a filesystem that cannot rename without replacing, the first clone fails and publishes nothing. Updating an existing checkout still checks out in place.

  **Recovering an interrupted first clone.** If the first sync of a plugin is killed (for example during the fetch), the destination keeps the claim, a folder holding only `.git`, and `.office/tmp/` keeps a `plugin-*` folder. No link is made, so OpenCode doesn't see it. The next sync refuses the claim with “existing plugin checkout has no commit”: Office cannot prove the folder is its own, so it doesn't delete it. Check that `.office/plugins/<name>` holds nothing but `.git` and that the `plugin-*` folder holds nothing you want, delete both, then run `office sync` again. A staging folder that sync names in a “kept at” message holds someone else's entry: move that entry back yourself before deleting the folder.
- **Desktop:** A bundle copy and a registration in the app machine's global `plugins` list are separate from server plugin delivery. Inspect looks for matching Office panel records on the local app machine and checks only their bundle presence and registration. It neither imports a bundle nor enumerates unrelated global plugins. If Windows discovery would require launching a process from WSL, or the CLI is inside the container, that machine is not inspected. For isolated fixtures, set **both** `OFFICE_APP_CONFIG_DIR` and `OFFICE_APP_PANELS_DIR`. Even a listed bundle may not be rendered.

## Reading the report

Inspect enumerates **office-local candidates**, not OpenCode's effective configuration. It does not evaluate schemas, substitutions, package definitions, plugin entrypoints/IDs, policy, disable/re-enable rules, or version resolution. It excludes global/system config, ancestor config above the office, explicit/inline service config and any differences on a remote machine. External config symlink targets are not read as project config. Filesystem matches use host paths; another server's namespace is not mapped.

The report uses structural names (declared Office package and clone IDs, and the office's own `repos/`, `references/` and `scratch/` folders), the config file, and the field and **zero-based array index**. Arbitrary native plugin specs are never echoed, even if they look like safe npm names, hostnames or local paths. `<folder-N>` is the undeclared ancestor at depth N from the office root. `<entry-N>` is the one-based position among candidates in the folder's or root's sorted `plugin/` then `plugins/` scan. Desktop registration checks the name **and path** in a regular panel receipt file and a regular bundle; output omits machine-specific paths. An office can use pinned Git, built-in and local packages without exposing repo URLs or ref values.

For a configured local directory and a convention link resolving to it, the report repeats **both origins** under `same filesystem target`. Recognized npm names that might denote different revisions get a separate `same package name or ID; versions not resolved` note. Neither verifies activation. The CLI cannot detect equal plugin IDs implemented by unrelated source directories.

`opencode inspect` is the CLI's own command. A package can't register it, an alias of it or a name under it: sync rejects the registration, help names it, and the CLI runs its own inspect whatever a package registers.

Packages [register their server plugin and panel](opencode-authoring.md) in `setup`. Inspect reports what the last sync applied, from its record, separately from current filesystem and app-machine evidence; it loads no package definition.

### Reproduce the native check

From the CLI checkout on Linux with a clean temporary-file hierarchy and no system OpenCode config:

```sh
OFFICE_TEST_OPENCODE="$(command -v opencode)" \
./bin/test ./src/features/opencode/test/opencode-scope-inventory.e2e.test.ts
```

The tests compile the production CLI, create their own homes, offices, app and machine paths, and use a local request trap for inspect. The native case starts only the supplied V2 binary on an ephemeral loopback port, with its own password, no inherited account environment and model fetching disabled. It reads `/api/command` at the root, both working repositories under `repos/`, a Git repo nested in one of them, and a fresh location after withdrawal. It also declares a Git-cloned plugin and checks that its command, loaded through the link into `.office/plugins/`, is listed at the root, the working repositories and the nested repo. Without the variable the file's offline inventory and ownership tests still run. The checkout tests are in `src/features/opencode/test/opencode-scope-clones.e2e.test.ts`, and the info/exclude tests in `test/kernel/git.test.ts`.
