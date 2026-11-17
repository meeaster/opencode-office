# The headless Linux desktop app

`scripts/desktop.ts` runs the OpenCode desktop app's Linux build with no display, in a test root of its own under `/tmp`, with one package's panel registered and a session open on a test project. It works on WSL and inside the office container, and runs with nothing but Bun. Paths below are relative to this skill's folder.

## Start

```sh
bun scripts/desktop.ts start --package <package folder>
```

Where `bun` isn't installed, as in the office's container, run this and every command below as `BUN_BE_BUN=1 office scripts/desktop.ts ...`.

- **The build.** The version is `versions.opencode` from the `office.yaml` above the package; pass `--version <x.y.z>` outside an office, or to match a host server (`opencode --version`). The first run for a version downloads `opencode-desktop-linux-<arch>.AppImage` (about 300 MB) from that version's GitHub release of anomalyco/opencode, checks it against the release's `SHA256SUMS`, and extracts it into `$XDG_CACHE_HOME/office/opencode-desktop/<version>-<arch>/` (`~/.cache/...`). A mismatch keeps nothing and fails.
- **Isolation.** The app gets `OPENCODE_DESKTOP_TEST_ROOT`, with `HOME` and `OPENCODE_TEST_HOME` inside the root, no `OPENCODE_*` variable of the calling session, its own sidecar port (the default is the user's real sidecar's, and it doesn't try another) and its own CDP port. It never reads the user's OpenCode config, sessions or skills.
- **The panel.** The script stages `<root>/panel/` as `office sync` would, with a copy of `<package>/gui/dist/gui-experimental.cjs` and a generated `package.json` naming it `office-<package folder name>`, and registers it in the root's `opencode.json`. Build the bundle first.
- **The project.** `<root>/project/` is a minimal office: `office.yaml` and the package's `plugin/` linked as `.opencode/plugins/<name>`, so the sidecar runs the plugin and answers the panel's RPC. Copy in the data the plugin reads (such as the office's `tracks/`) before opening the panel, or pass `--project <folder>` for a prepared one. Keep it under `/tmp`: OpenCode walks up from a session's folder, and a folder under the user's home picks up their instructions and skills.
- **In a container** (`/.dockerenv` exists) the script adds `--no-sandbox`, which Chromium needs there; pass `--no-sandbox` yourself for another sandbox-less environment. CDP listens on the container's loopback, so run `agent-browser` in the same container.

It returns within seconds, once the sidecar lists the panel, the session exists and the package's plugin is active in the staged project, and prints the run as JSON (also in `<root>/run.json`): `root`, `cdpPort`, `sidecar` (`url`, `username`, `password`), `session`, `project`, `log`. On a failure it prints the end of the app's log and the `stop` command for the app it left running.

## See the panel

Use an `agent-browser` session name of your own, and absolute paths for screenshots.

```sh
agent-browser --session <name> connect <cdpPort>
agent-browser --session <name> snapshot -i
```

1. Click **Home**.
2. Under **Recent sessions**, click the session named after the project folder (`project`, shown as `P New session project`).
3. Click **Toggle review**: the side region opens with a tab per panel.
4. Click the panel's tab, the title its `PanelTab` gives (such as **Tracks**).
5. `agent-browser --session <name> snapshot` and read the panel's text below its tab; take a `screenshot` when layout matters.

Done when the snapshot shows the panel's own content and, where it reads RPC, data or a message that came from the plugin, not a loading state or an error.

## Rebuild and see it change

Change something visible, rebuild the bundle (the package's own build in `gui/`), then copy it in:

```sh
bun scripts/desktop.ts reload --root <root>
```

The open window reloads the panel within a second or two; snapshot again and find the change. Done when the new text shows without restarting the app.

## Stop

```sh
agent-browser --session <name> close
bun scripts/desktop.ts stop --root <root>
```

`stop` ends every process of the app's session and the sidecar staged under `<root>/desktop/cli/`, then deletes the root; `--keep` keeps it for its logs. Read the logs before stopping without it.

## When something is missing

| Symptom | Look at |
|---|---|
| `start` fails waiting for CDP or the sidecar | `<root>/app.log`. Lines about the GPU, EGL, Vulkan or "Could not open the default X display" are normal noise in headless mode |
| The sidecar never lists the panel | `curl -u opencode:<password> <url>/api/plugin`, and `<root>/data/opencode/log/opencode.log` for `loading plugin` and load errors |
| The panel shows an RPC error | The plugin didn't load for the project: its folder lacks the link, or the plugin returned early (no `office.yaml` above, missing data). `curl -g -u opencode:<password> "<url>/api/plugin?location[directory]=<project>"` lists what loaded there |
| The window or screenshot is 1x1 | The app started without `--ozone-override-screen-size`; start it with the script |
