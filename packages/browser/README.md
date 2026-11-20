# browser

An `office` package: browser automation for agents, with two tools that do different jobs.

- **[agent-browser](https://github.com/vercel-labs/agent-browser)** drives a headless Chromium of its own, in either mode. Agents use it to verify UI work, for repeatable checks and for anything unattended. The office's container has Debian's Chromium, and `AGENT_BROWSER_EXECUTABLE_PATH` points agent-browser at it. A host-mode office on Ubuntu under WSL can opt into Google Chrome from apt for it instead (see "System Chrome").
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

Then run `office sync` and commit what it wrote: the package in `.office/packages/browser/`, which updates with `office` and is read-only there, `machine.packages.toml`, where sync keeps every package's mise tools, and in a host-mode office `.office/mise/browser.toml`, the package's mise setup.

| Setting | |
|---|---|
| `agent_browser_tools` | The tool profiles the agent-browser MCP server starts with, as `agent-browser mcp --tools` takes them: `core` by default (navigation, snapshots, interaction, screenshots), a comma-separated list such as `core,network,debug`, or `all`. `agent-browser mcp --help` lists the profiles. Empty for no agent-browser server |
| `browse` | `true` by default: a host-mode office installs Browse and sessions get the `browse` server. `false` for neither. No effect in container mode |
| `system_chrome` | `false` by default. `true` in a host-mode office on Ubuntu 24.04 or 26.04 amd64 under WSL: agent-browser launches Google Chrome Stable from Google's apt repository, which the user installs once (see "System Chrome"). Independent of `browse`. No effect in container mode or on another machine |

A change reaches sessions when `office sync` writes the resolved settings, without restarting OpenCode.

## agent-browser

`office.ts` registers its tool requirement, `npm:agent-browser`, at the version the package was tested with. The office's `machine.packages.toml` pins it from then on: `office upgrade-tools` bumps it with the office's other pins, and sync changes it only to raise it to a newer version a package update declares. To pin another version, change it there, or, to stay below the package's version, set `"npm:agent-browser"` in the office's `machine.toml`, which wins over `machine.packages.toml` everywhere (`office check` warns), or its `mise.toml`, which wins in the office's folders. It needs Node to run: the template's `mise.toml` pins it for the office's folders, so for `agent-browser` in other folders too, pin `node` in `machine.toml`.

The container installs it at start, and in host mode `office up` does. The plugin registers `agent-browser mcp --tools <profiles>` when `agent-browser` is on the OpenCode server's PATH: mise's shims put it there in the container; a host server needs mise's shims or activation on its PATH.

## Browse

In a host-mode office with `browse` on, sync adds `bun` (which runs the install script) to `machine.packages.toml`, and writes `.office/mise/browser.toml`, the package's fragment, with a `[hooks]` `postinstall` and a `browser:install` task:

```toml
[hooks]
postinstall = "test -x \"$HOME/.local/bin/browse\" || bun \"{{ config_source | canonicalize | dirname }}/../../.office/packages/browser/scripts/install-browse.ts\""

[tasks."browser:install"]
env = { OFFICE_ROOT = "{{ config_source | canonicalize | dirname }}/../.." }
run = "bun \"$OFFICE_ROOT/.office/packages/browser/scripts/install-browse.ts\""
```

mise reads the fragment only through the link sync makes in its global conf.d, and both find the script from the fragment's own path, so they work from any folder. So the first `mise install` (`office up` runs it in host mode) installs Browse, and later ones leave it alone. `mise run browser:install` reinstalls it, from any folder, to repair a broken binary. `scripts/install-browse.ts` does what Browse's own installer does without its setup step: it reads the stable channel's manifest from Anomaly's release service, picks this machine's build (Linux or macOS, x64 or arm64, the baseline build without AVX2, musl), checks the download's size and SHA-256 against the manifest, and renames `package/bin/browse` over `~/.local/bin/browse`. It runs no `browse install`, edits no agent configs and pairs nothing. Then pair Chrome once:

```sh
~/.local/bin/browse pair
```

**Browse is installed once and never pinned**, unlike everything else an office runs: it updates itself, as its Chrome extension does from the same publisher, and the two negotiate a protocol, so a pinned relay would drift out of compatibility with the extension; and it releases too often to pass a minimum release age.

The plugin registers `~/.local/bin/browse mcp` (or under `$XDG_BIN_HOME`, or `$OPENCODE_BROWSER_HOME/bin`) when the office is in host mode, `browse` is on and the file exists. It never looks on the PATH, where xdg-utils' unrelated `/usr/bin/browse` can come first. `office check` fails the package's line in host mode while Browse is missing, naming `mise install` and the task, and notes, without failing, that `browse` has no effect in a container-mode office.

When the office moves to container mode, or `browse` is turned off, sync removes `bun` from `machine.packages.toml` (unless another package declares it) and the hook and the task from the fragment. The installed binary, its relay and the pairing stay with the machine: `~/.local/bin/browse uninstall` removes them.

## System Chrome

By default agent-browser on a host launches the Chrome for Testing it downloads itself (`agent-browser install`) into `~/.agent-browser/browsers/`, which nothing updates. With `system_chrome: true`, in a host-mode office on Ubuntu 24.04 or 26.04 amd64 under WSL, it launches `/usr/bin/google-chrome-stable` instead: Google Chrome Stable from Google's apt repository, the same binary WSLg runs when the user opens Chrome, patched by apt with the distribution's updates. Each agent-browser launch is headless, with a temporary profile of its own, so it never shares the user's Chrome profile, logins or windows. Browse, a separate setting, keeps driving the user's everyday Windows Chrome. The container is unchanged: Debian's Chromium, refreshed with the image (`office up --refresh`).

It is the package's `system` block (see the office README's "Tools"). `office sync` writes the setup to `.office/mise/browser.toml` and `AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable` to the office's environment file, which terminals and the managed OpenCode server source. To turn it on, set `system_chrome: true` and run `office setup`, on a new machine or one whose office already runs. Setup lists what the machine lacks and, on your yes in a terminal, has mise install it from that terminal, asking for your sudo password; with everything in place it asks nothing. Without a terminal it installs nothing and says to rerun it in one.

- **The repository.** `scripts/google-chrome-apt-source.sh` runs first, as the setup's `pre-packages` hook. When the source is missing it installs `ca-certificates`, `curl` and `gnupg` from the distribution, fetches Google's signing key over HTTPS checked against the distribution's CA certificates, accepts it only when its primary key is `EB4C 1BFD 4F04 2F6D DDCC EC91 7721 F63B D38B 4796` (Google's Linux package signing key), and writes the source exactly where and as Chrome's package does: `/etc/apt/sources.list.d/google-chrome.sources` (`https://dl.google.com/linux/chrome-stable/deb/ stable main`, amd64), `Signed-By: /usr/share/keyrings/google-chrome.gpg`. Chrome's postinst and its daily cron job take both over and keep Google's keys current, so there is one source and no second keyring. A `google-chrome.list` for Google's older address (Chrome's own from earlier releases, or one added by hand) is retired as Chrome's postinst retires it, with an `/etc/apt/keyrings/google-chrome.gpg` no source names any more. With the source in place it changes nothing and asks for no sudo; `--check` only says what a run would change, which is how setup asks.
- **The packages.** apt installs `google-chrome-stable` with its own dependencies, and `system/google-chrome.toml` adds what agent-browser 0.43.0's `install --with-deps` list has that they don't bring on either release: `libnss3-tools` (certutil, for `--ca-cert`), `fonts-noto-color-emoji` and `fonts-noto-cjk`. agent-browser itself needs nothing installed: no `agent-browser install`, and never `--with-deps`.
- **Updates.** It installs `unattended-upgrades` (Ubuntu has it already) and writes `/etc/apt/apt.conf.d/51office-google-chrome`, which adds `origin=Google LLC,label=Google,codename=stable,site=dl.google.com` (the Origin, Label and Codename of the repository's signed Release file) to `Unattended-Upgrade::Origins-Pattern`. An apt list adds to the others, so the distribution's origins and the administrator's stay; whether and when unattended-upgrades runs stays as `/etc/apt/apt.conf.d/20auto-upgrades` says.

- **The proof.** Once `office up` has installed agent-browser, setup runs `scripts/verify-system-chrome.sh` in a fresh shell holding only the office's environment file: in a session of its own (so a new agent-browser daemon, which takes that environment) it opens a page headless and reads it back, and finds the browser by the temporary profile agent-browser made under the script's own `TMPDIR`, which must have been started as `/usr/bin/google-chrome-stable` with `--headless`. Setup fails if it doesn't.
- **The server.** The managed OpenCode server takes the variable when it starts. When it is already running, setup offers to restart it (see the office README's "Tools"); deferred, it keeps serving, its sessions' agent-browser launches its own Chrome until then, and the browser-automation skill says so in each session.

`office check` fails the package's line until Chrome, the source, certutil, both fonts, unattended-upgrades and the apt.conf.d file are on the machine, and notes a `system_chrome` that is on where it doesn't apply; it shows a pending restart as a warning. Seeing Chrome itself in a WSLg window is a separate check, at the desktop. Turning `system_chrome` off removes the setup and the variable; Chrome, its source and the apt.conf.d file stay (`sudo apt-get remove google-chrome-stable`, and delete `/etc/apt/apt.conf.d/51office-google-chrome`).
