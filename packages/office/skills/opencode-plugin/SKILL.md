---
name: opencode-plugin
description: Build, debug or verify an OpenCode plugin or desktop app panel, such as a package's plugin/ or gui/; what it registers (skills, MCP servers, commands, RPC), a plugin that doesn't load, a panel that doesn't show or reload, and proving a panel renders.
---

# OpenCode plugins and panels

Every package in an office is an OpenCode plugin: `plugin/` is its server part and `gui/` its optional desktop app panel. The [plugin docs](https://opencode.ai/v2/docs/build/plugins) and their [GUI page](https://opencode.ai/v2/docs/build/plugins/gui) are the API source; read the pages for the parts you build. This skill holds what they don't say: how an office wires a package in, behaviour learned from running plugins, and how to prove a panel works.

When the docs run out, read the OpenCode source ([anomalyco/opencode](https://github.com/anomalyco/opencode)) at the tag of the version the plugin runs on: `tools.opencode` in `office.yaml` (its `version` in the mapping form), or `opencode --version` for a host server.

| Question | Start at |
|---|---|
| The docs pages at that version | `services/site/src/docs/content/build/plugins/` |
| What a context method or hook really does | `packages/plugin/src/promise/adapter.ts`, `packages/plugin/src/effect/session.ts` |
| When a hook fires | `packages/core/src/plugin/host.ts`, `packages/core/src/session/model-request.ts` |
| How a plugin is found, loaded and watched | `packages/core/src/plugin/module.ts` |
| A GUI API's exact behaviour, and built-in panels to copy | `packages/plugin/src/gui/`, `packages/gui-plugins/` (its `README.md` is the authors' guide) |
| How the desktop app lists and reloads panels | `packages/desktop/src/main/plugin/host.ts` |

## How a package becomes a plugin

- **Loading.** `office sync` delivers the registered server directory as `.opencode/plugins/<name>`: a copy for a built-in or Git package, a link for a local package. OpenCode loads it in every location below the office. Entries come from `package.json` exports or conventional `server` and `index` files. OpenCode reloads changed entrypoints and their relative imports in a running server; sync leaves unchanged files untouched.
- **Imports.** Keep relative imports inside the registered directory. Use Node's and Bun's built-ins and OpenCode's `@opencode/plugin` and `effect`, or ship a bundle for other runtime dependencies.
- **Package assets and settings.** Find the office with `officeRootOf(dirname(fileURLToPath(import.meta.url)))` from `@office/sdk/applied-settings` (bundle it into the plugin). Read other assets and `.office.json` from `.office/packages/<name>/` for a managed package or `packages/<name>/` for a local package. Use `readAppliedSettings(office, name)` on demand or `watchAppliedSettings` to reload when sync applies new settings.
- **What it registers**, each from `setup(ctx)`:
  - skills: `ctx.skill.transform((editor) => editor.add({ id, name, description, path, content }))`, with `path` the absolute `SKILL.md` so its references resolve;
  - MCP servers: `ctx.mcp.transform((editor) => editor.set(name, config))`;
  - commands: `ctx.command.transform((editor) => editor.add({ name, description, execute }))`;
  - RPC for a panel: `ctx.rpc.register(Definition, handlers)`, whose result emits the definition's events.
- **The panel.** `gui/` holds `src/`, a `package.json` with the build's pinned dependencies (`@opencode/plugin` at the office's OpenCode version) and the committed bundle `gui/dist/gui-experimental.cjs`, typically built by Vite with `@opencode/plugin/gui/vite`. The package's `setup` registers the bundle with `opencode.panels.add(ctx, { file })` and the plugin folder with `opencode.plugins.add(ctx, { directory })`, from `@office/opencode`: nothing is found by folder name. `office sync` on the host installs the registered bundle on the machine the desktop app runs on; `office gui dev <name>` installs each build while the package's watch build runs.
- **One RPC definition for both halves.** Keep it in `plugin/rpc.ts`, importing nothing (its schemas are plain Standard Schema objects); the plugin registers it and the panel imports it as `../../plugin/rpc.ts`. The panel calls `props.session.server.client.rpc(Definition)`, the session's own server; `ctx.client` is the app's sidecar, where the package's plugin doesn't run.

## Gotchas

- **Omit absent optional fields.** Registries reject a contribution (skill, agent, command, tool) with a key present as `undefined`, and one rejection can abort the whole plugin reload; the symptom shows elsewhere, such as the model list timing out.
- **One instance per location.** Each open folder gets its own plugin instance, so an RPC registration or watcher in `setup` exists once per location, and every instance's RPC event reaches every subscriber. Filter received events on `event.location.directory`, and pass `{ location }` on calls.
- **A plugin's own work re-enters the event stream.** Sessions it creates and messages it sends arrive as events. Remember the IDs of sessions the plugin owns and skip them; a `parentID` check misses top-level ones.
- **It runs inside the `opencode` binary.** `process.execPath` is `opencode`, so start a script with `bun` or `node` by name.
- **Mirror prompt changes into `generate`.** When a `context` hook adds messages or system text, register the same handler for `generate` (and `compaction` when it matters), or `ctx.session.generate` calls miss the session's prompt cache. `session.generate` returns text only: it runs no tool loop and reports no usage.
- **Panel APIs are narrower than they look.** In 2.3.0 `ctx.ui.Markdown` takes only `text` and `class`. A rejected RPC call is not an `Error`: show its `message`, since `String(error)` prints `[object Object]`.
- **The sidecar ignores a symbolic-link bundle.** A panel folder whose `gui-experimental.cjs` is a link isn't listed at all; copy the file.
- **Copies reload file by file.** Sync writes supporting files before exported entrypoints and `package.json`. A slow update can briefly show mixed code or a failed load; check `/api/plugin` after sync and read the server's log if the new code does not load.

## Verify

A plugin is done when a fresh server lists it active and what it registers works when used. A panel is done when it has been seen rendering, with data from its RPC, and a rebuild changes what is seen. Typechecks, a build and a listing prove none of that.

1. **Server part.** `office check` shows, per folder, the package's plugin active and its skills. Use what it registers: load the skill, run the command, call the RPC from the panel.
2. **Panel, every change.** Run the headless Linux desktop app, isolated under `/tmp`, from WSL or inside the office container: [references/headless-desktop.md](references/headless-desktop.md). It needs `agent-browser` on PATH (`command -v agent-browser`), which the office's `browser` package provides. Without it, stop at the sidecar's listing and report: "agent-browser isn't on PATH, so the panel wasn't seen rendering; the office needs the browser package (`- name: browser` under `packages:`, then `office sync` and `mise install`)"; leave adding it to the user.
3. **Panel, before calling it done for a Windows user.** Check the installed copy in their Windows app: [references/windows-desktop.md](references/windows-desktop.md).

Report which checks ran and name the gap each leaves:

| Check | Proves | Leaves unproven |
|---|---|---|
| `office check`, a fresh server's `/api/plugin` | The plugin loads and registers its skills and servers | Anything the panel does |
| A sidecar's `/api/plugin` lists `office-<name>` with `gui` | That machine's app found the bundle | That it evaluates and renders |
| Headless Linux app, rendered and reloaded | The bundle renders in the Linux app at the pinned version, its RPC answers from a sidecar of that version, a rebuild reloads it | The user's Windows app and its version, the copy `office sync` installed there, the user's own server (another OpenCode version in host mode, the container's environment), their real data |
| Windows app over CDP | The user's actual setup | Nothing further for that machine |

A Linux run is never a Windows result: when the Windows check didn't run, say so and why.
