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
OpenCode sources for builder/repos/sample (office-relative; runtime not checked)
Ordinary project discovery inside the office only; external config, policies and runtime overrides are not evaluated.
[folder builder/repos/sample] native config: builder/repos/sample/opencode.json
[office] native config: .opencode/opencode.jsonc
[desk builder] native config: builder/.opencode/opencode.jsonc
[desk builder] configured builder/extensions/local: builder/.opencode/opencode.jsonc#plugins[0]
[office] Office package link (selected; ../../packages/common/plugin): .opencode/plugins/common
[desk builder] convention plugin candidate: builder/.opencode/plugins/independent.js
```

## Who owns each source?

- **Native:** Edit models, permissions, MCP, commands and plugin entries in your own `opencode.json(c)`. Ordinary [V2 project discovery](https://opencode.ai/docs/config) applies direct files from farthest to nearest, then `.opencode` files from farthest to nearest (`.json` before `.jsonc`). A desk `.opencode` document can therefore override a **nested repo's direct** document. A Git boundary does not stop the search. Only ancestors of the chosen folder participate. For one desk, use its native config or its `.opencode/{plugin,plugins}/` immediate directories or `.js`/`.ts` files. A `plugins/` directory next to a direct config is not auto-discovered, and a configured local path must be a directory. Project settings need no Office sync.
- **Office package:** `office sync --packages` applies selected packages, including a root link for each installed `plugin/`. Package `.settings.json` and `.office.json` keep their existing readers. There is no desk package selector. Desk code or an explicit native desk entry is the way to narrow scope; selecting a package and referencing its linked plugin again in a desk does not make the root link desk-only.
- **Withdrawal:** Only the root `.opencode/plugins/<package-name>` symlink with the exact target `../../packages/<same-name>/plugin` or `../../.office/packages/<same-name>/plugin` has Office's link convention. These committed forms are reserved: there is no historical creator ledger. Other targets (including aliases and dangling owner links), files, and native desk plugins are not package links. An unreadable selected package keeps its link; deselection withdraws it. A conflicting owner file is reported. Sync refuses a redirected root plugin parent. Full sync retains the existing migrations for recognizable legacy bundles and the exact historical Executor MCP entry; it does not generate or merge native config.
- **Git plugin clones:** `office.yaml`'s `plugins:` selects separate office-wide clones at `.opencode/plugins/<name>`. Full sync handles these; `sync --packages` skips their fetch. Inspect reports the declaration and whether `.git` is present, without running Git, validating its origin, or equating checkout presence with activation.
- **Desktop:** A bundle copy and a registration in the app machine's global `plugins` list are separate from the server link. Inspect looks for matching Office panel records on the local app machine and checks only their bundle presence and registration. It neither imports a bundle nor enumerates unrelated global plugins. If Windows discovery would require launching a process from WSL, or the CLI is inside the container, that machine is not inspected. For isolated fixtures, set **both** `OFFICE_APP_CONFIG_DIR` and `OFFICE_APP_PANELS_DIR`. Even a listed bundle may not be rendered.

## Reading the report

Inspect enumerates **office-local candidates**, not OpenCode's effective configuration. It does not evaluate schemas, substitutions, package definitions, plugin entrypoints/IDs, policy, disable/re-enable rules, or version resolution. It excludes global/system config, ancestor config above the office, explicit/inline service config and any differences on a remote machine. External config symlink targets are not read as project config. Paths in the report are host paths; absolute configured paths in another server's namespace are not mapped. Options, headers, Git refs, raw remote URLs and opaque specifiers are not printed.

For a local configured path and a convention link to the same target, the report repeats **both origins** under `possible duplicate source (same target; activation not checked)`. This is a match by real path, not by import or plugin ID. Package specs with the same recognized npm name can also match; plugins in unrelated directories that happen to register the same ID cannot be identified this way. The CLI doesn't suppress either source or infer that two instances ran.

The compiled `standard/opencode/` owner implements this inspection and the existing package-link plan/apply used by sync and check. It exposes **no new package-author API**. A future typed contribution from an Office package's `setup(ctx)` could declare a server plugin directory; collection would record the declaration, leaving installation to apply and execution to OpenCode.

### Reproduce the native check

From the CLI checkout on Linux with a clean temporary-file hierarchy and no system OpenCode config:

```sh
OFFICE_TEST_OPENCODE="$(command -v opencode)" bun test ./src/opencode-scope.cli.test.ts
```

The tests compile the production CLI, create their own homes, offices, app and machine paths, and use a local request trap for inspect. The opt-in native case starts only the supplied V2 binary on an ephemeral loopback port, with its own password, no inherited account environment and model fetching disabled. It reads `/api/command` at the root, both desks, a nested Git repo, and a fresh location after withdrawal. The command list verifies both plugin registration and the effective native command description; no prompt or model call is involved. Without `OFFICE_TEST_OPENCODE`, only the offline case runs.
