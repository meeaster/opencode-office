# browser

An `office` package: browser automation for agents, with two tools that do different jobs.

- **[agent-browser](https://github.com/vercel-labs/agent-browser)** drives a headless Chromium of its own. Agents use it to verify UI work, for repeatable checks and for anything unattended. The office's container has Debian's Chromium, and `AGENT_BROWSER_EXECUTABLE_PATH` points agent-browser at it.
- **[Browse](https://opencode.ai/browse)** drives the user's real Chrome, with their logins and extensions, through a relay and the Browse Chrome extension. The package doesn't install it (see "Browse").

Sessions get each as an MCP server, `agent-browser` and `browse`, only where its command is found, and the `browser-automation` skill, which says which to use when (OpenCode's own `browser` skill covers its in-app browser). OpenCode's in-app browser (`tools.browser.*`, present when the desktop app is attached to a session) is a third option the skill covers.

## Install

It is built into `office`, and `office init` lists it. In `office.yaml`:

```yaml
packages:
  - name: browser
```

Then run `office sync` and commit what it wrote: the package in `.office/packages/browser/`, which updates with `office` and is read-only there, and `.mise/conf.d/browser.toml`, which pins agent-browser for the office.

| Setting | |
|---|---|
| `agent_browser_tools` | The tool profiles the agent-browser MCP server starts with, as `agent-browser mcp --tools` takes them: `core` by default (navigation, snapshots, interaction, screenshots), a comma-separated list such as `core,network,debug`, or `all`. `agent-browser mcp --help` lists the profiles. Empty for no agent-browser server |
| `browse` | `true` by default; `false` for no browse server even where Browse is installed |

A change reaches sessions when `office sync` writes the resolved settings, without restarting OpenCode.

## agent-browser

`package.yaml` declares agent-browser as a mise tool, `npm:agent-browser`, at the version an office starts at. `office sync` writes it to `.mise/conf.d/browser.toml` in the office root, a mise fragment that mise loads in the office and every folder below it, wherever it runs. From then on the version is the office's: `office upgrade-tools` bumps it with the office's other pins, and sync never changes it. To pin another version, change it there, or set `"npm:agent-browser"` in the office's `mise.toml`, which wins over the fragment. It needs Node, which the template's `mise.toml` pins.

The container installs it at start, and in host mode `office up` does. The plugin registers `agent-browser mcp --tools <profiles>` when `agent-browser` is on the OpenCode server's PATH; mise's shims put it there in the container. A host server needs mise's shims or activation on its PATH too.

## Browse

Browse isn't a mise tool the office pins: its installer downloads the newest release into `~/.local/bin/browse`, and the binary updates itself. So the package only connects it where it is already installed: the plugin registers `~/.local/bin/browse mcp` (or under `$XDG_BIN_HOME`, or `$OPENCODE_BROWSER_HOME/bin`) when that file exists for the OpenCode server's user. It never looks on the PATH, where xdg-utils' unrelated `/usr/bin/browse` can come first.

Browse's relay listens on the loopback of the machine it runs on, and the extension in Chrome pairs with that relay. In practice that is a host OpenCode server on the machine where the user's Chrome can reach the relay (WSL's loopback is reachable from Windows); the office's container has no Browse, so container sessions get only agent-browser.

To install it on such a host (it asks nothing with `--no-setup`, then pair Chrome once):

```sh
curl -fsSL https://opencode.ai/browse/install | bash -s -- --no-setup
~/.local/bin/browse pair
```
