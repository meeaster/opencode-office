# browser

An `office` package: browser automation for agents, with two tools that do different jobs.

- **[agent-browser](https://github.com/vercel-labs/agent-browser)** drives a headless Chromium of its own, in either mode. Agents use it to verify UI work, for repeatable checks and for anything unattended. The office's container has Debian's Chromium, and `AGENT_BROWSER_EXECUTABLE_PATH` points agent-browser at it.
- **[Browse](https://opencode.ai/browse)** drives the user's real Chrome, with their logins and extensions, through a relay and the Browse Chrome extension. Only a host-mode office has it.

Sessions get each as an MCP server, `agent-browser` and `browse`, where it applies, and the `browser-automation` skill, which says which to use when (OpenCode's own `browser` skill covers its in-app browser, `tools.browser.*`, present when the desktop app is attached to a session).

## Modes

The office's mode (`opencode:` in `office.yaml`) decides, as declared; the plugin reads it from the package's `.office.json`, which `office sync` writes, and never guesses from where it runs.

- **Host mode:** OpenCode runs on the machine itself, so it has what the machine has: agent-browser, and Browse driving the user's desktop Chrome where there is one.
- **Container mode:** OpenCode runs in the office's container, with no desktop: agent-browser only, and the in-app browser when the desktop app is attached. Browse isn't installed or registered, even for a host session opened in the office.

## Install

It is built into `office`, and `office init` lists it. In `office.yaml`:

```yaml
packages:
  - name: browser
```

Then run `office sync` and commit what it wrote: the package in `.office/packages/browser/`, which updates with `office` and is read-only there, and `.mise/conf.d/browser.toml`, the office's mise fragment for it.

| Setting | |
|---|---|
| `agent_browser_tools` | The tool profiles the agent-browser MCP server starts with, as `agent-browser mcp --tools` takes them: `core` by default (navigation, snapshots, interaction, screenshots), a comma-separated list such as `core,network,debug`, or `all`. `agent-browser mcp --help` lists the profiles. Empty for no agent-browser server |
| `browse` | `true` by default: a host-mode office installs Browse and sessions get the `browse` server. `false` for neither. No effect in container mode |

A change reaches sessions when `office sync` writes the resolved settings, without restarting OpenCode.

## agent-browser

`package.yaml` declares it as a mise tool, `npm:agent-browser`, at the version an office starts at. The fragment pins it from then on: `office upgrade-tools` bumps it with the office's other pins, and sync never changes it. To pin another version, change it there, or set `"npm:agent-browser"` in the office's `mise.toml`, which wins over the fragment. It needs Node, which the template's `mise.toml` pins.

The container installs it at start, and in host mode `office up` does. The plugin registers `agent-browser mcp --tools <profiles>` when `agent-browser` is on the OpenCode server's PATH: mise's shims put it there in the container; a host server needs mise's shims or activation on its PATH.

## Browse

In a host-mode office with `browse` on, sync adds to the fragment `bun` (which runs the install script), a `[hooks]` `postinstall` and a `browser:install` task:

```toml
[hooks]
postinstall = "test -x \"$HOME/.local/bin/browse\" || bun \"{{ config_source | canonicalize | dirname }}/../../.office/packages/browser/scripts/install-browse.ts\""

[tasks."browser:install"]
env = { OFFICE_ROOT = "{{ config_source | canonicalize | dirname }}/../.." }
run = "bun \"$OFFICE_ROOT/.office/packages/browser/scripts/install-browse.ts\""
```

Both find the script from the fragment's own path, so they work in the office and, once sync has linked the fragment into mise's global conf.d, from any folder. So the first `mise install` (`office up` runs it in host mode) installs Browse, and later ones leave it alone. `mise run browser:install` reinstalls it, from any folder, to repair a broken binary. `scripts/install-browse.ts` does what Browse's own installer does without its setup step: it reads the stable channel's manifest from Anomaly's release service, picks this machine's build (Linux or macOS, x64 or arm64, the baseline build without AVX2, musl), checks the download's size and SHA-256 against the manifest, and renames `package/bin/browse` over `~/.local/bin/browse`. It runs no `browse install`, edits no agent configs and pairs nothing. Then pair Chrome once:

```sh
~/.local/bin/browse pair
```

**Browse is installed once and never pinned**, unlike everything else an office runs: it updates itself, as its Chrome extension does from the same publisher, and the two negotiate a protocol, so a pinned relay would drift out of compatibility with the extension; and it releases too often to pass a minimum release age.

The plugin registers `~/.local/bin/browse mcp` (or under `$XDG_BIN_HOME`, or `$OPENCODE_BROWSER_HOME/bin`) when the office is in host mode, `browse` is on and the file exists. It never looks on the PATH, where xdg-utils' unrelated `/usr/bin/browse` can come first. `office check` fails the package's line in host mode while Browse is missing, naming `mise install` and the task, and notes, without failing, that `browse` has no effect in a container-mode office.

When the office moves to container mode, or `browse` is turned off, sync removes `bun`, the hook and the task from the fragment. The installed binary, its relay and the pairing stay with the machine: `~/.local/bin/browse uninstall` removes them.
