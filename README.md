# opencode-office: the `office` tool

An **office** is a source-controlled folder of **desks** for OpenCode. The folder a session starts in decides what the agent knows and can do: every session loads the office root's instructions, config and skills, and a session in a desk also loads that desk's. Desks never load each other's.

## Quick start

You need Linux x64, Docker with Compose and Buildx, and Git.

**With an AI agent** that can run terminal commands, such as Claude Code, OpenCode or Codex, paste this:

> Install the `office` tool and set up an office for me by following https://raw.githubusercontent.com/meeaster/opencode-office/main/INSTALL.md. Ask me the questions it lists before you run anything.

**By hand:**

```sh
curl -fsSL https://raw.githubusercontent.com/meeaster/opencode-office/main/install.sh | sh
office init ~/office --name <name>
cd ~/office    # edit office.yaml: replace the example desk with your desks (then rm -rf example), add a git: identity
office setup
git add -A && git commit -m "Set up the office"   # setup never commits; on a fresh machine set a git identity first
```

[INSTALL.md](INSTALL.md) goes through the same steps with the decisions spelled out, and "First run" below covers setup's options.

This repository holds the `office` command, the template `office init` copies, the built-in packages (the `office` package every office runs among them), the base image of the `opencode` container and the compose file for the two services every office runs:

- **Executor** holds every service account and runs the office's schedules, webhooks and approvals. It always runs in a container.
- **OpenCode** serves every desk, in one of two modes that `office.yaml` chooses:
  - **container** (the default): the office's `opencode` container, with the office mounted at `~/workspace`.
  - **host**: an OpenCode server on this machine. The office attaches to it by default; opt in to a managed background service on Linux with systemd.

  ```yaml
  opencode: container
  # or
  opencode:
    mode: host
    url: http://127.0.0.1:49374
  ```

An office keeps its own content: desks, skills, plugins, Executor apps, cron jobs and any extra services. It also pins the versions of what runs in its containers (OpenCode, Claude Code, Executor and mise) and of Socket Firewall, which every package download goes through; see "Versions" and "Socket Firewall".

## Install

`office` is one executable carrying the template, the built-in packages and image files. Put it on your PATH, such as at `~/.local/bin/office`. Docker with Compose and Buildx, and Git, are host prerequisites. Portable encrypted secrets also need host SOPS and age, and an office with private GitHub sources gh; no Node/npm runtime is needed. `office --version` prints its version and build commit.

Every commit to `main` publishes a pre-release named `0.1.0-<UTC date and time>` on the [releases page](https://github.com/meeaster/opencode-office/releases), for Linux x64; the newest ten are kept. Since they are all pre-releases, GitHub has no `releases/latest`. [`install.sh`](install.sh) chooses one and installs it as `~/.local/bin/office`:

```sh
curl -fsSL https://raw.githubusercontent.com/meeaster/opencode-office/main/install.sh | sh
curl -fsSL https://raw.githubusercontent.com/meeaster/opencode-office/main/install.sh | OFFICE_VERSION=0.1.0-20261116T163238Z sh   # exactly this release
```

It installs the newest release that publishes the Linux x64 executable and a `SHA256SUMS`, whatever its age, and prints which; `office update` is what applies a minimum age, to later updates. It checks the download against the release's `SHA256SUMS` and runs it once with `--version` before it replaces an existing `office`. It never uses sudo, and it never edits shell startup files: if `~/.local/bin` isn't on your PATH, it prints the line to add. It is safe to rerun.

To install a release by hand instead, take its name from the releases page:

```sh
release=0.1.0-20261116T163238Z
curl -fsSLO https://github.com/meeaster/opencode-office/releases/download/$release/office-linux-x64
curl -fsSLO https://github.com/meeaster/opencode-office/releases/download/$release/SHA256SUMS
sha256sum -c --ignore-missing SHA256SUMS
mkdir -p ~/.local/bin && install -m 755 office-linux-x64 ~/.local/bin/office
office --version
```

### Updating

`office update` replaces the `office` you run with a newer release, from any folder:

```sh
office update --check                        # report the newest eligible release, change nothing
office update                                # install the newest eligible release (default age: 0d)
office update --minimum-release-age 7d       # or at least this old (hours, days or weeks)
office update --version 0.1.0-20261116T163238Z   # exactly this release, whatever its age
```

- It reads the releases page without a login and only considers releases that publish this machine's executable (`office-<platform>-<arch>`) and a `SHA256SUMS` for it. The age comes from the option, not from any `office.yaml`, because one executable serves every office. `--check` prints the command that installs what it found, including the age it used, and the `--version` command for exactly that release.
- Without `--version` it never installs an older release than the one it runs. A build from a checkout isn't a release: it compares against the release built from the same commit, and a build of an unreleased commit, or one with uncommitted changes, is left alone (`--version` replaces it deliberately). `--version` can also go back to an older release.
- It downloads beside the executable, checks the file against the release's `SHA256SUMS`, runs it once to confirm it reports the release's version and commit, and only then renames it over the old one. Any failure leaves the old executable as it was. When `office` is a symlink, it replaces the file the link points to. It needs write access to that folder and never uses sudo.
- `office` run from a checkout (`bin/office`) refuses: update the checkout instead.

Updating `office` changes no office. Each office picks the new one up when you run, in it, `office sync` (updates the office's copies of the built-in packages, which you then commit), `office up` (in container mode, rebuilds the `opencode` image with the new `office`) and `office check` (confirms the container runs the host's `office`). `office up` keeps the OpenCode, Claude Code, Executor, mise and sfw versions the office last applied; only `office up --upgrade` applies newer ones from `office.yaml` (see "Versions"). In host mode the cron timers run the executable itself, so they use the new `office` straight away.

### Building from source

To build it from this checkout, with Bun, pnpm and pre-commit from `mise.toml`:

```sh
mise install
pnpm install
pnpm run install-office   # builds target/office and installs it as ~/.local/bin/office
```

Before your first commit, install the gitleaks hook once per clone; it blocks commits that contain secrets:

```sh
pre-commit install
```

`pnpm run build` only builds `target/office`. `bin/office` runs the CLI from the checkout with Bun, without building. `pnpm run typecheck` checks the CLI and the plugins; `pnpm test` runs the tests (launcher behavior tests also use host `jq`, already included in the container).

## Commands

`office --help` lists them. Every command except `init` and `update` acts on the office in the current folder or above it, or on `--office <dir>`.

| Command | Does |
|---|---|
| `office init <dir> [--name <name>]` | Creates an office from `template/`: root files, a starter `office.yaml` at this tool's versions with its `office.lock`, one example desk, the built-in `office`, `knowledge` and `browser` packages (see "Packages") and a git repository on branch `main`, with git's pre-commit hook when this machine already has the office package's pre-commit (see "The office CLI's tools") |
| `office setup [--owner-email <email>] [--generate-age-key] [--install-deps] [--verbose]` | Resumes onboarding after init or clone: checks prerequisites and secrets, the office's commit identity and GitHub, reads every source, syncs, installs git's pre-commit hook, offers the office's system setup when something is pending (see "Tools"), starts Executor, bootstraps its owner and the office's organization-bound Executor key (see "The office's Executor key"), then starts OpenCode, deploys apps, runs the system setup's verify scripts, offers to restart a managed OpenCode server running with older settings, and checks. Human provider logins remain separate. `--generate-age-key` consents to creating a host identity/public recipient config. `--install-deps` authorizes installing mise and the versions of SOPS, age, gh and pre-commit the office pins (see "The office CLI's tools"). The identity and GitHub come from `office.yaml`'s `git` block; see "Git and GitHub" |
| `office executor credentials [--password-only]` | Deliberately decrypts and reveals the stored owner login on the host, even with Executor stopped. Password-only writes exact password bytes, without a newline, for a clipboard pipe; it does not verify the live password |
| `office sync [--references] [--verbose]` | Clones and updates references and desk repositories, four at a time, refusing a clone path that holds anything but its own clone (or an empty folder), moves an office laid out by an earlier release to the current layout (see "Upgrading an office from before built-in packages"), scaffolds declared desks that are missing, copies declared skills into `skills/` at the refs `office.yaml` pins (recording the commit in `.source.json`; see "Copied skills"), installs, updates, restores and removes packages (see "Packages"), writes the mise tools packages declare into `machine.packages.toml` (raising a version below what a package needs, and saying so) and their mise setup into `.office/mise/` and, in a host-mode office you agreed may manage its machine, links them and `machine.toml` into mise's global conf.d and writes the environment file and Socket Firewall's wrappers (see "Tools", "Machine" and "Socket Firewall"), links enabled library skills into each `.opencode/skills/` and package plugins into `.opencode/plugins/`, clones declared plugins, and installs package panels on the desktop app's machine (see "Panels"). It never writes to `AGENTS.md` or other hand-written files |
| `office skills update` | Moves each `skills.copied` group that has a `track` to where it points now (a branch's newest commit, or the highest stable SemVer tag matching a pattern such as `v2.*`), copies all of the group's skills at that commit and records the full SHA as the group's `ref`. A group whose track resolves to nothing, whose new commit lacks one of its skills, or with edits a copy would lose keeps its pin and every copy, and the command exits 1 after the other groups. See "Copied skills" |
| `office packages update` | Moves each package from another repository that has a `track` the same way, records the full SHA as its `ref`, and applies the packages as `office sync` does (settings, template files, tools, plugin links). A package whose track resolves to nothing or whose new copy fails keeps its pin and copy. Neither update command touches the other category, references or desks, and `office sync` applies pins without moving them. See "Packages" |
| `office check` | Reports drift between `office.yaml` and the folders, including what an earlier release's layout left that `office sync` moves on; one line per package (its kind and source, edits to a pulled-in copy, settings, its mise tools (missing from `machine.packages.toml`, or below the package's version) and mise setup, plugin, and the services its `compose.yaml` contributes: their problems, a pending upgrade and, when the office runs, whether they run) and per package panel; a tool in `machine.packages.toml` no package declares, and a warning for a `machine.toml` pin below a package's version; the office CLI's tools (whether this host has the versions `machine.packages.toml` pins, and a pin of one of them in the office's own files) and git's pre-commit hook (installed, registered, this office's build); the versions and whether `office.lock` matches, a warning for versions outside the range this tool was tested with and for a pending upgrade; when the containers run, also whether they run the applied versions, Executor's health, whether the container's `office` is the host's (`office --version`), whether every app is deployed for the `apps` framework Executor serves; for the root and each desk, on the mode's OpenCode server, its agents, its skills (the library's it enables and each package's), its plugins (each package's, the `office` package's included, active) and its Executor connection; and the cron runner (supercronic in the container, or the host's timers); for managed OpenCode, the systemd unit, its server PID, pending restart and secret validation; in container mode, the weekly image refresh timer and a warning when the image's Debian packages are more than eight days old; last, for information and never a failure, what sessions load from outside the office (the global and system config folders, `~/.claude` and `~/.agents` skills, and config, `.opencode/` folders and `AGENTS.md` above the office, in the session's home: the host's, or in container mode `opencode-home/`), one line per item with its path and link target, skills and plugins as the server reports loading them when it runs, and a warning for an outside skill or plugin with the name of one the office provides, saying which loads |
| `office instructions [folder]` | Prints the guidance the `office` package's plugin gives a session started in that folder, from the same code |
| `office instructions --session <id>` | Reads all instruction entries currently stored on that session from the office's running OpenCode server. Prints each key and its full text, including entries written by custom plugins. These entries are one part of the model prompt. From a shell tool in an OpenCode session, use `office instructions --session "$OPENCODE_SESSION_ID"` |
| `office up [--upgrade] [--refresh] [--verbose]` / `office down` | Starts or stops the compose project `office-<name>`: `executor`, `opencode` (container mode only), the services packages contribute and the office's own `compose.yaml`. `up` runs the versions and package compose files it last applied; `--upgrade` applies pending changes. In container mode `up` builds the image and installs the weekly image refresh timer; `--refresh` rebuilds with current Debian packages. In host mode `up` installs Socket Firewall, mise tools and cron timers, and starts opted-in managed OpenCode; `--upgrade` queues a managed restart or takeover. `down` removes the timers and stops the managed server without removing its unit. See "Host mode" |
| `office shell` / `office exec -- <command...>` | A shell, or one command, in the running `opencode` container as its user, in the container folder matching the one you run it from (the office root, a desk, a repository in it; else the office root), with the container's home and mise's tools. `exec` forwards stdin and the exit status, and a terminal when both ends are one, so it works in pipes. Neither starts or rebuilds anything; in host mode they say to run commands on the host |
| `office pin` | Writes `office.lock` for the versions `office.yaml` pins, looking up any it doesn't already hold on GitHub or Executor's registry |
| `office pair [--origin <url>]` | Prints a one-time link that connects the OpenCode desktop app or a browser to the office's OpenCode server. It works once, within five minutes; the app stays signed in until the password changes. `--origin` replaces the address in the link |
| `office gui dev <package>` | While a local package's panel is being built, installs the bundle on the desktop app's machine each time the build writes it; see "Panels" |
| `office apps deploy` | Installs missing `executor.catalog_apps` and deploys Executor app folders in `executor-apps/*` and `<desk>/executor-apps/*`. It first type-checks local sources against the framework Executor serves. For office-authored apps it updates the `apps` dependency, supplies the mode-specific `office.ts` and links the OpenCode account when required |
| `office apps adopt <catalog-id>` | Copies an installed Executor catalog app's currently deployed source into `executor-apps/<catalog-id>/` for customization. Future deployments target that app in place |
| `office upgrade-tools` | Bumps each exact pin in the office's own `mise.toml` files (root and desks), its `machine.toml` and `machine.packages.toml` (keeping each line's package comment; see "Tools"), and the versions in `office.yaml`, to the newest release at least the office's minimum release age old, and commits the changed files alone as the office's git identity, else `office cron`. See "Cron" |
| `office update [--check] [--minimum-release-age <age> \| --version <release>]` | Replaces this `office` executable with the newest eligible GitHub release newer than this one (default minimum age: `0d`), or exactly `<release>`. `--check` only reports. It changes no office; see "Updating" |
| `office cron list` / `office cron run <job-id>` | Lists enabled, applicable YAML jobs or runs one by its qualified ID; see "Cron" |
| `office context --model <provider/model#variant>` | Measures the tokens the office adds to the first request of a session started in the current folder on the running host-mode OpenCode server. Repeat `--model` to compare models; see "Measuring what the office adds" |

### Measuring what the office adds

Run `office context` in the folder you want to measure. Pass at least one model in OpenCode's `provider/model` notation, optionally followed by `#variant`:

```sh
office context --model 'openai/gpt-6-luna#low' --model claude-agent/haiku
```

For each model, the command sends two real requests: one from a fresh empty folder outside the office and one from the current folder. It prompts each session with `Reply with exactly: OK`, counts input tokens including cache reads and writes, and deletes the session. It prints both totals and the difference, followed by each plugin instruction entry and its size in characters. If your `office.yaml` has a `context.models` setting, remove the `context` block and pass those models with `--model` instead.

A model whose request fails (for example a provider's "Insufficient balance") is reported with the provider's message, the others are still measured, and the command exits non-zero. Every probe session is titled `office context probe`; a run first deletes sessions with exactly that title, which an interrupted run left. It works only in host mode for now: in container mode the empty baseline folder would have to exist inside the container, and the command refuses.

### Native Claude Code in the office

In a [mise-activated shell](https://mise.jdx.dev/cli/activate.html), run `claude` from the office root, a desk, or a nested repository. The office launcher runs the installed Claude Code in the same folder and adds `CLAUDE.md` and `AGENTS.md` discovery via Claude's built-in instruction plugin. The extra settings file applies only to that invocation; your normal user and project settings, plugins, and sign-in still apply. The office doesn't install Claude on the host, edit your Claude profile, or change `claude` outside the office. If you pass `--settings <file-or-json>` or `--settings=<file-or-json>` before `--`, your explicit settings take precedence: the launcher passes them through without adding the office file.

The launcher also loads the required `office` package's Claude plugin. Its session-start hook gives Claude the same repository-scoping guidance the package supplies to OpenCode: investigate at the root or desk, then move the current session to the target repository before editing.

`office sync` maintains `.office/claude/bin/claude` and `.office/claude/settings.json`. New offices already expose the launcher in the root `mise.toml`. For an existing office, run `office sync` and add the following to the **office root's** `mise.toml`:

```toml
[env]
_.path = ["{{ config_root }}/.office/claude/bin"]
```

If `[env]` already exists, add only the `_.path` line there; if it already sets `_.path`, add the launcher directory to the existing list. Keep all other entries. Review and trust the changed file with `mise trust mise.toml` if mise asks. Remove the path entry to opt out.

### What setup, sync and up print

`office setup`, `office sync` and `office up` show what runs now, in stages. Setup's are, in order: Tools, Secrets, Git and GitHub, This machine (host mode only), Repositories and packages, System packages, Services, Apps and Checks; `office sync` is the Repositories and packages stage alone and `office up` the Services stage alone. Each stage ends in one line with a short summary and its time.

- **In a terminal** (stdin and stdout both one), a running stage shows a spinner with its elapsed time. A slow command (a mise install, an image build, Compose) shows its last three lines under a stationary heading, refreshed at most ten times per second. Success clears the live lines; failure prints the recent output. Clones and fetches run four at a time under one progress line. Successful results print together, while a failure appears immediately and keeps git's last lines. Questions are prompts. A few steps take the terminal for themselves and pause the display: the `gh auth login` browser login, the system packages step, where mise asks for your sudo password, and `office check` at the end of setup. Setup's closing next steps (`office pair`, the Executor dashboard, provider logins, the shell line) come in a box.
- **Without a terminal** (agents, cron, a pipe), it prints one plain line per event, `<stage>: <message>`, with no escape codes: `tools`, `secrets`, `git`, `machine`, `repos`, `system`, `services`, `apps`, `checks`. A command's output appears only when it fails (its last lines, prefixed `| `), or every line with `--verbose`, which also asks git for its progress. Nothing ever prompts: the flags answer, or the command stops naming the flag, as before. The closing steps are `next:` lines. A stop goes to stderr as `office <command>: stopped: <reason>`.

A failure stops the command with exit code 1; Ctrl+C stops it with 130 and stops the commands it started. Rerunning continues: setup skips what is already in place. `office sync` never lets git prompt for a login (it fails that source instead, naming git's error); `office setup` reads every source with your credentials before it syncs.

## Layout

| Path | What it is |
|---|---|
| `src/` | The CLI in TypeScript on Bun: `cli.ts` (arguments), `schema.ts` (the shape of `office.yaml`, `office.lock` and a package's `package.yaml`, shared with the `office` package's plugin), `office.ts` (reads `office.yaml`), `versions.ts` (pins, the lock, what was applied), `sfw.ts` (Socket Firewall: what is wrapped, the wrappers and the environment file), `host-env.ts` (a host-mode office's environment file and sfw folder), `host-tools.ts` (the programs the CLI runs on the host: its own mise, and the office package's tools), `hook.ts` (git's pre-commit hook in an office), `releases.ts` (release lookups on GitHub and the registry), `layout.ts` (what the folders should hold), `packages.ts` (the three kinds of package; installs, updates, restores and reads them), `package-services.ts` (the services packages add: validation, generated secrets, the applied copies), `package-system.ts` (a package's one-time machine setup: where it applies, its fragment part, its check), `migrate.ts` (moves an office from an earlier release's layout), `desktop.ts` (installs package panels on the desktop app's machine), `tool.ts` (the tool's own files, the built-in packages as offices get them, its version, the image's build folder), `report/` (how setup, sync and up show progress: one reporter, a Clack renderer for a terminal and plain lines otherwise), `build.ts` (compiles the executable), `vendor-artifact-share.ts` (regenerates the libraries the artifact-share package carries, from pinned devDependencies), `commands/` and `cron/` (`container.ts` for supercronic, `host.ts` for systemd timers). Runtime dependencies: `yaml`, `valibot` and `@clack/prompts` |
| `bin/office` | Runs the CLI from the checkout with Bun |
| `template/office/` | What `office init` copies once: `AGENTS.md`, `README.md`, `office.yaml`, `.opencode/opencode.jsonc`, `executor-apps/opencode/`, `mise.toml` (node), `machine.toml` (empty, the office's own; `office sync` writes `machine.packages.toml` beside it), `.pre-commit-config.yaml` (gitleaks), `.gitignore` |
| `template/desk/` | What `office sync` scaffolds for a new desk, including its starter Executor app, which a desk with `app: false` in `office.yaml` goes without |
| `packages/` | The built-in packages, embedded in the executable (see "Packages"): `office`, which every office has, and `knowledge`, `artifact-share`, `design` and `browser`. `packages/office/plugin/` is the source of the `office` package's plugin, with `instructions.ts`, which `office instructions` also runs; offices get it bundled with what it imports into one `plugin/index.js` |
| `image/Dockerfile` | The base image: Debian 13 with OpenCode, Claude Code, mise and Socket Firewall at the office's versions and checksums (build arguments), sfw's wrappers (`office sfw-wrappers`), supercronic pinned by the tool, build tools, Chromium (with `AGENT_BROWSER_EXECUTABLE_PATH` pointing agent-browser at it) and the compiled `office`. Its apt layer upgrades Debian's packages as of the office's last refresh (the `APT_REFRESH` build argument). User `office`, uid 1000 |
| `image/entrypoint.sh` | Writes the office's environment file to `/etc/opencode/env.sh` (`office env --container`: Socket Firewall's wrappers first on PATH unless switched off, release ages) and sources it, writes the machine note to `/etc/opencode/machine.md`, links the office's `machine.packages.toml`, the packages' fragments in `.office/mise/` and `machine.toml` into mise's global conf.d in the home volume, installs the tools they and the office's `mise.toml` files declare, runs missed cron jobs and starts supercronic, then runs OpenCode |
| `image/config/opencode.jsonc` | The container's managed settings: no self-update, and the machine note as an instruction |
| `compose.yaml` | `executor` (its image from the office's versions) and `opencode` (in the `container` profile, which `office up` enables in container mode). Ports are on `127.0.0.1` only |

The executable embeds `template/`, the built-in packages as offices get them (staged by `src/build.ts` in `target/packages/`, with the `office` plugin bundled), the licence, `image/` and `compose.yaml`. Docker can't read files inside it, so `office` unpacks `image/` and `compose.yaml` into `~/.cache/office/image-<hash of their content>/` and runs Docker from there; `office up` puts a copy of the executable in that folder for the image.

## Runtime

`office up` names the compose project `office-<name>` and sets:

| Variable | Value |
|---|---|
| `OFFICE_DIR` | The office, bind-mounted at `/home/office/workspace` |
| `OFFICE_STATE` | The office's runtime state: `office.yaml`'s `state`, else `~/.local/share/office/<name>` |
| `OFFICE_DESKS` | The desk names, for services such as a dashboard |
| `OFFICE_OPENCODE_IMAGE` | `office-opencode:<opencode>-claude<claude>-mise<mise>`, or `office-<name>-opencode:<the same>` when the office has a `Dockerfile`. The versions in the name keep offices on different versions from sharing an image |
| `OFFICE_EXECUTOR_IMAGE` | `ghcr.io/usefulsoftwareco/executor-selfhost:<version>@<digest>` |
| `OFFICE_OPENCODE_URL` | OpenCode as containers reach it: `http://opencode:4096`, or in host mode the configured URL with a loopback host replaced by `host.docker.internal`. The office's own services (a dashboard API) use it |
| `OFFICE_GIT_NAME`, `OFFICE_GIT_EMAIL` | `office.yaml`'s `git` identity, which the container's entrypoint makes git's default; empty without one |
| `OFFICE_GH_CONFIG`, `OFFICE_GH_HOSTS` | The host's gh configuration folder and the hosts it has accounts for, when the container shares the host's gh login (see "Git and GitHub") |
| `<NAMESPACE>_<SETTING>`, and each secret | Package settings and generated secrets (see "Services") |

Only the office's `opencode` container gets `OFFICE_CONTAINER=1`. Package plugins can use it to choose service-network addresses; host servers must leave it unset.

The state folder holds:

| Path | Holds |
|---|---|
| `secrets.env` | `OPENCODE_PASSWORD` for the OpenCode server. In container mode `office up` creates it; in host mode it is the host server's password, which you put there (see "Host mode") |
| `office-executor.env` | `EXECUTOR_TOKEN` and `EXECUTOR_ORGANIZATION`, the office's one Executor key, which `office setup` keeps (mode 600). The `opencode` container, `office apps deploy` from the host and the office's own services use it |
| `opencode-home/` | The container user's home: sessions, provider sign-ins, the Claude Code login, mise's tools |
| `cron-gitconfig` | Host mode with a `git` identity: the global git config the cron timers run with (yours, included, then the office's identity) |
| `applied.json` | The versions `office up` last applied, the highest OpenCode and Executor the office has run, and when the opencode image last took current Debian packages (`refreshed`) |
| `backups/` | What `office up --upgrade` saved before an upgrade: `<time>-executor-<version>.tar.gz` (Executor's data volume), `<time>-opencode-<version>/` (OpenCode's database files) and `<time>-package-<name>-<volume>.tar.gz` (a package's named volume) |
| `packages/` | Package services (see "Services"), private (mode 700): `<name>.env`, the package's generated secrets (mode 600), and `<name>/`, its applied `compose.yaml` with the `settings.env` and `include.yaml` `office up` writes beside it |

Executor keeps its database and keys in the `office-<name>_executor-data` volume.

| Address | Serves |
|---|---|
| `http://localhost:41440` | Executor's dashboard. Use exactly this address: it must match `BETTER_AUTH_URL` |
| `http://127.0.0.1:41497` | OpenCode, for the TUI or web UI (user `opencode`, password from `secrets.env`) |

Override the ports with `EXECUTOR_PORT` and `OPENCODE_PORT`. Executor runs with `EXECUTOR_APPS_ALLOW_PRIVATE_FETCH=true`, so app code can reach `http://opencode:4096` or the host's server; every app in that Executor shares this.

Executor apps reach OpenCode through `opencode.ts`, which reads the server's address, its credential host and the office's folder as the server sees it from the app's `office.ts`. The committed `office.ts` holds container mode's values; `office apps deploy` sends one for the current mode instead. The OpenCode account's label records the host it was connected for (`OpenCode (<name> office at <host>)`), because Executor sends the password only to the hosts an account was connected with; when the mode changes the host, `office apps deploy` connects a new account and links it to every app.

The `office` package's plugin connects sessions to Executor as the `office-executor` MCP server (`<address>/mcp?elicitation_mode=browser`, with the key as a bearer token and OAuth off). It takes the address and key from `OFFICE_EXECUTOR_URL` and `OFFICE_EXECUTOR_TOKEN`, which the container sets, else from the gitignored `.opencode/office-executor.url` and `.opencode/office-executor.token` (mode 600) that `office up` writes in either mode, with Executor's published loopback address (`http://localhost:41440`), and `office down` removes. In container mode the container's variables win, and the files let a host OpenCode session opened in the office reach the same Executor. It reads them each time OpenCode loads its MCP servers; without an address it registers nothing.

## Versions

`office.yaml` pins what runs in the office's containers; this tool only supplies the versions a new office starts at and the range it was tested with. These are separate from the `office` executable's own version, which `office update` changes (see "Updating").

```yaml
versions:
  opencode: 2.3.0
  claude: 2.1.322
  executor: 2.0.0-beta.49
  mise: 2026.11.7
  sfw: 1.16.0                # Socket Firewall; see "Socket Firewall"
upgrades:
  minimum_release_age: 1d    # for everything upgrade-tools bumps
  executor: 7d               # per tool, by name (one of the five, or a mise.toml tool)
```

- `office.lock`, written only by `office pin` and committed, holds the SHA-256 of each release file the image downloads (OpenCode's, Claude Code's, mise's and sfw's linux-x64 assets, as GitHub reports them) and Executor's image digest. sfw publishes no checksum file of its own, so its entry holds GitHub's digest of each file, recorded when pinned, and also `platforms`, the digests of the linux-x64, linux-arm64, darwin-x64 and darwin-arm64 files a host-mode office installs from. An `office.lock` from before sfw was pinned reads with the tool's default sfw, and `office sync` adds `sfw` to the `versions` block and its entry to the lock once. Change a version by hand, then run `office pin`. A lock that doesn't match `office.yaml` stops `office up --upgrade` and fails `office check`, naming `office pin`.
- An office without a `versions` block runs this tool's defaults; `office check` says so. Supercronic, the Debian base image and Bun stay pinned by the tool.
- `office up` runs what it last applied (`applied.json` in the state folder), so a bump the daily job records changes nothing until someone runs `office up --upgrade`. That prints the changes, refuses an older OpenCode or Executor than the office has run (their data only migrates forward), stops what changes and backs it up into `backups/`, builds and starts the new versions, and after an Executor upgrade runs `office apps deploy` so every app matches its `apps` framework.
- `office check` warns, without failing, when a version is outside the range this tool was tested with, and when an upgrade is pending.
- Debian's packages are not pinned, and in container mode a weekly timer refreshes them; see "Image refresh".
- In host mode the pins apply to Executor and, while `socket_firewall` is on, sfw. The managed-host cron job updates the host's agent CLIs through their native launchers. An unmanaged host updates its own CLIs. `office check` notes the host's OpenCode version and the tested range if different; that is not a warning.

## Host mode

1. Put the host server's password in the state folder. For the OpenCode background service:

   ```sh
   mkdir -p <state> && (umask 077; echo "OPENCODE_PASSWORD=$(opencode service get password)" >> <state>/secrets.env)
   ```

2. `office setup` once, which asks whether the office may manage this machine (see "Machine"); `--manage-machine` says yes unattended. Or, for an office set up before host mode, `office setup --manage-machine` then `office sync`.
3. `office up`. It starts `executor` and the office's own services, removes an `opencode` container left from container mode, writes the MCP files above, installs Socket Firewall (see "Socket Firewall"), runs `mise trust` and `mise install` (through sfw) for the root's and each desk's `mise.toml`, then `mise install` from `/` for the office's machine-wide tools (`machine.packages.toml`, `.office/mise/` and `machine.toml`, through their links; it says what to run when there are none), and installs the cron timers.
4. `office apps deploy`, so the apps reach the host's server, then `office check`.
5. Accept the shell startup update during host setup, or follow the printed instructions. Open a new terminal to load the changes (see "Socket Firewall").

Containers reach a server on the host's loopback through `host.docker.internal`; with Docker Desktop on WSL that reaches a server listening on `127.0.0.1` in WSL, so nothing listens on another address. Sessions start at the office's own path, so the host server also loads its global configuration and every `AGENTS.md` from the office up to your home folder; the container's machine note exists only in container mode.

### Managed OpenCode (optional, Linux with systemd)

```yaml
opencode:
  mode: host
  url: http://127.0.0.1:49374
  managed: true
  env_commands:
    GITHUB_MCP_TOKEN: gh auth token
secrets:
  server: secrets/server.enc.yaml
```

Use the same loopback address as OpenCode's background service (`opencode service get port`; the default is 49374). Leave its password in OpenCode's service settings and put the same password in `<state>/secrets.env` as above. The service registration and the session database stay where OpenCode keeps them. Leave OpenCode's background service enabled in its own settings (`disabled` makes interactive clients use a separate server), and do not set `opencode service set env` variables: OpenCode gives those precedence over the unit. If `managed` is omitted or false, the office attaches as before and leaves your server alone.

With machine-management consent and after `office sync`, `office up` writes and enables `office-<name>-opencode.service`. It uses `~/.opencode/bin/opencode` if installed there, otherwise the executable on PATH. It sources the office's `env.sh` so agents get the same Socket Firewall wrappers, package settings and release ages as the terminal. The unit itself never installs or upgrades OpenCode or Claude Code.

For LAN access, add `listen_host: 0.0.0.0` beside `managed: true`, keeping `url: http://127.0.0.1:49374`. Only the managed OpenCode listener binds all IPv4 interfaces; local clients still use loopback and containers still use `host.docker.internal`. From another device connect to `http://<host-LAN-IP>:49374` with the service credentials. On WSL the Windows network must also route or forward the port to WSL. Removing `listen_host` restores the loopback default. Apply a listener change from a separate terminal with `office up --upgrade`.

The required `office` package schedules `package.office.update-agent-clis` at **07:30 UTC daily** only in managed host mode. It runs `claude update`, `codex update` and the recorded Socket Firewall's `sfw opencode upgrade` independently. Install the native launchers first: `~/.local/bin/claude`, the [Codex standalone installer](https://developers.openai.com/codex/cli/) at `~/.local/bin/codex`, and `~/.opencode/bin/opencode`. Neither `office init` nor `office setup` installs them on the host. A missing launcher fails its own update; the job still attempts the others. The job refuses to upgrade OpenCode without a verified office-installed firewall. These native updates use the vendors' release channels, not YAML pins or the ordinary dependency minimum age. `env.sh` disables Claude Code and OpenCode background auto-updates with `DISABLE_AUTOUPDATER=1` and `OPENCODE_DISABLE_AUTOUPDATE=1` for terminals that source it and for the managed unit; it does not configure independently launched clients.

The container installs Codex from the full Linux package at `versions.codex`, verifying its checksum from `office.lock`. Existing offices without a Codex pin start at the CLI's default; `upgrade-tools` writes the explicit pin on the first bump. To take a stable release immediately, set `versions.codex`, run `office pin`, then apply it with `office up --upgrade`.

To run the same job on demand, use `office cron run package.office.update-agent-clis` from a separate terminal, not from a terminal owned by the managed server. To reschedule or disable it, add a `packages:` entry such as `- { name: office, cron: { update-agent-clis: { schedule: '15 9 * * *', enabled: false } } }` and run `office up`. Disabling the job leaves the shared auto-update policy in place.

Only an OpenCode version mismatch or a verified client takeover triggers reconciliation; a Claude-only change leaves the server alone. The updater verifies the registered version and systemd PID after a restart. Session records persist, but an active prompt or persistent terminal can be interrupted. A connected client using automatic discovery can compete to start a server; the updater attempts at most one verified takeover and reports a failure if it cannot reclaim the address safely. An explicitly attached client (`opencode --server <managed URL>`, with its normal password environment) does not start a competitor. Check the timer's service journal if a run fails.

- **Start and check.** Plain `office up` starts a stopped service and leaves a healthy one running. `office down` stops the cron timer and managed service and prevents the installed unit from starting again before `office up`. If the unit, `env.sh` or encrypted secrets have changed, `up` reports a pending restart. `office check` compares the unit to what the office would write, reports whether it is enabled and active, verifies that the server PID is the unit's PID, and checks encrypted secrets.
- **Take over.** Plain `office up` refuses if a registered service is running outside the unit or the old `opencode-serve.service` is active. Disable any old supervisor and its restart timer yourself: the office does not disable or delete units it didn't write. `office up --upgrade` takes over the verified local OpenCode background service; another listener must be stopped by its owner. Restart is queued in systemd, so it finishes even when called from an OpenCode session that is disconnected. Saved sessions survive; open terminals and in-flight work may not.
- **Recover after an OpenCode client restart or upgrade.** A TUI or desktop client may replace the server outside the unit and that replacement won't get office settings or secrets. `office check` detects it; `office up --upgrade` returns ownership to systemd. Use the same OpenCode version for the server and clients. Use `office down`, not `opencode service stop`, to stop the unit; systemd may restart a process stopped from outside. Remove `managed` and its associated `env_commands` and `secrets.server`, then `office sync` to stop, disable and remove the unit, or run `office sync --release-machine` to release all machine files. Use a separate terminal when removing a running unit.

`opencode.env_commands` is optional. Each command runs through `/bin/sh` in the office root before secrets are decrypted. The office's absolute gh is used for direct `gh` calls when available. Trimmed stdout becomes the variable. On failure the variable is left unset and the journal names the variable, not either output stream, so a logged-out gh need not keep OpenCode down. Put commands here, not literal credentials.

## Socket Firewall

[Socket Firewall](https://github.com/SocketDev/sfw-free) (`sfw`) runs a package manager behind a local proxy that refuses packages Socket has confirmed as malicious, at any depth of the dependency tree. Every office uses it unless `office.yaml` says otherwise:

```yaml
socket_firewall: true     # false turns it off in both modes
```

- **Wrappers.** `npm`, `npx`, `pnpm`, `pip`, `pip3`, `uv`, `uvx` and `cargo` are links to one script in a folder first on PATH. It drops its folder from PATH, so sfw finds the real command, and runs `sfw <command>`; a nested call (an npm script running npm) reaches the real command behind the same proxy, and `OFFICE_BEHIND_SFW=1` keeps a wrapper reached again from starting a second sfw. The folder's `mise` runs `mise install`, `use` and `upgrade` behind sfw, `reshim` without the folder (so mise points its shims at the real mise) and anything else as the real mise under the name it was called by, which mise's shims and `mise activate` rely on. Wrappers, not aliases, so agents' non-interactive shells are covered too. `src/sfw.ts` is the one list.
- **Release ages.** `NPM_CONFIG_MIN_RELEASE_AGE=3`, `pnpm_config_minimum_release_age=4320`, `UV_EXCLUDE_NEWER="3 days"` and `PIP_UPLOADED_PRIOR_TO=P3D` make package managers take only releases at least three days old, with the firewall on or off. npm older than about 11.10 ignores its variable with a warning (11.6.2 does, 11.20.0 doesn't), and uv before relative durations rejects `3 days` (0.9.5 fails, 0.13.8 works): pin current ones.
- **A refusal** fails the command and ends with:

  ```
  === Socket Firewall ===
   - blocked npm package: name: safe-chain-test; version: 0.0.1-security; reason: malware (critical) - https://socket.dev/npm/package/safe-chain-test/alerts/0.0.1-security
  ```

  sfw Free blocks only confirmed malware; AI-flagged packages get a warning. It can't block what a package manager takes from its cache, and it needs the network. `SFW_VERBOSE=true` prints its banner, `Protected by Socket Firewall`.
- **The environment file** holds the wrappers' place on PATH and the release ages, as POSIX shell for `sh`, `bash` and `zsh`: it moves each of its PATH entries to the front rather than adding it twice, so sourcing it again changes nothing; it prints nothing and runs no program. A script that runs a mise-managed tool many times runs faster under `mise exec -- <script>`, which keeps the wrappers first.

**Container mode.** The image downloads sfw at the pinned version and checksum and writes the wrappers into `/usr/local/lib/office/sfw/bin`. At start the entrypoint writes `/etc/opencode/env.sh` from `office.yaml` (`office env --container` prints it) and sources it, so OpenCode, its agents' commands, the cron jobs and the entrypoint's own `mise install` run with it; `office exec`, `office shell` and interactive bash source it too. A new sfw pin reaches the container with `office up --upgrade`, which rebuilds the image.

**Host mode.** With the user's consent (see "Machine"), the office writes, in its own data folder (`$XDG_DATA_HOME/office`, `~/.local/share/office`):

| Path | Written by | Holds |
|---|---|---|
| `env.sh` | `office sync` | PATH: the wrappers (while the firewall is on), mise's shims, OpenCode's `~/.opencode/bin`, then the folders packages declare; the release ages, then the variables packages declare |
| `sfw/package-manager.sh`, `sfw/bin/*` | `office sync`, while the firewall is on | The wrappers. `sfw/bin/mise` runs the first mise program on PATH outside the wrappers and mise's shims (skipping a script wrapper such as a hand-made `mise-guard`), else office's own copy in host-tools |
| `sfw/sfw` | `office up`, while the firewall is on | Socket Firewall at the applied version, downloaded from GitHub for this platform, checked against `office.lock`'s digest and its own `--version` |

Each is a file in the machine record, with the usual rules: `office check` has a line per file (sfw's names the installed version against the applied and pinned ones), turning the firewall off removes `sfw/`, and leaving host mode or `office sync --release-machine` removes everything. These names carry no office name: the folder is the tool's own, a machine has one host-mode office, and your startup file names one stable path. Until `office up` has installed sfw, the wrappers refuse to run downloads rather than run them unchecked. `office up` installs sfw before the office's tools, whose `mise install` it runs through the mise wrapper.

Host `office setup` offers to update the detected shell's interactive startup file (`~/.bashrc`, or `.zshrc` in `$ZDOTDIR` or home). It checks for existing mise activation and office environment lines, including literal sourced files. With your confirmation it adds missing activation before the office environment, so the wrappers stay ahead of mise's tool folders. For manual setup, put this after `mise activate`:

```sh
[ -r "$HOME/.local/share/office/env.sh" ] && . "$HOME/.local/share/office/env.sh"
```

`office check` says, as a note, whether your shell has it: the current shell has sourced it (`OFFICE_ENV_FILE`), or a startup file (`.zshenv`, `.zprofile`, `.zshrc`, `.zlogin` in `$ZDOTDIR` or home; `.bashrc`, `.bash_profile`, `.profile`), read through its link, as a dotfiles repository keeps it, or a file one of them sources, names the file. A line built at run time isn't seen.

The OpenCode server doesn't read your startup files, so on a host its agents' commands get the environment only once the server's own environment sources the file: the office-owned server unit (a later step) will. Until then, put the wrappers' folder first on the `PATH` of the unit you run the server with yourself.

## Cron

Declare office-owned jobs by name in `office.yaml`:

```yaml
cron:
  daily-report:
    schedule: '0 6 * * *'
    script: cron/daily-report.sh
```

Schedules are five-field UTC cron expressions or time macros such as `@daily`. The script must be a regular `.sh` file relative to its declaring office or package, with no symlinks. All jobs run under `/bin/sh` from the office root. `office cron list` shows IDs such as `office.daily-report` and `package.office.update-references`; use `office cron run <job-id>` to run one directly in the execution environment you intend. Keep the job name when renaming its script: the ID tracks the job across renames.

A package's `package.yaml` uses the same `cron:` mapping. A package job may also set `when: host`, `when: managed-host`, or `when: container`; omitting `when` makes it applicable in both modes. An office may change a package's schedule or disable a job under that package entry's `cron:` (alongside `settings`), for example:

```yaml
packages:
  - name: example
    cron:
      report: { schedule: '15 9 * * *', enabled: false }
```

Only `schedule` and `enabled` can be overridden; `enabled: true` cannot override `when`. Unknown job names are configuration errors. The implicit `office` package accepts one optional entry for cron overrides only; removing that entry restores its defaults. Run `office sync` to update installed package copies, then `office up` to apply schedule changes. Convert any old `cron/crontab` entries to named YAML jobs and remove that file; it is no longer read.

In host mode, `office up` installs systemd user timers named `office-<name>-cron-<job-id>.timer` with UTC `OnCalendar` and `Persistent=true`. An existing timer catches up once after a missed interval; a timer enabled for the first time waits for its first scheduled time. A host schedule cannot restrict both the day of the month and weekday. `office down` removes the generated units and stops their running cron services. The next `office up` reinstalls enabled jobs; it also removes obsolete units written by earlier releases.

In container mode, the entrypoint generates the supercronic input in UTC. It first runs each due job once, including jobs with no successful run. Successful executions leave a stamp per qualified job ID under `$XDG_STATE_HOME/office/cron/<office>` (by default `~/.local/state/office/cron/<office>` in the home volume). `office up` recreates the container when its generated schedule changes.

The required `office` package supplies these daily jobs in both modes (plus `package.office.update-agent-clis` on managed hosts):

- `package.office.update-references` (06:00 UTC): `office sync --references`.
- `package.office.upgrade-tools` (06:30 UTC): `office upgrade-tools`.
  - For each exact pin in the root's and each desk's `mise.toml`, `machine.toml` and `machine.packages.toml` (never a clone's), it asks `mise latest <tool> --minimum-release-age <age>` for the newest version at least that old and installs it; only after the install succeeds does it rewrite the pin, keeping the rest of the line (`machine.packages.toml`'s package comment included), and a failed install keeps the old one.
  - For the five versions in `office.yaml`, it reads each project's newest hundred GitHub releases without a login, keeps the line the office runs (`v<semver>` tags for OpenCode, Claude Code, mise and sfw; Executor's `executor@2.…` pre-releases, not its v1 line), drops releases younger than the age, and takes the highest version, never a lower one than the pin. It confirms the release file, or Executor's image on ghcr.io, exists, then rewrites only those version lines in `office.yaml` and `office.lock`. A failed lookup (GitHub's rate limit, no network) skips that tool and is reported. It never rebuilds or restarts anything.
  - Ages come from `upgrades` in `office.yaml`: a tool's own, else `minimum_release_age`, else a day; sfw, in the path of every package download, waits at least three days unless it has its own.
  - It skips a file with uncommitted changes (for the versions, `office.yaml` or `office.lock`). Changed files (and a `mise.lock` beside them, if the office uses one) go into one commit, such as `chore: bump opencode 2.3.0 → 2.4.0, node 26.13.1 → 26.14.0`, made as the office's git identity from `office.yaml`, else `office cron <office-cron@localhost>`, through `git -c`, so no git config changes. It never pushes, even when the office has GitHub credentials. It notifies the app of the first desk that has one (`notifications.send`) of what moved or failed, stays silent when nothing changed, and exits non-zero on a failure, so the job counts as missed and runs again at the next start.

## Image refresh

The base image pins Debian by digest, so its packages, Chromium among them, only get security fixes when the image's apt layer is rebuilt. Docker reuses that layer while its inputs stay the same, so `office up` passes the time of the office's last refresh (`refreshed` in `applied.json`) as the `APT_REFRESH` build argument. `office up --refresh` records a new time, which rebuilds the layer with `apt-get upgrade` and current packages, rebuilds the office's own `Dockerfile` on top, and restarts the `opencode` container on the versions last applied; it never applies `office.yaml`'s newer ones. Any other `office up` keeps the last refresh's packages, so a rebuild never falls back to older ones. It notifies the app of the first desk that has one with the Chromium version it moved to, or why it failed.

The container can't rebuild itself, as it has no Docker socket, so in container mode `office up` installs a systemd user timer on the host, `office-<name>-refresh-image.timer`, which runs `office up --refresh` on Sundays at 07:00 UTC with `Persistent=true`, the PATH and the `*_PORT` variables `office up` ran with. OpenCode resumes a session whose turn the restart interrupted; a shell command it was running is lost. On a machine without a systemd user manager, `office up` says so and `office check` warns; run `office up --refresh` yourself. `office check` warns when the last refresh is more than eight days old.

## Copied skills

`skills.copied` copies skills from other repositories into the library, `skills/<name>/`, where `skills.enabled` and each desk's `skills` enable them as they do the office's own; copying a skill doesn't enable it. Commit the copies. Skills that come from one repository are listed as a group at one pinned ref:

```yaml
skills:
  enabled: [alpha]
  copied:
    - repo: https://github.com/example/agent-skills.git
      ref: 0123456789abcdef0123456789abcdef01234567   # what sync copies; office skills update moves it
      track: 'v2.*'        # optional: a branch such as main, or a pattern of stable SemVer tags
      base: skills         # optional: the folder skill paths are relative to (the repository root by default)
      skills:
        - alpha                                   # skills/alpha, copied to skills/alpha/
        - { name: beta-review, path: review/beta } # skills/review/beta, copied to skills/beta-review/
    # One skill listed alone, as offices did before groups: copied once, never replaced.
    - { name: solo, repo: https://github.com/example/other.git, ref: main, path: skills/solo }
```

- `office sync` copies each skill that is missing, and recopies a group's copy whose `.source.json` names another source or ref, so a `ref` you change by hand takes effect. It never moves a pin. A copy that would be replaced must be unchanged since it was copied, or sync leaves the whole group and reports it; a copy already at the pin stays as it is, edited or not.
- `office skills update` advances only groups with a `track`. A branch resolves to its newest commit. A pattern with `*` matches tag names; of the tags whose name ends in a stable version (`MAJOR.MINOR.PATCH`, no prerelease or build suffix), it takes the highest version, compared as numbers, not the newest push: `v2.*` takes `v2.10.0` over `v2.9.0` and never matches `v20.0.0`, `v3.0.0` or `v2.11.0-rc.1`. Tags are read with `git ls-remote`, so any Git host works and no GitHub release is involved. It resolves each group once, stages every copy the group needs from that one commit, and only then records the full SHA in `office.yaml` (editing that one value, keeping comments and layout) and swaps the copies in. It reports the tag or branch it chose; a group with no matching tag, a skill missing at the new commit, or edits a copy would lose keeps its pin and every copy.
- Each copy's `.source.json` records the repository, path, ref, commit and the SHA-256 of each file, which is how edits are found. A copy made before the hashes were recorded is compared with its recorded commit instead.

## Packages

A package is a capability an office opts into, where the tool itself holds only what every office needs to run. It is a folder of the same shape, whatever its kind:

```
<name>/
  package.yaml          # name, description, and the settings it accepts
  plugin/               # its OpenCode plugin: everything the package gives OpenCode
  skills/<id>/SKILL.md  # skills the plugin registers
  scripts/              # package-owned, for tooling and CI
  template/             # each file copied once into the office root at the same path, then the office's
  gui/                  # a desktop app panel: src/, package.json (build dependencies), dist/gui-experimental.cjs (built, committed)
  compose.yaml          # services it adds to the office's compose project
```

There are three kinds, by where a package comes from:

| Kind | Comes from | `office.yaml` entry | Lives in the office at | Editable |
|---|---|---|---|---|
| Built-in | Shipped inside the `office` executable | `- name: knowledge` | `.office/packages/<name>/` | No |
| Remote | Another repository | `name` with `repo`, `path` and `ref` | `.office/packages/<name>/` | No |
| Local | Written in the office | `- name: mine` | `packages/<name>/` | Yes |

- An entry without `repo` is built-in when this tool ships a package of that name, and the office's own otherwise; a local package can't use a built-in's name. The built-in packages are this repository's `packages/`: `office`, `knowledge`, `artifact-share`, `design` and `browser`.
- `office` is required: every office has it without an entry, and an optional entry may only configure its one setting (below) and cron. It holds what every office needs from OpenCode, given by its plugin: the guidance for a session's folder (which `office instructions` prints), the `office` skill and the `office-executor` MCP server (see "Runtime"). `knowledge`, `artifact-share`, `design` and `browser` are optional.
- A built-in package follows the `office` executable: `office sync` replaces the office's copy whenever it differs from the executable's. An entry naming a built-in with a `repo` other than this tool's repository is an error: a built-in can't be pinned or forked under its own name.
- A remote package moves when its `ref` changes: a tag, a branch or a full 40-character commit SHA (git can't fetch an abbreviated one). With `track` (a branch, or a tag pattern such as `v1.*`, resolved as "Copied skills" describes), `office packages update` moves `ref` to the full SHA it resolves and applies the package; `office sync` installs whatever `ref` pins and never moves it.
- Every kind is committed with the office, so a clone and CI work with nothing fetched. A built-in package's `test/` stays in this repository, which runs it with `pnpm test`.

`.office/packages/` is a dot-folder, so searches and a plain `ls` skip what the office pulled in; `packages/` holds only the office's own packages. A pulled-in package is read-only: its `.source.json` records the SHA-256 of each file as installed (and, for a remote package, the repository, path, ref and commit), `office check` fails when a file differs from the record (edited, added or removed), and `office sync` restores the copy, from the executable for a built-in and by copying the recorded ref again for a remote package. To change a package, copy it into `packages/` under a name of your own and list that instead.

`package.yaml` holds only what can't be discovered:

```yaml
name: artifact-share
description: What it does
settings:
  url:
    description: What the setting means
    required: true     # or `default: <value>`
namespace: share       # optional, for a package with services: what they're named after; see "Services"
secrets:               # generated once, for a package with services; see "Services"
tools:                 # mise tools it needs, at the exact version it was tested with; see "Tools"
  "npm:agent-browser": "0.43.0"
```

For structured settings, declare `settings_schema` **instead of** `settings` in `package.yaml`. This is a synchronous JSON Schema (draft 2020-12), written in YAML, for the entire settings mapping. For example:

```yaml
settings_schema:
  type: object
  additionalProperties: false
  properties:
    enabled: { type: boolean, default: true }
    reviewers: { type: array, items: { type: string }, minItems: 1 }
```

`office sync` and `office check` validate the settings. Property defaults fill missing values; input types are not coerced. Use `$defs` and local `$ref`s for reuse; schemas are not fetched from the network. `format` is an annotation. Lists, nested objects and null stay in `.settings.json`; only top-level scalar strings, numbers and booleans reach a service's settings environment.

`office.yaml` lists the packages, each with its settings:

```yaml
packages:
  - name: knowledge              # built-in
  - name: artifact-share         # built-in, with a setting
    settings:
      url: https://example.github.io/my-office
  - name: reports                # remote
    repo: https://github.com/example/office-packages.git
    path: packages/reports
    ref: <commit or tag>
    track: 'v1.*'                # optional: what office packages update moves ref along
  - name: something-local        # this office's own, in packages/something-local/
```

For each package, `office sync`:

1. Installs a built-in package from the executable, or copies a remote one at `ref`, with the repository's licence when the folder has none, into `.office/packages/<name>/`, and writes its `.source.json`. It replaces a built-in copy that differs from the executable's, a remote copy whose record differs from the entry's repository, path or ref, and any pulled-in copy whose files were edited, saying which.
2. Copies each file under `template/` to the same path in the office once, and says what it created; a file already there is kept and counted as handled. The package's `.template.json` records the handled paths, kept across updates, so a file the office deletes stays deleted and an update creates only files a newer version adds. It never overwrites: from then on the file is the office's.
3. Writes the settings, with defaults applied, to the package's `.settings.json`. A setting the package doesn't declare, or a required one left out, is an error naming the field. Settings are not secrets: the file is committed, so the plugin, scripts and a workflow all read it. Beside it, `.office.json` holds what the office declares to every package, apart from its settings so no setting name can collide: `{ "opencode": "host" }` or `"container"`, `office.yaml`'s mode (see "Modes").
4. Writes the mise tools it declares into `machine.packages.toml`, and its mise setup (in a host-mode office its host install, and its system setup where it applies) into `.office/mise/<name>.toml` (see "Tools").
5. Links its `plugin/` as `.opencode/plugins/<name>` (a relative link, committed), which OpenCode loads for the root and every desk without an entry in `opencode.jsonc`. A package whose name is a `plugins:` entry, or a plugin folder of the office's own in `.opencode/plugins/`, is an error, and its plugin isn't linked (package names are unique in `office.yaml`, so two packages can't meet there). When the entry leaves `office.yaml`, sync removes the link and the plugin stops loading.

A package's plugin is the one way it reaches OpenCode: OpenCode loads each package's plugin itself, nothing else of a package is linked into `.opencode/`, and `package.yaml` declares nothing OpenCode loads. The plugin registers the package's skills with `ctx.skill.transform`, as `artifact-share` does for `skills/share-artifact/`, and its MCP servers with `ctx.mcp.transform`, as `office` does for `office-executor`; tools, hooks and instructions come from the plugin too. `office check` fails a package that has `skills/` but no plugin, since nothing loads them.

A plugin runs with nothing installed: there is no `node_modules` beside it. It imports only what the runtime provides (Node's and Bun's built-ins, and the `@opencode/plugin` and `effect` modules OpenCode gives every plugin), or ships its own bundle, as the `office` package does: its `plugin/` in an office holds one `index.js` built with what it imports. OpenCode loads `plugin/server.ts`, else `plugin/index.ts` (or `.js`), or the entry exported by a `package.json` there that has `name` and `exports`, and reloads a plugin when a file it imports inside `plugin/` changes.

OpenCode loads the plugin through the link and resolves its relative imports from there, so a plugin can't import a file outside `plugin/` (`../.settings.json` fails to load), and its own path may be the link's or the package folder's. It finds its package folder with `realpathSync` on its own folder, and the office by walking up to `office.yaml`, never by a fixed number of folders. A plugin that uses its settings reads `.settings.json` from its package folder itself, when it needs them (in a hook or transform), so it sees the values the next `office sync` writes; one that depends on the office's mode reads `.office.json` the same way, never the environment it runs in.

To uninstall a built-in or remote package, delete its entry from `office.yaml` and run `office sync`. It unlinks the plugin, deletes each file `.template.json` lists that is still byte-identical to the package's `template/` copy (and the folders that leaves empty), keeps and names each one the office changed, and removes `.office/packages/<name>/`. Files the office created itself, such as `artifacts/<name>/` beside a template's `artifacts/README.md`, are never touched. Commit what it changed; `git restore` brings it back. A local package stays until you delete its folder.

`.source.json`, `.settings.json`, `.office.json` and `.template.json` are the office's records, so they are left out of the file hashes. `office check` reports a folder in `packages/` that `office.yaml` doesn't list (sync never removes one) and one that has a built-in's name, and a folder in `.office/packages/` that no entry wants, which sync removes.

There is no registry, no dependency between packages and no version range. The built-in packages:

| Package | Does |
|---|---|
| `office` | Every office has it: folder guidance, the `office-executor` MCP server, and the `office`, `office-package-creator`, `openai-skill-creator`, `opencode-sessions` and `opencode-plugin` skills |
| [`knowledge`](packages/knowledge/README.md) | Lists the office's `knowledge/` articles, with their descriptions, in every session, refreshed on each prompt. `office init` adds it |
| [`artifact-share`](packages/artifact-share/README.md) | The user asks an agent to share something; it goes in the office's `artifacts/`, which a workflow publishes as a GitHub Pages site with an index page. The site may be public, even for a private repository |
| [`design`](packages/design/README.md) | The office runs its own [Doop](https://github.com/kgoedecke/doop) design canvas as package services, and every session reaches it as the `doop` MCP server, with an agent key a person creates once |
| [`browser`](packages/browser/README.md) | Browser automation: agent-browser (a mise tool the package declares) drives a headless Chromium in either mode, and in a host-mode office Browse drives the user's own Chrome, installed once and self-updating; each an MCP server where it applies, with a skill saying which to use when. `office init` adds it |

The `office` package has two settings for skills outside the office that its sessions shouldn't get: `ignore_claude_synced_skills`, on by default, and `ignore_skill_folders`, a list of more folders. OpenCode loads every skill under `~/.config/opencode/skills`, `~/.claude/skills` and `~/.agents/skills` into every session, and its permission rules can only deny a skill by ID, so a folder another program fills, such as the one the Claude desktop app syncs account skills into, has no switch of its own. These are one. `ignore_claude_synced_skills` covers that folder, `~/.claude/skills/synced`, and is on in every office without setting anything; `false` lets those skills load. `ignore_skill_folders` adds folders of your own and never replaces it:

```yaml
packages:
  - name: office
    settings:
      ignore_skill_folders:
        - ~/.agents/skills/unwanted
      # ignore_claude_synced_skills: false   # to load the Claude app's synced skills
```

Each folder is an absolute path, one starting with `~` (the home of the server the sessions run on: the container's in container mode), or one relative to the office root; a folder that doesn't exist hides nothing. After `office sync`, the package's plugin removes every loaded skill whose file is inside one of them, at any depth, from the root's and every desk's sessions, while skills beside the folder still load. Nothing lists skill IDs: OpenCode reloads its skills when a folder changes and the plugin removes them again on each load, so a skill added to the folder later never appears, and removing a folder from the settings brings its skills back on the next sync, without a restart either way. A removed skill is gone from the server's skill list for the office's folders, so it is neither offered to the model nor loadable by ID there; sessions outside the office are unaffected.

One case is left alone: a skill in an ignored folder with the ID of a skill one of the office's packages provides. OpenCode had already replaced the package's skill with the outside one, so removing it would leave neither; it stays, loaded from the ignored folder, until one of the two is renamed. A library skill of the office (`skills/<id>/`) needs no such care: it loads after the outside one and wins.

### Tools

`machine.toml`, `machine.packages.toml` and `.office/mise/` are machine-wide; every `mise.toml` is folder-scoped:

| File | Applies | Who changes it |
|---|---|---|
| `machine.toml` at the office root | The whole machine | The office, freely: tools, versions and mise settings. Sync never rewrites it |
| `machine.packages.toml` at the office root | The whole machine | Sync adds and removes tools as packages declare them, and writes each line's comment; the versions are the office's (`office upgrade-tools` bumps them; sync only raises one below what a package needs) |
| `.office/mise/<package>.toml` | The whole machine | Sync alone: a package's mise setup (host install, system setup), rewritten on every sync |
| `mise.toml` at the office root | The office folder | The office: what the office repository itself needs |
| `<desk>/mise.toml` | That desk | The desk |
| A repository's `mise.toml` | That repository | The project |

`.office/` is the tool's; what you edit is at the root. Each file's header comment says which kind it is, `machine.toml`'s and `machine.packages.toml`'s each name the other, and `machine.toml`'s and the root `mise.toml`'s too. `office init` writes a starter `machine.toml`; `office sync` writes `machine.packages.toml`.

mise loads none of `machine.toml`, `machine.packages.toml` or `.office/mise/` where they are (it reads `mise.toml`, `mise.<env>.toml` and a few other names in a folder, not these), so the machine-wide files apply only through links in mise's global conf.d: in a host-mode office `office sync` makes them, once you agreed in `office setup` (see "Machine"), and the container makes them inside itself at start. Without the links the files apply nowhere, so `office check` fails in a host-mode office without consent. Through the links they are global config, in every folder alike, the office's included: `machine.toml` wins over `machine.packages.toml` everywhere, and a `mise.toml` (the office's, a desk's, a project's) wins over both in its folder, as project config wins over global. mise does load `mise/config.toml` and `mise.toml` in place below `.office/`, so `config` and `mise`, like `machine`, are reserved package names.

A package that needs a CLI declares it as a mise tool in `package.yaml`'s `tools`, by the name a `mise.toml` gives it, at the exact version it was tested with (never a range or `latest`). That version is where an office starts and a floor it shouldn't go below; newer versions are the office's choice. `office sync` writes every package's tools into one file, `machine.packages.toml` at the office root, which the office commits: a `[tools]` table with one line per tool, each with a comment naming the packages that declare it:

```toml
[tools]
"sops" = "3.13.3" # office
"npm:agent-browser" = "0.43.0" # browser
"bun" = "1.4.4" # browser, shell
```

- A tool the file lacks is added at the highest version its packages declare.
- A version at or above every package's stays as it is: from then on the pin is the office's. `office upgrade-tools` bumps it as it does `mise.toml`'s, with the same minimum release ages and keeping the line's comment, and the container installs it at start (in host mode, `office up` does). A `mise.lock` in the office doesn't cover it, as it is global config.
- A version below a package's (after that package was updated) is raised to it, and sync says so, naming the tool, the package and both versions.
- A tool no package declares any more is removed. A package office.yaml lists but that doesn't read keeps its lines until it does.
- Versions compare like SemVer: release numbers part by part, a prerelease before its release, build metadata ignored, an optional `v` ignored. A version office can't order that way, such as `latest` or a range you wrote, is never raised: sync keeps the office's line, and `office check` notes it.
- The header comment and each line's comment are sync's, rewritten as the current release words them.

To hold a tool back below a package's version, pin it in `machine.toml`, which wins: sync leaves `machine.packages.toml`'s line alone, and `office check` warns (without failing) that the package runs an older version than it was tested with, naming the tool, the package and both versions. There is no maximum: a package can't cap a tool's version.

A package's mise setup, when it has one, goes in its own fragment, `.office/mise/<name>.toml`, which the office commits but never edits: sync writes it whole and rewrites it on every sync, and deletes it when the package has no setup in this office or leaves `office.yaml`. The file's first line names the package; sync never touches a file in that folder whose first line doesn't name one of its packages, refuses to write a package's setup over such a file, and links only its own (`office check` reports any other file there: move its tools to `machine.toml`).

A package can also give a host-mode office something more, in `package.yaml`'s `host` block, optionally behind one of its true/false settings:

```yaml
host:
  setting: browse                      # only while this setting is true
  tools:                               # more mise tools, as in tools
    bun: "1.4.4"
  install:                             # a file outside the office, installed once
    description: Browse
    creates: ~/.local/bin/browse
    script: scripts/install-browse.ts  # a Bun script in the package
    executable: true                   # the default; false when creates is a regular file, such as a script a shell sources
  path:                                # folders for PATH in the environment file (browser declares none)
    - bin                              # ~/… in the home folder, /… absolute, else in the package
  env:                                 # plain variables for the environment file
    EXAMPLE_MODE: quiet                # one line of text, never expanded
```

`path` and `env` go into the office's environment file (see "Socket Firewall"), after the office's own entries, while the host block applies. They are data, never shell code: a folder holds only letters, digits and `. _ @ + -` (no `:`, `$` or spaces, and no `..`), a value is one line written single-quoted, so `$HOME` or a backtick in it stays as written, and `PATH`, `HOME`, the shell's own variables, the release-age variables and `OFFICE_*` are refused. A variable two packages both set is left out, and `office sync` reports it.

When the office is in host mode and the setting is on, sync adds `host.tools` to `machine.packages.toml` and writes the package's fragment with a `[hooks]` `postinstall` that runs the script when `creates` is missing (`test -x`, or `test -f` with `executable: false`), and a `<package>:install` task that runs it unconditionally. Both are inline commands with the office's tools on PATH (a task hook would run untrusted). mise runs a linked file's hooks and tasks from whatever folder it runs in, so neither uses a path relative to the office: each finds the office root from the fragment's own real path, `{{ config_source | canonicalize | dirname }}/../..`, which the hook uses directly and the task through a task-level `env = { OFFICE_ROOT = … }` (mise gives `config_source` to neither a task's `run` nor its `dir`). So both work from any folder. mise runs `postinstall` after every `mise install`, anywhere once the fragment is linked, so the file is installed the first time and left alone after. When the mode or the setting changes, sync removes the host tools from `machine.packages.toml` and the hook and task from the fragment, never the other versions. A linked fragment is global config, which mise trusts, so its hook needs no `mise trust`. `office check` says on the package's line when the setting is on in a container-mode office (not a failure), and in host mode fails when `creates` is missing or, by the same test as the hook, isn't an executable (or regular) file, naming `office up` and the task. An executable install is expected to update itself, as Browse does; a regular file stays as installed until the task runs again.

`office check` reports, on the package's line, a declared tool missing from `machine.packages.toml` or below the package's version, and a fragment that differs from what sync writes; and once for the office, a tool no package declares any more. A version the office raised is not a problem.

A package can also offer a one-time setup of the machine with its operating system's package manager, in `package.yaml`'s `system` block, behind one of its settings whose default is false, so an office opts in:

```yaml
system:
  setting: system_chrome                  # a setting whose default is false
  description: Google Chrome Stable from Google's apt repository, for agent-browser
  platforms: [ubuntu-24.04-amd64-wsl, ubuntu-26.04-amd64-wsl]  # <os-release ID>-<VERSION_ID>-<dpkg arch>[-wsl]
  prepare: scripts/google-chrome-apt-source.sh  # optional: a bash script, run as mise bootstrap's pre-packages hook; --check only reports
  verify: scripts/verify-system-chrome.sh       # optional: a bash script setup runs once the tools are installed
  bootstrap: system/google-chrome.toml    # only [bootstrap.…] tables, without hooks
  ready:                                  # absolute paths whose presence shows it was applied
    - /usr/bin/google-chrome-stable
  env:                                    # plain variables for the environment file, as host.env
    AGENT_BROWSER_EXECUTABLE_PATH: /usr/bin/google-chrome-stable
```

It applies while the office is in host mode, the setting is on and the machine is one of `platforms`: the machine's is `/etc/os-release`'s `ID` and `VERSION_ID` and its architecture, with `-wsl` when its kernel names Microsoft, so `ubuntu-24.04-amd64` names a native Ubuntu and covers WSL too, while `ubuntu-24.04-amd64-wsl` names only WSL (`OFFICE_SYSTEM_PLATFORM` replaces the detected platform for tests and scratch offices). It is independent of the `host` block and its setting. Then sync writes into the fragment, after any host install, a heading comment, a `[vars]` entry `office_package_<name>` holding the package's folder (from the fragment's real path: mise renders `[vars]`, but not bootstrap hooks, with `config_source`), a `[bootstrap.hooks.pre-packages]` hook that runs `bash "{{ vars.office_package_<name> }}/<prepare>"`, and the bootstrap file's tables, and adds `env` to the environment file. Sync refuses a bootstrap file with anything but `[bootstrap.…]` tables, or with hooks of its own.

**Only `office setup` applies it, and only on a yes in a terminal**: `office sync`, `office up` and the cron jobs only write files the user owns, and office never runs sudo itself. A block's `prepare` script answers `--check` without sudo, network or changes: exit 0 when a run would change nothing, 100 with one line per change. Its optional `verify` script proves the setup works as agents get it.

In a host-mode office that manages its machine, after consent and sync, `office setup` asks mise what the office's own files would still change: each applying block's `prepare --check`, its `ready` paths, and `mise bootstrap plan` over `machine.packages.toml`, the packages' fragments and `machine.toml` alone (a scratch `MISE_CONFIG_DIR` whose `conf.d` links only those, an empty system config folder, run from `/`), so `[bootstrap]` resources of your own mise config, another tool or a project are never planned or applied. `machine.toml`'s `[bootstrap.packages]`, such as the headers a tool builds against, count without any package's block.

- Nothing pending: it says so and asks nothing, with no sudo.
- Something pending, in a terminal: it lists it and asks; on yes it runs `mise bootstrap --only packages,files --yes` in the same scope from your terminal, where mise and the prepare scripts ask for sudo themselves, then checks again and fails setup unless nothing is left. On no it goes on and says to rerun `office setup`.
- Without a terminal it applies nothing, even when the machine record holds consent from `office setup --manage-machine`: consent to manage the machine's links isn't consent to sudo.

This runs before `office up`, so tools that build against the system packages find them. After `office up`, setup runs each applying block's `verify` in a fresh shell that has sourced only the office's environment file (`env -i` with `HOME`, `USER`, `LOGNAME`, `LANG` and `PATH=/usr/bin:/bin`), and fails if one fails. `office check` fails the package's line while a `ready` path is missing, naming `office setup`, and notes (without failing) a setting that is on where the block doesn't apply. Turning the setting off, or leaving host mode, removes the setup from the fragment (and the fragment, when nothing is left) and its variables from the environment file; what it installed stays, as mise removes no packages, files or sources.

On a new machine `office setup` (with `--install-deps` on a machine without mise) does it in one run: consent, sync, the system step, Executor, `office up` (tools, then the managed OpenCode server's first start, with the environment file already complete), the verify scripts, and `office check`. On a machine whose office already runs, enabling a package's system setup is: change `office.yaml`, then `office setup`. Its `office up` rewrites the managed unit but restarts nothing; when the running server predates the current settings (its environment file, unit or secrets), setup offers to restart that unit alone (never `office up --upgrade`, never another process, never a pin) and waits until a new process serves the current settings. Declined, or without a terminal, the server keeps serving as before, and `office check` shows the restart as pending, a warning rather than a failure; rerun `office setup` to restart it. From a terminal inside the managed server, such as an OpenCode session's, the restart is queued in a job of its own as setup's last step, and that terminal closes with the server.

An office from a release that kept these files in `.mise/conf.d/` (which mise also loads in place, as the office's project config) is moved on by `office sync`: each fragment sync wrote there (by its first line) goes to `.office/mise/`, and `machine.toml` to the root unless one is there already (then sync fails on it until you merge the two); a starter header from `office init` is replaced by the current one. Files the office wrote there itself stay, as ordinary project config of the office's folders, no longer linked. Sync relinks the recorded links to the new paths, and removes `.mise/` when it is left empty.

An office from a release that kept each package's tools in its fragment, in a `[tools]` table, is moved on by `office sync` too: it writes `machine.packages.toml` from those tables, each tool at the highest version found across them (so a version the office already bumped stays), then raises any line below a package's version as usual; it rewrites each fragment to hold only the package's setup, deletes one that held only tools (such as the office package's `.office/mise/office.toml`), and replaces the links (`office-<name>-0-office.toml` goes, `office-<name>-0-packages.toml` comes). `office check` reports each such fragment until then. Commit `machine.packages.toml` and the changed `.office/mise/` files afterwards.

### The office CLI's tools

A tool the CLI itself runs belongs to the CLI; `machine.toml` is for your own choices. The required `office` package declares SOPS and age (for the office's encrypted secrets), gh (GitHub logins and sources) and pre-commit (the gitleaks hook) in its `tools`, so every office has them in `machine.packages.toml` like any package's tools: `office upgrade-tools` bumps them, a host-mode office links that file machine-wide (`office-<name>-0-packages.toml`), and the container installs them at start.

The CLI runs the version `machine.packages.toml` pins, as mise installed it, which it finds with `mise which <command> --tool=<tool>@<version>`, run from `/` without config files: no shims, PATH entry, link or consent needed, so it works the same from your terminal, cron jobs, systemd timers and CI, in either mode. Until that version is installed, the newest copy mise installed, on PATH or left in host-tools by an earlier release serves, and `office check` says which.

| Program | Installed by | Where | Version |
|---|---|---|---|
| mise, for the CLI | `office setup`, unless a mise on PATH is as new | `$XDG_DATA_HOME/office/host-tools/bin/mise` (`~/.local/share/office/…`) | The newest stable release at least three days old, checked against its SHA-256 |
| SOPS, age, gh, pre-commit | `office setup` on any host; in host mode also `office up`, through the links; the container at start | mise's own install folder, one copy that the CLI and, through the links, agents share | `machine.packages.toml`; the package's starting versions until `office sync` writes it |
| `host-tools/bin/gh` | `office setup` | A link to that gh | The path `gh auth setup-git` writes into git's credential helper, which stays the same across versions |
| sfw | `office up` in host mode; the image | See "Socket Firewall" | `office.yaml` |

`office setup` asks first (`--install-deps` says yes unattended; one yes covers mise and the tools), then installs the tools with one `mise install sops@… age@… gh@… pre-commit@…`, from `/` without config files and through Socket Firewall's mise wrapper once sfw is installed. That selects nothing anywhere: the tools apply in a folder only through the office's links or the container's. The very first setup needs SOPS and age before you have agreed to the machine links, and has them, since the CLI finds them without links. Once the office's copies are installed, setup removes what earlier releases installed privately in host-tools (their `sops`, `age` and `age-keygen`, and `host-tools/mise/`) and points `host-tools/bin/gh` at the office's gh. pre-commit needs Python 3 on the host; the image has it.

A pin of one of these tools in the office's own files (the root's or a desk's `mise.toml`, or `machine.toml`) is yours, so office never edits it. It wins over `machine.packages.toml` where it applies, so agents can run another version than the CLI does: `office check` names each such pin, with its file, so you can remove it unless it holds the tool back on purpose.

### Machine

A host-mode office manages the machine it runs on, so there is one per machine. What it writes outside its folder and its state follows these rules:

1. **Whole files only.** The office writes files it owns and never edits yours (the one exception is the `plugins` list for desktop panels, see "Panels"). It never replaces a path it didn't write: sync reports it instead.
2. **Named.** Each file is named `office-<name>-…`; a real file starts with a marker line.
3. **Recorded.** The machine record, `$XDG_DATA_HOME/office/machine.json` (`~/.local/share/office/machine.json`), lists each file: its path, its kind (a link, or a file with its SHA-256), the package it belongs to (or the office itself) and what it points at. It names the office that manages the machine, by name and folder. A host-mode office in another folder is refused, naming the owner; an office with the same name whose recorded folder no longer holds it is the same office moved, and sync moves the record and relinks.
4. **Consented.** The record exists only after you say yes: `office setup` asks in a host-mode office, and `--manage-machine` says yes unattended. Until then sync writes nothing outside the office and says what to run, and `office check` fails, since the office's machine-wide tools apply nowhere without their links.
5. **Undone.** Sync removes a link when its file goes (a package's fragment removed, `machine.packages.toml` or `machine.toml` deleted), stops and removes the OpenCode unit when `managed` goes, and removes every file with the record when the office leaves host mode. `office sync --release-machine` does the same on demand, so setup asks again before the next write. `office down` stops what runs and leaves installed files. A file changed since the office wrote it stays, reported.
6. **Checked.** `office check` has a line per file: present and correct, changed, missing, or a dangling link (mise skips one silently, and every shim then fails with "No version is set"); a failure when another office manages the machine.
7. **No root, no apt.**

| Machine files | Written by |
|---|---|
| Links in mise's global `conf.d` | `office sync` |
| `env.sh` and the Socket Firewall wrappers in the office tool's data folder | `office sync` |
| The applied Socket Firewall binary in the same data folder | `office up` |
| `~/.config/systemd/user/office-<name>-opencode.service` (or under `$XDG_CONFIG_HOME`) | `office up` with `opencode.managed: true`; systemd creates the enablement link |

Sync links `machine.packages.toml`, each package's fragment in `.office/mise/` and `machine.toml` into mise's global conf.d (`$MISE_CONFIG_DIR/conf.d`, else `$XDG_CONFIG_HOME/mise/conf.d` or `~/.config/mise/conf.d`) as `office-<name>-0-packages.toml` (every package's tools), `office-<name>-1-<package>.toml` (a package's setup) and `office-<name>-2-machine.toml`. mise loads that folder by name and the last wins, so these come after ordinary fragments such as `10-….toml`, and `machine.toml` after the packages' files, so it wins over their versions; a global `config.toml` still wins over every fragment, and a project's config over everything global. Links, not copies, so an edit or a bump applies at once. Linked files load from any folder with no trust step, as global config; that trusts only the linked files, not the office folder, whose own `mise.toml` files `office up` trusts. A `mise.lock` in the office doesn't apply through the links: global tools use mise's one global lock, and the office pins exact versions. Never set `MISE_GLOBAL_CONFIG_FILE` where agents or the office's tools run: it switches global fragments off, and `office check` warns when it is set.

`OFFICE_MACHINE_RECORD` (the record's path), `OFFICE_MISE_CONFIG_DIR` (the mise config folder whose conf.d gets the links) and `OFFICE_MACHINE_DIR` (the office tool's data folder, for the environment file and sfw) replace those locations for tests and scratch offices; a scratch office that runs mise also sets `MISE_CONFIG_DIR` to that folder.

### Modes

`opencode:` in `office.yaml` says where OpenCode runs, and so what agents have. In host mode OpenCode runs on the machine itself (a workstation, WSL, a VPS) and has what that machine has, the user's desktop Chrome through Browse among it. In container mode it runs in the office's container, with no desktop: browser work goes through agent-browser, and OpenCode's in-app browser when the desktop app is attached. Services (Executor, package services) are containers in both. A package learns the mode from its `.office.json`, as declared, not from the environment: a host session opened in a container-mode office is still a container-mode office.

### Panels

A package can add a tab to the OpenCode desktop app's session side panel. Its `gui/` holds the source, a `package.json` with its build dependencies and the built bundle, `gui/dist/gui-experimental.cjs`, which is committed; the bundle's presence is what gives the package a panel, and nothing goes in `package.yaml`. Building is the package's own script, typically Vite with `@opencode/plugin/gui/vite`. The panel shows for sessions on any server and reads its data over RPC from the package's plugin on the session's own server (`props.session.server.client.rpc(...)`), so the plugin registers the RPC and the panel and plugin share its definition.

The app loads a panel only from its own sidecar server, which reads the config of the machine the app runs on. So for each package with a panel, `office sync`:

1. Works out that machine: this one on Linux or macOS; Windows when it runs in WSL (recognised by the kernel or its interop entry, with Windows' folders asked of `cmd.exe` and mapped with `wslpath`); none inside the office's container, where it says to run `office sync` on the host. When Windows can't be reached it says why and goes on.
2. Copies the bundle into the panel's own folder there, `%LOCALAPPDATA%\office\gui\<name>\` on Windows or `~/.local/share/office/gui/<name>/` (`$XDG_DATA_HOME`) on Linux and macOS. Windows sees no file changes under `\\wsl.localhost`, so the folder is on Windows' own disk. Beside it go a generated `package.json` that names the plugin `office-<name>` and exports only `./gui-experimental`, so the sidecar never runs the package's server half, and `office-panel.json`, recording the bundle's SHA-256 and the office that installed it.
3. Adds the folder's `file://` URL to `plugins` in that machine's `opencode.json` (`%USERPROFILE%\.config\opencode\`, or `~/.config/opencode/`; `opencode.jsonc` when that is the file there), changing nothing else in it, comments included, or nothing at all when the result wouldn't parse to the same configuration plus that entry. The sidecar watches the bundle and its config and reloads open windows within seconds.

`office check` reports each panel: installed, registered and this office's build. The install is per machine, so offices that share a panel replace each other's copy and the last sync wins; check names the office that installed a different build. When a package leaves `office.yaml`, its panel stays installed, since other offices may use it: sync (for a pulled-in package) and check say how to delete the folder and its `plugins` entry.

While building a local package's panel, `office gui dev <name>` watches its bundle and installs each new build, beside the package's own watch build. `OFFICE_APP_CONFIG_DIR` and `OFFICE_APP_PANELS_DIR` together replace the app machine's config and panels folders, for tests and scratch offices.

### Services

A package can add containers to the office: a `compose.yaml` at its root is what gives it services, and nothing goes in `package.yaml` for it. `office up` adds each package's file to the compose project `office-<name>`, in either mode, after the tool's files and before the office's own `compose.yaml`, in package-name order, so the office's file can override a package's service.

```yaml
# packages/notes/package.yaml
name: notes
# namespace: notes             # what services, volumes and variables are named after; the name by default
description: A notes app with its own database
settings:
  title:
    description: The app's title
    default: Notes
secrets:
  NOTES_AUTH_SECRET:
    generate: hex
    bytes: 32
  NOTES_ENCRYPTION_KEYS:
    generate: base64
    bytes: 32
    prefix: "k1:"
```

```yaml
# packages/notes/compose.yaml
services:
  notes:
    build: .                       # the package's folder
    environment:
      AUTH_SECRET: ${NOTES_AUTH_SECRET}
      ENCRYPTION_KEYS: ${NOTES_ENCRYPTION_KEYS}
      TITLE: ${NOTES_TITLE}
      OPENCODE_URL: ${OFFICE_OPENCODE_URL}
    ports:
      - "127.0.0.1:${NOTES_PORT:-41500}:3000"
  notes-db:
    image: postgres:18
    volumes:
      - notes-data:/var/lib/postgresql
volumes:
  notes-data:
```

- **Names.** Every service, volume, network, config and secret the file defines is named after the package's namespace, `<namespace>` or `<namespace>-*`. The namespace is the package's name unless `package.yaml` sets `namespace:` (lowercase letters, digits and dashes), as a package called `design` whose services are `doop` and `doop-db` does with `namespace: doop`. So packages can't define or change `executor`, `opencode` or each other's services: a namespace can't be `executor` or `opencode`, and two packages in an office can't claim the same one, which `office check` reports on both packages' lines and `office up` refuses, naming both.
- **Ports.** Every published port binds `127.0.0.1`: `"127.0.0.1:<port>:<port>"`, or `host_ip: 127.0.0.1` in the long syntax. `network_mode: host` is refused. `office check` reports a file that breaks these rules on the package's line, and `office up` refuses to apply it, naming each problem.
- **Paths.** Relative paths (a `build` context, a bind mount, an `env_file`) are the package's folder: `office up` includes each package's file with that folder as its project directory, since Compose would otherwise resolve them against the tool's own `compose.yaml`.
- **Variables.** Besides the office's variables (see "Runtime"), a package's file gets its settings as `<NAMESPACE>_<SETTING>` (the names in capitals, any character but letters and digits as `_`; `title` in `notes` is `NOTES_TITLE`) and its secrets. The applied settings are authoritative: the Compose launcher reads the generated `settings.env` into its environment, overriding shell variables and making the same values available to the office's compose file. Secrets remain scoped to the package's include; shell variables can override them.
- **Secrets.** `secrets:` in `package.yaml` maps each variable to how it's generated: `bytes` random bytes (16 to 1024) as `hex` or `base64`, after an optional fixed `prefix`. Each name starts with the namespace in capitals with `_` for `-` (`NOTES_`), and can't be a setting's variable. `office up` writes any missing one to `<state>/packages/<name>.env` (mode 600) and never replaces a value, since services sign users in and encrypt stored credentials with them. To rotate one, delete its line. office never prints a value or writes one into the office.

`office up` runs the copy of each package's file it last applied, `<state>/packages/<name>/compose.yaml`, as it runs the versions it last applied:

- A package the office hasn't run before is applied on a plain `office up`.
- When a package's file changes, `office up` says so and keeps running the applied copy; `office check` shows it as pending. `office up --upgrade` stops that package's services, backs up each named volume its applied file declares to `backups/` (printing where each went), then applies the new file.
- A package that leaves `office.yaml` stops contributing on the next `office up`, which removes its applied copy; its containers go as orphans. Its volumes and secrets stay, so adding it back finds its data.
- `office down`, `office check` and every other command use the same applied files as `office up`.

Only the compose file is snapshotted: a package that builds from files in its own folder builds from the current files whenever Compose rebuilds. Package services have no downgrade guard. Settings aren't gated either: `office up` passes the current ones. `office sync` says when a pulled-in package's copy adds or changes a `compose.yaml`, because its services run on this machine's Docker.

### Upgrading an office from before built-in packages

Earlier releases copied the tool's plugin into `.opencode/plugins/office/`, the `office` skill into `skills/office/` (enabled in `skills.enabled`), the `office-executor` MCP server into `.opencode/opencode.jsonc`, and remote packages into `packages/<name>/`, with `knowledge` and `artifact-share` taken from this repository by `repo`, `path` and `ref`. `office check` reports each of these, and one `office sync` moves the office on, listing every change:

1. It replaces the copied `.opencode/plugins/office/` with the link to the `office` package's plugin.
2. It removes `skills/office/` when its only file is a `SKILL.md` some release of the template wrote (it knows each one's SHA-256), and the `office` entry in `skills.enabled`. A copy the office changed stays, with its entry, and both commands report it: delete it, or rename it to keep it beside the package's skill.
3. It removes the `office-executor` entry from `.opencode/opencode.jsonc`, with its trailing comma and the template's comment above it, when it is the entry the template wrote; nothing else in the file changes, and the result must parse to the same configuration without the entry, or it changes nothing and says so. An entry that differs stays, and `office check` reports it.
4. It turns a `knowledge` or `artifact-share` entry whose `repo` is this tool's repository into a built-in entry, dropping `repo`, `path` and `ref` and keeping its settings and comments.
5. It moves each folder in `packages/` that has a `.source.json` and isn't listed as the office's own package to `.office/packages/<name>/`, keeping its `.settings.json` and `.template.json`, and relinks its plugin; a built-in one is then replaced by the executable's copy.
6. It removes the package skill links earlier releases made in `.opencode/skills/`.
7. It moves the mise fragments it wrote in `.mise/conf.d/` to `.office/mise/`, and `.mise/conf.d/machine.toml` to the root, moves the packages' tools out of the fragments into `machine.packages.toml`, and relinks them (see "Tools").

Files a package's template created stay where they are, but an office's copy of a template file that names the package's old path, such as artifact-share's `.github/workflows/publish-artifacts.yml` (`packages/artifact-share/scripts/...`), doesn't change by itself: point it at `.office/packages/<name>/`. Commit what sync changed.

The knowledge plugin of releases before the knowledge package, `.opencode/plugins/knowledge/` (recognised by its header), is removed too. Without a `knowledge` entry, sync says sessions no longer list the articles and that `- name: knowledge` under `packages:` brings it back.

## Git and GitHub

An office can set who it commits as and how its HTTPS remotes authenticate. Offices without the block keep git's own configuration.

```yaml
git:
  name: Some Name
  email: name@example.com
  credentials: gh   # authenticate HTTPS remotes with the host's gh login
```

- **Identity, container mode.** The image sets `GIT_CONFIG_SYSTEM=/etc/opencode/gitconfig`, and the entrypoint writes the identity there (including `/etc/gitconfig`). It is the lowest-priority git config, so agents and cron jobs commit with it, while the container user's `~/.gitconfig` and a repository's own config override it.
- **Identity, host mode.** The host's global git identity never changes, since several offices share the host. Each cron timer's service runs with `GIT_CONFIG_GLOBAL` set to the generated `cron-gitconfig` in the state folder, which includes your global git config and then sets the office's identity; a repository's own config still overrides it. `upgrade-tools` passes the identity itself with `git -c`. The host OpenCode server's agents don't get it: they run with the server's environment and your global identity. To give them the office's identity too, add an `includeIf "gitdir:<office>/"` section to your global git config yourself.
- **GitHub, one login.** Everything authenticates through gh with one login made on the host. With `credentials: gh` in container mode, `office up` mounts the host's gh configuration folder (`$GH_CONFIG_DIR`, else `$XDG_CONFIG_HOME/gh` or `~/.config/gh`) read-only at `/run/office-gh` and sets `GH_CONFIG_DIR` there, and the entrypoint makes `gh auth git-credential` git's HTTPS credential helper for each host gh has an account for (run from the office root, so mise's shim finds the office's gh from any folder). Only that folder is mounted, never your home, `.ssh` or global git config. The container runs gh from the office package's tools in `machine.packages.toml` (the image has none). Read-only is enough: gh's ordinary tokens don't expire, and a read-only mount keeps agents from logging out, switching accounts or rewriting the login. In host mode nothing is mounted: the host server's agents use your host gh and git configuration directly.
- **What can be shared.** The container reads the token from gh's `hosts.yml`, so the login must be stored there (`gh auth login --insecure-storage`, mode 600; gh does this itself when there is no system keyring, as is usual in WSL), not in a system keyring, and not come from `GH_TOKEN`. It must not be one of gh's expiring tokens (`gh auth login --expiring`, gh 2.103+): their refresh token rotates, and two copies refreshing one would sign each other out. `office setup` and `office check` say when a login can't be shared, and how to log in again. The container user is uid 1000, so the host user must be uid 1000 to read the folder.
- **Several offices.** Offices on one machine share the same login while each keeps its own `git` identity.
- **Pushing.** Agents and cron jobs can push once credentials exist; `upgrade-tools` still never pushes.

`office setup` sets this up, resuming from whatever is already in place:

`office.yaml` is the only place these choices are declared: setup reads them and, when interactive, offers to write them.

1. **gh on the host**: one of the office package's tools, so every office has it at the version `machine.packages.toml` pins, installed with SOPS and age in the same confirmation and under `--install-deps` (see "The office CLI's tools"). A gh on PATH serves only until that version is installed.
2. **The commit identity**, when `office.yaml` has none: it offers your global `user.name` and `user.email` for confirmation and saves the answer to `office.yaml`. Unattended, it continues with a note naming the fields to add. It never invents one.
3. **GitHub**, when `office.yaml` has `credentials: gh`, which both declares that the office uses the host's gh login and authorizes what that needs, so unattended setup needs nothing more. It reuses a working `gh auth status` login; otherwise it runs `gh auth login --web --git-protocol https` (with `--insecure-storage --expiring=false` in container mode) in your terminal, and unattended it stops with that command, since a browser login needs you. It runs `gh auth setup-git` when git doesn't use gh for the host (this writes your global git config, so setup says so; for an office-installed gh it records the stable `host-tools/bin/gh` link through `GH_PATH`); in container mode `office up` then shares the login with the container, whose gh is the office package's. Without the key there is no GitHub step and nothing is mounted. If a source on a GitHub host doesn't read without a login (checked with no credentials), interactive setup offers to set GitHub up and writes `credentials: gh` when you accept; unattended setup stops before cloning, naming the key. A desk repository that reads without a login but that agents would push to only gets a one-line note naming the key, never a prompt. SSH remotes are left to your own SSH setup.
4. **Every source is read** (references, desk repositories, plugins, copied skills) with this host's git credentials before anything is cloned, and any that doesn't read stops setup with the likely cause: not logged in, no access, or organization SSO authorization.

`office check` reports the identity and, with `credentials: gh`, whether gh is logged in on the host, whether git there uses it, which gh `machine.packages.toml` gives the container and whether the running container's gh is logged in and git uses it. An office without `credentials: gh` isn't failed for it.

## First run

```sh
office init ~/my-office --name mine
cd ~/my-office
office setup
```

Setup offers host dependency installation before age identity or encryption work, then the office's commit identity and GitHub before cloning (see "Git and GitHub"), and in a host-mode office asks whether it may manage the machine (see "Machine"). It asks before creating an age identity and asks for your Executor owner email; it never invents an email. For unattended setup, supply `--owner-email <email>`, `--install-deps` to authorize dependency changes, `--generate-age-key` if a new identity is needed and, in a host-mode office, `--manage-machine` to let it write outside its folder (see "Machine"); declare the identity and GitHub in `office.yaml`'s `git` block. Without `--install-deps`, unattended setup keeps working installed tools, reports available updates, and stops if a required tool is missing. Missing required input stops with guidance instead of waiting on stdin. Docker with a working daemon, Compose and Buildx, and Git remain separately installed prerequisites.

Cron activation follows the existing `up` behavior without another approval prompt: starting a template office runs its missed jobs, including jobs never run, which can update references and commit tool pin changes. `init` still creates files only; `up` still starts services only.

Setup preserves existing accounts and working instance-local tokens. Before creating an owner it proves SOPS encryption/recovery and saves the generated strong password encrypted in `secrets/executor-owner.enc.json`. The owner name is `<office name> owner`, and the organization name is the office name. Interrupted account creation resumes with that same record, never a new password. A different fresh Executor can reuse this encrypted owner record, but gets its own local API token. Existing instances without a valid token need the existing owner's encrypted login or an existing organization-bound token; setup never resets them.

In an interactive terminal the newly generated password is deliberately displayed once. Redirected/noninteractive setup output withholds it. Retrieve it explicitly later:

```sh
office executor credentials
office executor credentials --password-only | <clipboard-command>
```

Review and commit `.sops.yaml`, `office.yaml` and encrypted credentials yourself; setup never commits or pushes. Back up the age identity separately. Setup installs git's pre-commit hook in the office, so commits run the gitleaks hook; in another clone, run `pre-commit install` there.

**Model authentication remains human-controlled.** Log Claude Code in, then connect Claude Agent in OpenCode (or use `/connect` and `/models` for another provider):

   ```sh
   docker exec -it office-mine-opencode-1 claude auth login
   P=$(grep OPENCODE_PASSWORD ~/.local/share/office/mine/secrets.env | cut -d= -f2)
   curl -u "opencode:$P" -X POST -H 'content-type: application/json' \
     -H 'x-opencode-directory: /home/office/workspace' -d '{"methodID":"claude-login"}' \
     http://127.0.0.1:41497/api/integration/claude-agent/connect/external
   ```

`office setup` deploys apps and runs checks. It makes no model request and does not verify a provider's billing or model access. `office pair` prints the next-step link for the desktop app or a browser.

OpenCode's API picks a session's folder from the `x-opencode-directory` header or the `location[directory]` query parameter; it ignores `?directory=` and falls back to its start folder.

## Executor catalog apps

Select official catalog IDs in `office.yaml`:

```yaml
executor:
  catalog_apps: [github]
```

Run `office apps deploy` (also part of `office setup`). It installs missing entries and recognizes existing apps by slug **and catalog package**. It does not refresh an existing app from the catalog. Removing a stock entry stops checking it; the app and its accounts remain in Executor. `office check` reports missing apps and name conflicts. Connect the app's accounts in Executor.

To customize an installed Executor app, run `office apps adopt github`. Commit `executor-apps/github/`, including `.office-catalog`, and keep `github` declared. Edit its tools, schedules or workflows there and run `office apps deploy`. Deployment uses the existing app ID, retaining compatible account links. On a fresh instance it installs the template first, then deploys your committed version. The marker is office metadata and is not uploaded. The adopted manifest and `office.ts` remain yours; if your tools import extra dependencies directly, install them in the app folder for local type-checking. Adoption refuses to overwrite an existing folder or silently omit assets whose bytes Executor's source API does not return.

On an existing office, `office sync` moves `executor/apps/` to `executor-apps/` at the root and in each declared desk. Commit the moves and update any custom scripts pointing to the old locations. The move needs no Executor redeployment. To describe an Executor app in session instructions, set `description` in its `package.json`.

## The office's Executor key

`office setup` keeps one Executor key for the office in `<state>/office-executor.env`: `EXECUTOR_TOKEN` and the organization's ID as `EXECUTOR_ORGANIZATION`. A working key is reused whatever its name in Executor; when the file is missing or Executor refuses its token, setup signs in as the stored owner and creates an organization-bound key named `office`. It never deletes a key: a key whose file was lost still works until you delete it under Tokens in Executor's dashboard.

OpenCode reaches Executor with this key, and so may a service in the office's own `compose.yaml`, such as a dashboard's API:

```yaml
services:
  api:
    env_file:
      - path: ${OFFICE_STATE}/office-executor.env
        required: false
    environment:
      EXECUTOR_URL: http://executor:4400
```

Every Executor API key acts with the owner's full authority in its organization, so a key per service would separate nothing but revocation.

Upgrading from an `office` that kept the key as `opencode-executor.env`: the first command that needs the key renames the file to `office-executor.env`, and the next `office setup` adds `EXECUTOR_ORGANIZATION`, read with the key itself. Run `office up` so the containers read the new file. The key keeps its old name in Executor.

## Portable secrets

`office setup` installs host mise and the office's [SOPS](https://getsops.io/docs/installation/) and [age](https://github.com/FiloSottile/age/releases), with gh and pre-commit, as "The office CLI's tools" describes. Office reads mise's official GitHub release metadata, takes the newest stable release published at least **three days** ago and verifies the downloaded executable against the asset's SHA-256 digest; mise verifies the tools' downloads. Setup shows installed and proposed versions and asks permission before changes; declining keeps working installed tools, and a missing SOPS or age stops setup with instructions. No command updates these in the background: `office upgrade-tools` bumps the office's pins, and the next `office setup` (or, in host mode, `office up`) installs them.

System and package-manager executables are never overwritten, global mise selections and shell profiles do not change, and the CLI needs no shell activation or terminal restart. To run the office's SOPS yourself, `sops` works in any folder once a host-mode office's links are in place; otherwise `mise exec sops@<version> -- sops` runs the office's copy.

You can instead install standalone releases with their published integrity checks, or use your package manager: the CLI uses them until the pinned versions are installed. Tested releases are mise **2026.11.8** (2026-11-13), SOPS **3.13.3** (2026-07-23), age **1.3.2** (2026-08-29), gh **2.104.0** (2026-11-12) and pre-commit **4.7.0**. Automated host installation supports Linux and macOS on x64 and arm64; on Windows, use WSL. SOPS runs on the host in container mode too: the container gets the office package's tools like any package's, but no age identity.

The Executor owner's source in `office.yaml`, relative to the office root and written by `office setup`:

```yaml
secrets:
  executor_owner: secrets/executor-owner.enc.json
```

The host identity normally lives at `~/.config/sops/age/keys.txt` (`$XDG_CONFIG_HOME` is honored). Standard SOPS identity selection, including `SOPS_AGE_KEY_FILE`, also works. `office setup --generate-age-key` creates a missing identity only with explicit consent, shows **only its public recipient**, and preserves any existing `.sops.yaml`. Multiple recipients are supported by normal SOPS rules:

```yaml
creation_rules:
  - path_regex: secrets/.*\.enc\.json$
    age: >-
      age1<first-public-recipient>,
      age1<second-public-recipient>
```

On a new computer, a newly generated identity **cannot** decrypt an existing office. Send its public recipient to an already-authorized host. There, add it to `.sops.yaml`, run `sops updatekeys` on each encrypted file in `secrets/`, review/commit those encrypted files, and sync them to the new host. Use ordinary `sops <file>` for later edits; `updatekeys` changes enrollment, not the secret values. Keep authorized recovery identities backed up.

For a managed OpenCode server, optionally add `server: secrets/server.enc.yaml` under `secrets:`. Extend the `.sops.yaml` creation rule to `secrets/.*\.enc\.(json|yaml)$` (or add a separate YAML rule with the authorized recipients). Create/edit it with the office's `sops secrets/server.enc.yaml`, or pipe a flat YAML mapping into `sops encrypt --input-type yaml --output-type yaml --filename-override secrets/server.enc.yaml /dev/stdin` and save only the encrypted output. Use valid environment names and quote values so they are strings. Do not duplicate a name from `env_commands` or set startup variables such as `PATH`, `HOME` or the service password here.

`office up` and `office check` validate that the server file decrypts and has the expected shape, withholding values on failure. The unit uses `sops exec-env --same-process` and an absolute age key path to pass plaintext to the server and its children, not a file or container. After editing it, run `office up --upgrade` to apply it. When there is no server file, the unit runs without SOPS. The Executor owner plaintext stays in host memory.

An earlier `office` had a Claude gateway (a `claude:` block feeding Claude Code a gateway token and base URL). It is gone: delete the `claude:` block and retire its credential and settings. After recreating the old container, check for the old plaintext `<state>/runtime/claude/gateway.json` and remove it if no other installation uses it. The container still ships Claude Code at `versions.claude`.

## Not yet

- Desks share one Executor token; scoped connections per desk need a browser sign-in from the container.
- Containers aren't blocked from the LAN.
