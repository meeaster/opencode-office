# opencode-office: the `office` tool

An **office** is a source-controlled folder of **desks** for OpenCode. The folder a session starts in decides what the agent knows and can do: every session loads the office root's instructions, config and skills, and a session in a desk also loads that desk's. Desks never load each other's.

This repository holds the `office` command, the template `office init` copies, the built-in packages (the `office` package every office runs among them), the base image of the `opencode` container and the compose file for the two services every office runs:

- **Executor** holds every service account and runs the office's schedules, webhooks and approvals. It always runs in a container.
- **OpenCode** serves every desk, in one of two modes that `office.yaml` chooses:
  - **container** (the default): the office's `opencode` container, with the office mounted at `~/workspace`.
  - **host**: an OpenCode server already running on this machine, such as the OpenCode background service. The office never starts or stops it.

  ```yaml
  opencode: container
  # or
  opencode:
    mode: host
    url: http://127.0.0.1:49374
  ```

An office keeps its own content: desks, skills, plugins, Executor apps, cron jobs and any extra services. It also pins the versions of what runs in its containers (OpenCode, Claude Code, Executor and mise); see "Versions".

## Install

`office` is one executable carrying the template, the built-in packages and image files. Put it on your PATH, such as at `~/.local/bin/office`. Docker with Compose and Buildx, and Git, are host prerequisites. Portable encrypted secrets also need host SOPS and age, and an office with private GitHub sources gh; no Node/npm runtime is needed. `office --version` prints its version and build commit.

Every commit to `main` publishes a pre-release named `0.1.0-<UTC date and time>` on the [releases page](https://github.com/meeaster/opencode-office/releases), for Linux x64; the newest ten are kept. To install one:

```sh
curl -fsSLO https://github.com/meeaster/opencode-office/releases/download/<release>/office-linux-x64
curl -fsSLO https://github.com/meeaster/opencode-office/releases/download/<release>/SHA256SUMS
sha256sum -c SHA256SUMS
install -m 755 office-linux-x64 ~/.local/bin/office
office --version
```

### Updating

`office update` replaces the `office` you run with a newer release, from any folder:

```sh
office update --check                        # report the newest eligible release, change nothing
office update                                # install the newest release at least a day old
office update --minimum-release-age 7d       # or at least this old (hours, days or weeks)
office update --version 0.1.0-20261116T163238Z   # exactly this release, whatever its age
```

- It reads the releases page without a login and only considers releases that publish this machine's executable (`office-<platform>-<arch>`) and a `SHA256SUMS` for it. The age comes from the option, not from any `office.yaml`, because one executable serves every office. `--check` prints the command that installs what it found, including the age it used, and the `--version` command for exactly that release.
- Without `--version` it never installs an older release than the one it runs. A build from a checkout isn't a release: it compares against the release built from the same commit, and a build of an unreleased commit, or one with uncommitted changes, is left alone (`--version` replaces it deliberately). `--version` can also go back to an older release.
- It downloads beside the executable, checks the file against the release's `SHA256SUMS`, runs it once to confirm it reports the release's version and commit, and only then renames it over the old one. Any failure leaves the old executable as it was. When `office` is a symlink, it replaces the file the link points to. It needs write access to that folder and never uses sudo.
- `office` run from a checkout (`bin/office`) refuses: update the checkout instead.

Updating `office` changes no office. Each office picks the new one up when you run, in it, `office sync` (updates the office's copies of the built-in packages, which you then commit), `office up` (in container mode, rebuilds the `opencode` image with the new `office`) and `office check` (confirms the container runs the host's `office`). `office up` keeps the OpenCode, Claude Code, Executor and mise versions the office last applied; only `office up --upgrade` applies newer ones from `office.yaml` (see "Versions"). In host mode the cron timers run the executable itself, so they use the new `office` straight away.

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
| `office init <dir> [--name <name>]` | Creates an office from `template/`: root files, a starter `office.yaml` at this tool's versions with its `office.lock`, one example desk, the built-in `office` and `knowledge` packages (see "Packages") and a git repository on branch `main` |
| `office setup [--owner-email <email>] [--generate-age-key] [--install-deps]` | Resumes onboarding after init or clone: checks prerequisites and secrets, the office's commit identity and GitHub, reads every source, syncs, starts Executor, bootstraps its owner and the office's organization-bound Executor key (see "The office's Executor key"), then starts OpenCode, deploys apps and checks. Human provider logins remain separate. `--generate-age-key` consents to creating a host identity/public recipient config. `--install-deps` authorizes host mise, SOPS and age (and gh) installs or updates. The identity and GitHub come from `office.yaml`'s `git` block; see "Git and GitHub" |
| `office executor credentials [--password-only]` | Deliberately decrypts and reveals the stored owner login on the host, even with Executor stopped. Password-only writes exact password bytes, without a newline, for a clipboard pipe; it does not verify the live password |
| `office sync [--references]` | Clones and updates references and desk repositories, refusing a clone path that holds anything but its own clone (or an empty folder), moves an office laid out by an earlier release to the current layout (see "Upgrading an office from before built-in packages"), scaffolds declared desks that are missing, copies declared skills into `skills/` (recording the commit in `.source.json`), installs, updates, restores and removes packages (see "Packages"), links enabled library skills into each `.opencode/skills/` and package plugins into `.opencode/plugins/`, clones declared plugins, and installs package panels on the desktop app's machine (see "Panels"). It never writes to `AGENTS.md` or other hand-written files |
| `office check` | Reports drift between `office.yaml` and the folders, including what an earlier release's layout left that `office sync` moves on; one line per package (its kind and source, edits to a pulled-in copy, settings, plugin, and the services its `compose.yaml` contributes: their problems, a pending upgrade and, when the office runs, whether they run) and per package panel (installed, registered, this office's build); the versions and whether `office.lock` matches, a warning for versions outside the range this tool was tested with and for a pending upgrade; when the containers run, also whether they run the applied versions, Executor's health, whether the container's `office` is the host's (`office --version`), whether every app is deployed for the `apps` framework Executor serves; for the root and each desk, on the mode's OpenCode server, its agents, its skills (the library's it enables and each package's), its plugins (each package's, the `office` package's included, active) and its Executor connection; and the cron runner (supercronic in the container, or the host's timers); in container mode, the weekly image refresh timer and a warning when the image's Debian packages are more than eight days old |
| `office instructions [folder]` | Prints the guidance the `office` package's plugin gives a session started in that folder, from the same code |
| `office up [--upgrade] [--refresh]` / `office down` | Starts or stops the compose project `office-<name>`: `executor`, `opencode` (container mode only), the services packages contribute and the office's own `compose.yaml`. `up` runs the versions and package compose files it last applied and prints what has changed since; `--upgrade` applies those (see "Versions" and "Services"). In container mode `up` builds the base image with this `office` inside it, and the office's `Dockerfile` on top of it when there is one, and installs the weekly image refresh timer; `--refresh` rebuilds with current Debian packages (see "Image refresh"). In host mode `up` also installs the office's `mise.toml` tools with the host's mise and the cron timers. `down` removes the timers. See "Host mode" |
| `office shell` / `office exec -- <command...>` | A shell, or one command, in the running `opencode` container as its user, in the container folder matching the one you run it from (the office root, a desk, a repository in it; else the office root), with the container's home and mise's tools. `exec` forwards stdin and the exit status, and a terminal when both ends are one, so it works in pipes. Neither starts or rebuilds anything; in host mode they say to run commands on the host |
| `office pin` | Writes `office.lock` for the versions `office.yaml` pins, looking up any it doesn't already hold on GitHub or Executor's registry |
| `office pair [--origin <url>]` | Prints a one-time link that connects the OpenCode desktop app or a browser to the office's OpenCode server. It works once, within five minutes; the app stays signed in until the password changes. `--origin` replaces the address in the link |
| `office gui dev <package>` | While a local package's panel is being built, installs the bundle on the desktop app's machine each time the build writes it; see "Panels" |
| `office apps deploy` | Deploys every app in `executor/apps/*` and `<desk>/executor/apps/*` from its files, creating apps that don't exist, and links the OpenCode account to each app that declares one. It first type-checks every app against the `apps` framework Executor serves (with this executable acting as Bun) and sets each app's `apps` dependency to that version, deploying nothing if one fails. Each app's `office.ts` is replaced by one for the office's mode |
| `office upgrade-tools` | Bumps each exact pin in the office's own `mise.toml` files (root and desks), and the versions in `office.yaml`, to the newest release at least the office's minimum release age old, and commits the changed files alone as the office's git identity, else `office cron`. See "Cron" |
| `office update [--check] [--minimum-release-age <age> \| --version <release>]` | Replaces this `office` executable with a release from GitHub: the newest at least a day (or `<age>`) old and newer than this one, or exactly `<release>`. `--check` only reports. It changes no office; see "Updating" |
| `office cron crontab \| catch-up \| run <command>` | The cron runner the container and the host's timers call; see "Cron" |

## Layout

| Path | What it is |
|---|---|
| `src/` | The CLI in TypeScript on Bun: `cli.ts` (arguments), `schema.ts` (the shape of `office.yaml`, `office.lock` and a package's `package.yaml`, shared with the `office` package's plugin), `office.ts` (reads `office.yaml`), `versions.ts` (pins, the lock, what was applied), `releases.ts` (release lookups on GitHub and the registry), `layout.ts` (what the folders should hold), `packages.ts` (the three kinds of package; installs, updates, restores and reads them), `package-services.ts` (the services packages add: validation, generated secrets, the applied copies), `migrate.ts` (moves an office from an earlier release's layout), `desktop.ts` (installs package panels on the desktop app's machine), `tool.ts` (the tool's own files, the built-in packages as offices get them, its version, the image's build folder), `build.ts` (compiles the executable), `vendor-artifact-share.ts` (regenerates the libraries the artifact-share package carries, from pinned devDependencies), `commands/` and `cron/` (`container.ts` for supercronic, `host.ts` for systemd timers). Runtime dependencies: `yaml` and `valibot` |
| `bin/office` | Runs the CLI from the checkout with Bun |
| `template/office/` | What `office init` copies once: `AGENTS.md`, `README.md`, `office.yaml`, `.opencode/opencode.jsonc`, `executor/apps/opencode/`, `cron/`, `mise.toml` (with pre-commit), `.pre-commit-config.yaml` (gitleaks), `.gitignore` |
| `template/desk/` | What `office sync` scaffolds for a new desk, including its starter Executor app, which a desk with `app: false` in `office.yaml` goes without |
| `packages/` | The built-in packages, embedded in the executable (see "Packages"): `office`, which every office has, and `knowledge` and `artifact-share`. `packages/office/plugin/` is the source of the `office` package's plugin, with `instructions.ts`, which `office instructions` also runs; offices get it bundled with what it imports into one `plugin/index.js` |
| `image/Dockerfile` | The base image: Debian 13 with OpenCode, Claude Code and mise at the office's versions and checksums (build arguments), supercronic pinned by the tool, build tools, Chromium (with `AGENT_BROWSER_EXECUTABLE_PATH` pointing agent-browser at it) and the compiled `office`. Its apt layer upgrades Debian's packages as of the office's last refresh (the `APT_REFRESH` build argument). User `office`, uid 1000 |
| `image/entrypoint.sh` | Writes the machine note to `/etc/opencode/machine.md`, installs the tools the office's `mise.toml` files declare, runs missed cron jobs and starts supercronic, then runs OpenCode |
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
| `<NAMESPACE>_<SETTING>`, and each secret | In a package's own `compose.yaml` only: its settings and generated secrets (see "Services") |

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
upgrades:
  minimum_release_age: 1d    # for everything upgrade-tools bumps
  executor: 7d               # per tool, by name (one of the four, or a mise.toml tool)
```

- `office.lock`, written only by `office pin` and committed, holds the SHA-256 of each release file the image downloads (OpenCode's, Claude Code's and mise's linux-x64 assets, as GitHub reports them) and Executor's image digest. Change a version by hand, then run `office pin`. A lock that doesn't match `office.yaml` stops `office up --upgrade` and fails `office check`, naming `office pin`.
- An office without a `versions` block runs this tool's defaults; `office check` says so. Supercronic, the Debian base image and Bun stay pinned by the tool.
- `office up` runs what it last applied (`applied.json` in the state folder), so a bump the daily job records changes nothing until someone runs `office up --upgrade`. That prints the changes, refuses an older OpenCode or Executor than the office has run (their data only migrates forward), stops what changes and backs it up into `backups/`, builds and starts the new versions, and after an Executor upgrade runs `office apps deploy` so every app matches its `apps` framework.
- `office check` warns, without failing, when a version is outside the range this tool was tested with, and when an upgrade is pending.
- Debian's packages are not pinned, and in container mode a weekly timer refreshes them; see "Image refresh".
- In host mode only Executor's version applies: OpenCode and Claude Code are the host's. `office check` warns when the host's OpenCode is outside the tested range.

## Host mode

1. Put the host server's password in the state folder. For the OpenCode background service:

   ```sh
   mkdir -p <state> && (umask 077; echo "OPENCODE_PASSWORD=$(opencode service get password)" >> <state>/secrets.env)
   ```

2. `office up`. It starts `executor` and the office's own services, removes an `opencode` container left from container mode, writes the MCP files above, runs `mise trust` and `mise install` for the root's and each desk's `mise.toml`, and installs the cron timers.
3. `office apps deploy`, so the apps reach the host's server, then `office check`.

Containers reach a server on the host's loopback through `host.docker.internal`; with Docker Desktop on WSL that reaches a server listening on `127.0.0.1` in WSL, so nothing listens on another address. Sessions start at the office's own path, so the host server also loads its global configuration and every `AGENTS.md` from the office up to your home folder; the container's machine note exists only in container mode.

## Cron

An office's `cron/crontab` lists jobs as a five-field cron expression (or `@daily` and the like) and a command run from the office root. Times are UTC unless the container sets `TZ`. The commands are plain scripts that know nothing of the runner.

In host mode, `office up` turns each job into a systemd user timer, `office-<name>-<script>.timer`, with `OnCalendar` in UTC and `Persistent=true`, whose service runs `office cron run <command>` from the office root with the PATH `office up` ran with (mise's shims in place of its per-version folders). systemd runs a job once when a scheduled time passed while the computer was off. Unlike container catch-up, a timer enabled for the first time waits for its first scheduled time. A job that restricts both the day of the month and the weekday has no timer equivalent, and `office up` refuses it. `office down` removes the units; never edit them by hand.

In the container, supercronic runs the crontab with each command wrapped in `office cron run`, which stamps the time of each success in `~/.local/state/office/cron/` (the home volume, not the office). When the container starts, `office cron catch-up` runs once, in order, every job whose most recent scheduled time is later than its last success, including jobs that never succeeded. That covers a computer that was off at the scheduled time.

The template ships two jobs:

- `cron/update-references.sh` (06:00): `office sync --references`.
- `cron/upgrade-tools.sh` (06:30): `office upgrade-tools`.
  - For each exact pin in the root's and each desk's `mise.toml` (never a clone's), it asks `mise latest <tool> --minimum-release-age <age>` for the newest version at least that old and installs it; only after the install succeeds does it rewrite the pin, and a failed install keeps the old one.
  - For the four versions in `office.yaml`, it reads each project's newest hundred GitHub releases without a login, keeps the line the office runs (`v<semver>` tags for OpenCode, Claude Code and mise; Executor's `executor@2.…` pre-releases, not its v1 line), drops releases younger than the age, and takes the highest version, never a lower one than the pin. It confirms the release file, or Executor's image on ghcr.io, exists, then rewrites only those version lines in `office.yaml` and `office.lock`. A failed lookup (GitHub's rate limit, no network) skips that tool and is reported. It never rebuilds or restarts anything.
  - Ages come from `upgrades` in `office.yaml`: a tool's own, else `minimum_release_age`, else a day.
  - It skips a file with uncommitted changes (for the versions, `office.yaml` or `office.lock`). Changed files (and a `mise.lock` beside them, if the office uses one) go into one commit, such as `chore: bump opencode 2.3.0 → 2.4.0, node 26.13.1 → 26.14.0`, made as the office's git identity from `office.yaml`, else `office cron <office-cron@localhost>`, through `git -c`, so no git config changes. It never pushes, even when the office has GitHub credentials. It notifies the app of the first desk that has one (`notifications.send`) of what moved or failed, stays silent when nothing changed, and exits non-zero on a failure, so the job counts as missed and runs again at the next start.

## Image refresh

The base image pins Debian by digest, so its packages, Chromium among them, only get security fixes when the image's apt layer is rebuilt. Docker reuses that layer while its inputs stay the same, so `office up` passes the time of the office's last refresh (`refreshed` in `applied.json`) as the `APT_REFRESH` build argument. `office up --refresh` records a new time, which rebuilds the layer with `apt-get upgrade` and current packages, rebuilds the office's own `Dockerfile` on top, and restarts the `opencode` container on the versions last applied; it never applies `office.yaml`'s newer ones. Any other `office up` keeps the last refresh's packages, so a rebuild never falls back to older ones. It notifies the app of the first desk that has one with the Chromium version it moved to, or why it failed.

The container can't rebuild itself, as it has no Docker socket, so in container mode `office up` installs a systemd user timer on the host, `office-<name>-refresh-image.timer`, which runs `office up --refresh` on Sundays at 07:00 UTC with `Persistent=true`, the PATH and the `*_PORT` variables `office up` ran with. OpenCode resumes a session whose turn the restart interrupted; a shell command it was running is lost. On a machine without a systemd user manager, `office up` says so and `office check` warns; run `office up --refresh` yourself. `office check` warns when the last refresh is more than eight days old.

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

- An entry without `repo` is built-in when this tool ships a package of that name, and the office's own otherwise; a local package can't use a built-in's name. The built-in packages are this repository's `packages/`: `office`, `knowledge` and `artifact-share`.
- `office` is required: every office has it without an entry, and listing it is an error that `office sync` and `office check` report (nothing else changes). It holds what every office needs from OpenCode, given by its plugin: the guidance for a session's folder (which `office instructions` prints), the `office` skill and the `office-executor` MCP server (see "Runtime"). `knowledge` and `artifact-share` are optional.
- A built-in package follows the `office` executable: `office sync` replaces the office's copy whenever it differs from the executable's. An entry naming a built-in with a `repo` other than this tool's repository is an error: a built-in can't be pinned or forked under its own name.
- A remote package moves when its `ref` changes: a tag, a branch or a full 40-character commit SHA (git can't fetch an abbreviated one).
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
```

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
  - name: something-local        # this office's own, in packages/something-local/
```

For each package, `office sync`:

1. Installs a built-in package from the executable, or copies a remote one at `ref`, with the repository's licence when the folder has none, into `.office/packages/<name>/`, and writes its `.source.json`. It replaces a built-in copy that differs from the executable's, a remote copy whose record differs from the entry's repository, path or ref, and any pulled-in copy whose files were edited, saying which.
2. Copies each file under `template/` to the same path in the office once, and says what it created; a file already there is kept and counted as handled. The package's `.template.json` records the handled paths, kept across updates, so a file the office deletes stays deleted and an update creates only files a newer version adds. It never overwrites: from then on the file is the office's.
3. Writes the settings, with defaults applied, to the package's `.settings.json`. A setting the package doesn't declare, or a required one left out, is an error naming the field. Settings are not secrets: the file is committed, so the plugin, scripts and a workflow all read it.
4. Links its `plugin/` as `.opencode/plugins/<name>` (a relative link, committed), which OpenCode loads for the root and every desk without an entry in `opencode.jsonc`. A package whose name is a `plugins:` entry, or a plugin folder of the office's own in `.opencode/plugins/`, is an error, and its plugin isn't linked (package names are unique in `office.yaml`, so two packages can't meet there). When the entry leaves `office.yaml`, sync removes the link and the plugin stops loading.

A package's plugin is the one way it reaches OpenCode: OpenCode loads each package's plugin itself, nothing else of a package is linked into `.opencode/`, and `package.yaml` declares nothing OpenCode loads. The plugin registers the package's skills with `ctx.skill.transform`, as `artifact-share` does for `skills/share-artifact/`, and its MCP servers with `ctx.mcp.transform`, as `office` does for `office-executor`; tools, hooks and instructions come from the plugin too. `office check` fails a package that has `skills/` but no plugin, since nothing loads them.

A plugin runs with nothing installed: there is no `node_modules` beside it. It imports only what the runtime provides (Node's and Bun's built-ins, and the `@opencode/plugin` and `effect` modules OpenCode gives every plugin), or ships its own bundle, as the `office` package does: its `plugin/` in an office holds one `index.js` built with what it imports. OpenCode loads `plugin/server.ts`, else `plugin/index.ts` (or `.js`), or the entry exported by a `package.json` there that has `name` and `exports`, and reloads a plugin when a file it imports inside `plugin/` changes.

OpenCode loads the plugin through the link and resolves its relative imports from there, so a plugin can't import a file outside `plugin/` (`../.settings.json` fails to load), and its own path may be the link's or the package folder's. It finds its package folder with `realpathSync` on its own folder, and the office by walking up to `office.yaml`, never by a fixed number of folders. A plugin that uses its settings reads `.settings.json` from its package folder itself, when it needs them (in a hook or transform), so it sees the values the next `office sync` writes.

To uninstall a built-in or remote package, delete its entry from `office.yaml` and run `office sync`. It unlinks the plugin, deletes each file `.template.json` lists that is still byte-identical to the package's `template/` copy (and the folders that leaves empty), keeps and names each one the office changed, and removes `.office/packages/<name>/`. Files the office created itself, such as `artifacts/<name>/` beside a template's `artifacts/README.md`, are never touched. Commit what it changed; `git restore` brings it back. A local package stays until you delete its folder.

`.source.json`, `.settings.json` and `.template.json` are the office's records, so they are left out of the file hashes. `office check` reports a folder in `packages/` that `office.yaml` doesn't list (sync never removes one) and one that has a built-in's name, and a folder in `.office/packages/` that no entry wants, which sync removes.

There is no registry, no dependency between packages and no version range. The built-in packages:

| Package | Does |
|---|---|
| `office` | Every office has it: the guidance for a session's folder, the `office` skill and the `office-executor` MCP server |
| [`knowledge`](packages/knowledge/README.md) | Lists the office's `knowledge/` articles, with their descriptions, in every session, refreshed on each prompt. `office init` adds it |
| [`artifact-share`](packages/artifact-share/README.md) | The user asks an agent to share something; it goes in the office's `artifacts/`, which a workflow publishes as a GitHub Pages site with an index page. The site may be public, even for a private repository |

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
- **Variables.** Besides the office's variables (see "Runtime"), a package's file, and only its own, gets its settings as `<NAMESPACE>_<SETTING>` (the names in capitals, any character but letters and digits as `_`; `title` in `notes` is `NOTES_TITLE`) and its secrets. The environment `office up` runs in wins over both, which is why they carry the namespace.
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
- **GitHub, one login.** Everything authenticates through gh with one login made on the host. With `credentials: gh` in container mode, `office up` mounts the host's gh configuration folder (`$GH_CONFIG_DIR`, else `$XDG_CONFIG_HOME/gh` or `~/.config/gh`) read-only at `/run/office-gh` and sets `GH_CONFIG_DIR` there, and the entrypoint makes `gh auth git-credential` git's HTTPS credential helper for each host gh has an account for (run from the office root, so mise's shim finds the office's gh from any folder). Only that folder is mounted, never your home, `.ssh` or global git config. The container runs gh from the office's `mise.toml` (the image has none). Read-only is enough: gh's ordinary tokens don't expire, and a read-only mount keeps agents from logging out, switching accounts or rewriting the login. In host mode nothing is mounted: the host server's agents use your host gh and git configuration directly.
- **What can be shared.** The container reads the token from gh's `hosts.yml`, so the login must be stored there (`gh auth login --insecure-storage`, mode 600; gh does this itself when there is no system keyring, as is usual in WSL), not in a system keyring, and not come from `GH_TOKEN`. It must not be one of gh's expiring tokens (`gh auth login --expiring`, gh 2.103+): their refresh token rotates, and two copies refreshing one would sign each other out. `office setup` and `office check` say when a login can't be shared, and how to log in again. The container user is uid 1000, so the host user must be uid 1000 to read the folder.
- **Several offices.** Offices on one machine share the same login while each keeps its own `git` identity.
- **Pushing.** Agents and cron jobs can push once credentials exist; `upgrade-tools` still never pushes.

`office setup` sets this up, resuming from whatever is already in place:

`office.yaml` is the only place these choices are declared: setup reads them and, when interactive, offers to write them.

1. **gh on the host**, only for an office with `credentials: gh` or a source on a GitHub host (github.com, or a host gh already has an account for) that doesn't read without a login: installed or updated like mise, SOPS and age, in the same grouped confirmation and under `--install-deps`. A gh on PATH is reused, a newer one kept.
2. **The commit identity**, when `office.yaml` has none: it offers your global `user.name` and `user.email` for confirmation and saves the answer to `office.yaml`. Unattended, it continues with a note naming the fields to add. It never invents one.
3. **GitHub**, when `office.yaml` has `credentials: gh`, which both declares that the office uses the host's gh login and authorizes what that needs, so unattended setup needs nothing more. It reuses a working `gh auth status` login; otherwise it runs `gh auth login --web --git-protocol https` (with `--insecure-storage --expiring=false` in container mode) in your terminal, and unattended it stops with that command, since a browser login needs you. It runs `gh auth setup-git` when git doesn't use gh for the host (this writes your global git config, so setup says so; for an office-installed gh it records the stable `host-tools/bin/gh` link through `GH_PATH`), and in container mode pins gh (the newest stable release at least three days old) in the root `mise.toml`, keeping an existing pin; `office up` then shares the login. Without the key there is no GitHub step and nothing is mounted. If a source on a GitHub host doesn't read without a login (checked with no credentials), interactive setup offers to set GitHub up and writes `credentials: gh` when you accept; unattended setup stops before cloning, naming the key. A desk repository that reads without a login but that agents would push to only gets a one-line note naming the key, never a prompt. SSH remotes are left to your own SSH setup.
4. **Every source is read** (references, desk repositories, plugins, copied skills) with this host's git credentials before anything is cloned, and any that doesn't read stops setup with the likely cause: not logged in, no access, or organization SSO authorization.

`office check` reports the identity and, with `credentials: gh`, whether gh is logged in on the host, whether git there uses it, whether `mise.toml` pins gh and whether the running container's gh is logged in and git uses it. An office without `credentials: gh` isn't failed for it.

## First run

```sh
office init ~/my-office --name mine
cd ~/my-office
office setup
```

Setup offers host dependency installation before age identity or encryption work, then the office's commit identity and GitHub before cloning (see "Git and GitHub"). It asks before creating an age identity and asks for your Executor owner email; it never invents an email. For unattended setup, supply `--owner-email <email>`, `--install-deps` to authorize dependency changes and `--generate-age-key` if a new identity is needed; declare the identity and GitHub in `office.yaml`'s `git` block. Without `--install-deps`, unattended setup keeps working installed tools, reports available updates, and stops if a required tool is missing. Missing required input stops with guidance instead of waiting on stdin. Docker with a working daemon, Compose and Buildx, and Git remain separately installed prerequisites.

Cron activation follows the existing `up` behavior without another approval prompt: starting a template office runs its missed jobs, including jobs never run, which can update references and commit tool pin changes. `init` still creates files only; `up` still starts services only.

Setup preserves existing accounts and working instance-local tokens. Before creating an owner it proves SOPS encryption/recovery and saves the generated strong password encrypted in `secrets/executor-owner.enc.json`. The owner name is `<office name> owner`, and the organization name is the office name. Interrupted account creation resumes with that same record, never a new password. A different fresh Executor can reuse this encrypted owner record, but gets its own local API token. Existing instances without a valid token need the existing owner's encrypted login or an existing organization-bound token; setup never resets them.

In an interactive terminal the newly generated password is deliberately displayed once. Redirected/noninteractive setup output withholds it. Retrieve it explicitly later:

```sh
office executor credentials
office executor credentials --password-only | <clipboard-command>
```

Review and commit `.sops.yaml`, `office.yaml` and encrypted credentials yourself; setup never commits or pushes. Back up the age identity separately. Also run `pre-commit install` once per clone.

**Model authentication remains human-controlled.** With the optional Claude gateway below, setup connects Claude Agent without subscription login. Otherwise log Claude Code in, then connect Claude Agent in OpenCode (or use `/connect` and `/models` for another provider):

   ```sh
   docker exec -it office-mine-opencode-1 claude auth login
   P=$(grep OPENCODE_PASSWORD ~/.local/share/office/mine/secrets.env | cut -d= -f2)
   curl -u "opencode:$P" -X POST -H 'content-type: application/json' \
     -H 'x-opencode-directory: /home/office/workspace' -d '{"methodID":"claude-login"}' \
     http://127.0.0.1:41497/api/integration/claude-agent/connect/external
   ```

`office setup` deploys apps and runs checks. It makes no model request and does not verify a provider's billing or model access. `office pair` prints the next-step link for the desktop app or a browser.

OpenCode's API picks a session's folder from the `x-opencode-directory` header or the `location[directory]` query parameter; it ignores `?directory=` and falls back to its start folder.

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

## Portable secrets and the Claude gateway

`office setup` detects host mise, [SOPS](https://getsops.io/docs/installation/) and [age](https://github.com/FiloSottile/age/releases). For each tool it proposes the newest stable release published at least **three days** ago, resolved to an exact version before installation. This host onboarding policy is independent of `office.yaml` and the container's mise pin. Office reads mise's official GitHub release metadata and verifies its downloaded executable against the asset's SHA-256 digest. It then uses `mise latest <tool> --minimum-release-age 3d` with the GitHub backend for SOPS, age and, for an office that uses GitHub, gh (`github:cli/cli`), whose downloads mise verifies.

Setup shows installed and proposed versions and asks permission before changes. If mise itself needs installation or updating, that confirmation also covers the subsequent exact-version lookup and installation of SOPS and age. Declining keeps working installed tools. A missing tool stops setup with instructions; an older mise that cannot perform release-age lookup reports the required capability. A newer installed version is kept, even if its release is too recent to be an installation candidate. No command updates these dependencies automatically in the background.

Office-managed executables live in `$XDG_DATA_HOME/office/host-tools/bin`, defaulting to `~/.local/share/office/host-tools/bin`. Private mise install, cache, configuration and state directories live under `office/host-tools/mise`. Office compares the PATH executable with its managed copy on each invocation, uses the newer version, and prefers PATH on a tie. System and package-manager executables are never overwritten. Global mise selections and shell profiles do not change, and no shell activation or terminal restart is needed. `setup`, `up` and `executor credentials` resolve managed tools directly in future invocations. To run SOPS manually without adding this directory to PATH, use `~/.local/share/office/host-tools/bin/sops`, or the corresponding `$XDG_DATA_HOME` path.

You can instead install standalone releases with their published integrity checks, or use your package manager. Tested releases are mise **2026.11.8** (2026-11-13), SOPS **3.13.3** (2026-07-23), age **1.3.2** (2026-08-29) and gh **2.104.0** (2026-11-12). Automated host installation supports Linux and macOS on x64 and arm64; on Windows, use WSL. These remain host tools in container mode. Neither the age private identity nor a container SOPS installation is introduced.

Optional sources in `office.yaml` (existing offices without these stay unchanged):

```yaml
secrets:
  executor_owner: secrets/executor-owner.enc.json
claude:
  credential: secrets/claude.enc.json
  settings: claude/settings.json
```

Sources are relative to the office root, independent of the current desk or nested repository. The encrypted Claude JSON contains `{"token":"<gateway credential>"}`. Create/edit it with `sops secrets/claude.enc.json`; keep plaintext out of shell history. The separate, non-secret `claude/settings.json` is an office adapter configuration, **not an automatically loaded Claude settings file**:

```json
{
  "baseUrl": "https://gateway.example.com",
  "models": {
    "sonnet": "claude-sonnet-4-6",
    "opus": "claude-opus-4-6",
    "haiku": "claude-haiku-4-5"
  }
}
```

`models` is optional. Only `baseUrl` and these model aliases are supported; arbitrary Claude settings, environment, hooks and permissions are deliberately outside this adapter. The launcher delivers model aliases through Claude's supported `ANTHROPIC_DEFAULT_*_MODEL` environment variables, even when OpenCode disables settings discovery. Caller arguments (including model and policy flags) pass through unchanged.

The host identity normally lives at `~/.config/sops/age/keys.txt` (`$XDG_CONFIG_HOME` is honored). Standard SOPS identity selection, including `SOPS_AGE_KEY_FILE`, also works. `office setup --generate-age-key` creates a missing identity only with explicit consent, shows **only its public recipient**, and preserves any existing `.sops.yaml`. Multiple recipients are supported by normal SOPS rules:

```yaml
creation_rules:
  - path_regex: secrets/.*\.enc\.json$
    age: >-
      age1<first-public-recipient>,
      age1<second-public-recipient>
```

On a new computer, a newly generated identity **cannot** decrypt an existing office. Send its public recipient to an already-authorized host. There, add it to `.sops.yaml`, run `sops updatekeys secrets/claude.enc.json` and `sops updatekeys secrets/executor-owner.enc.json` for the sources in use, review/commit those encrypted files, and sync them to the new host. Use ordinary `sops <file>` for later edits; `updatekeys` changes enrollment, not the secret values. Keep authorized recovery identities backed up.

`office up` decrypts and validates all configured sources **before changing services**, never falling back to old runtime plaintext on failure. It atomically replaces `state/runtime/claude/gateway.json`. The host-only `runtime/` parent is mode 0700; its selected `claude/` child is 0755 and the runtime file 0444 so container uid 1000 can read it even when the host has another uid. Host users cannot traverse the private parent. Only that selected child directory is mounted read-only at `/run/office-claude`; mounting the directory rather than a single file makes atomic rotation visible. Keep state outside the repository and do not weaken the parent permissions.

No age key or SOPS executable enters the image or mounts. Executor owner plaintext stays in host memory and is never mounted. The Claude launcher sets the token/base URL only for its Claude child, then execs the real binary, preserving signals and exit status. Both direct `claude` and OpenCode's non-secret `OPENCODE_CLAUDE_PATH` use it; no token is put in global OpenCode environment, image layers or build arguments. Missing/malformed mounted credentials fail before Claude starts. Without `claude:` the launcher passes through to ordinary Claude login behavior.

After rotating with SOPS, run `office up`. Fresh Claude processes read the new credential; replace already-running Claude processes to rotate those too. The container remains the trust boundary: unrestricted agents able to read the selected mount can read its token. OpenCode provider plugins keep their own independent login configuration; this adapter does not wire or share their credentials.

Managed gateway delivery currently requires container mode. In host mode office refuses a configured gateway before changing services, rather than altering a shared host server. A host gateway needs a dedicated OpenCode process configured by its operator with `OPENCODE_CLAUDE_PATH` pointing at a host launcher; this release does not generate or validate that host adapter. Ordinary host-mode offices remain supported.

## Not yet

- Desks share one Executor token; scoped connections per desk need a browser sign-in from the container.
- Containers aren't blocked from the LAN.
