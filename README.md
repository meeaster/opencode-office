# opencode-office: the `office` tool

An **office** is a source-controlled folder of **desks** for OpenCode. The folder a session starts in decides what the agent knows and can do: every session loads the office root's instructions, config and skills, and a session in a desk also loads that desk's. Desks never load each other's.

This repository holds the `office` command, the template `office init` copies, the two plugins every office runs, the base image of the `opencode` container and the compose file for the two services every office runs:

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

An office keeps its own content: desks, skills, plugins, Executor apps, cron jobs and any extra services.

## Install

`office` is one executable that carries everything it needs: the template, the plugins and the image files. Put it on your PATH, such as at `~/.local/bin/office`; Docker is the only other requirement. `office --version` prints the version and the commit it was built from.

To build it from this checkout, with Bun and pnpm from `mise.toml`:

```sh
mise install
pnpm install
pnpm run install-office   # builds target/office and installs it as ~/.local/bin/office
```

`pnpm run build` only builds `target/office`. `bin/office` runs the CLI from the checkout with Bun, without building. `pnpm run typecheck` checks the CLI and the plugins.

## Commands

`office --help` lists them. Every command except `init` acts on the office in the current folder or above it, or on `--office <dir>`.

| Command | Does |
|---|---|
| `office init <dir> [--name <name>]` | Creates an office from `template/`: root files, a starter `office.yaml`, one example desk, `git init` |
| `office sync [--references]` | Clones and updates references and desk repositories, refreshes the office's copies of the tool's plugins (saying what it replaced), scaffolds declared desks that are missing, copies declared skills into `skills/` (recording the commit in `.source.json`), links enabled skills into each `.opencode/skills/`, clones declared plugins. It never writes to `AGENTS.md` or other hand-written files |
| `office check` | Reports drift between `office.yaml` and the folders, and plugin copies that differ from the tool's; when the containers run, also Executor's health, whether the container's `office` is the host's (`office --version`); for the root and each desk, on the mode's OpenCode server, its agents, its skills (expected loaded, the rest not) and its Executor connection; and the cron runner (supercronic in the container, or the host's timers) |
| `office instructions [folder]` | Prints the guidance the office plugin gives a session started in that folder, from the same code |
| `office up` / `office down` | Starts or stops the compose project `office-<name>`: `executor`, `opencode` (container mode only) and the office's own `compose.yaml`. In container mode `up` builds the base image with this `office` inside it, and the office's `Dockerfile` on top of it when there is one. In host mode `up` also installs the office's `mise.toml` tools with the host's mise and the cron timers; `down` removes the timers. See "Host mode" |
| `office apps deploy` | Deploys every app in `executor/apps/*` and `<desk>/executor/apps/*` from its files, creating apps that don't exist, and links the OpenCode account to each app that declares one. Each app's `office.ts` is replaced by one for the office's mode |
| `office upgrade-tools` | Bumps each exact pin in the office's own `mise.toml` files (root and desks) to the newest version released at least a day ago, installs it, and commits the changed files alone as `office cron`. See "Cron" |
| `office cron crontab \| catch-up \| run <command>` | The cron runner the container and the host's timers call; see "Cron" |

## Layout

| Path | What it is |
|---|---|
| `src/` | The CLI in TypeScript on Bun: `cli.ts` (arguments), `office.ts` (reads `office.yaml`), `layout.ts` (what the folders should hold), `tool.ts` (the tool's own files, its version, the image's build folder), `build.ts` (compiles the executable), `commands/` and `cron/` (`container.ts` for supercronic, `host.ts` for systemd timers). Its one runtime dependency is `yaml` |
| `bin/office` | Runs the CLI from the checkout with Bun |
| `plugins/` | The `office` plugin (the guidance for a session's folder, from `instructions.ts`, which `office instructions` also runs) and the `knowledge` plugin. `office sync` copies them into each office's `.opencode/plugins/`, where they stay committed so a clone works in the container |
| `template/office/` | What `office init` copies once: `AGENTS.md`, `README.md`, `office.yaml`, `.opencode/opencode.jsonc`, `skills/office/`, `executor/apps/opencode/`, `cron/`, `knowledge/`, `mise.toml`, `.gitignore` |
| `template/desk/` | What `office sync` scaffolds for a new desk, including its starter Executor app |
| `image/Dockerfile` | The base image: Debian 13 with OpenCode, Claude Code, mise and supercronic from checksum-pinned releases, build tools and the compiled `office`. User `assistant`, uid 1000 |
| `image/entrypoint.sh` | Writes the machine note to `/etc/opencode/machine.md`, installs the tools the office's `mise.toml` files declare, runs missed cron jobs and starts supercronic, then runs OpenCode |
| `image/config/opencode.jsonc` | The container's managed settings: no self-update, and the machine note as an instruction |
| `compose.yaml` | `executor` and `opencode` (in the `container` profile, which `office up` enables in container mode). Ports are on `127.0.0.1` only |

The executable embeds `template/`, `plugins/`, `image/` and `compose.yaml`. Docker can't read files inside it, so `office` unpacks `image/` and `compose.yaml` into `~/.cache/office/image-<hash of their content>/` and runs Docker from there; `office up` puts a copy of the executable in that folder for the image.

## Runtime

`office up` names the compose project `office-<name>` and sets:

| Variable | Value |
|---|---|
| `OFFICE_DIR` | The office, bind-mounted at `/home/assistant/workspace` |
| `OFFICE_STATE` | The office's runtime state: `office.yaml`'s `state`, else `~/.local/share/office/<name>` |
| `OFFICE_DESKS` | The desk names, for services such as a dashboard |
| `OFFICE_OPENCODE_IMAGE` | `office-opencode:<OpenCode version>`, or `office-<name>-opencode` when the office has a `Dockerfile` |
| `OFFICE_OPENCODE_URL` | OpenCode as containers reach it: `http://opencode:4096`, or in host mode the configured URL with a loopback host replaced by `host.docker.internal`. The office's own services (a dashboard API) use it |

The state folder holds:

| Path | Holds |
|---|---|
| `secrets.env` | `OPENCODE_PASSWORD` for the OpenCode server. In container mode `office up` creates it; in host mode it is the host server's password, which you put there (see "Host mode") |
| `opencode-executor.env` | `EXECUTOR_TOKEN`, OpenCode's own Executor token. `office apps deploy` uses it from the host too |
| `opencode-home/` | The container user's home: sessions, provider sign-ins, the Claude Code login, mise's tools |

Executor keeps its database and keys in the `office-<name>_executor-data` volume.

| Address | Serves |
|---|---|
| `http://localhost:41440` | Executor's dashboard. Use exactly this address: it must match `BETTER_AUTH_URL` |
| `http://127.0.0.1:41497` | OpenCode, for the TUI or web UI (user `opencode`, password from `secrets.env`) |

Override the ports with `EXECUTOR_PORT` and `OPENCODE_PORT`. Executor runs with `EXECUTOR_APPS_ALLOW_PRIVATE_FETCH=true`, so app code can reach `http://opencode:4096` or the host's server; every app in that Executor shares this.

Executor apps reach OpenCode through `opencode.ts`, which reads the server's address, its credential host and the office's folder as the server sees it from the app's `office.ts`. The committed `office.ts` holds container mode's values; `office apps deploy` sends one for the current mode instead. The OpenCode account's label records the host it was connected for (`OpenCode (<name> office at <host>)`), because Executor sends the password only to the hosts an account was connected with; when the mode changes the host, `office apps deploy` connects a new account and links it to every app.

The office's `.opencode/opencode.jsonc` connects sessions to Executor as the `office-executor` MCP server. Each value is `{env:...}` followed by `{file:...}`, so it comes from whichever exists: the container sets `OFFICE_EXECUTOR_URL` and `OFFICE_EXECUTOR_TOKEN`; in host mode `office up` writes the gitignored `.opencode/office-executor.url` and `.opencode/office-executor.token` (mode 600), and `office down` removes them.

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

In host mode, `office up` turns each job into a systemd user timer, `office-<name>-<script>.timer`, with `OnCalendar` in UTC and `Persistent=true`, whose service runs `office cron run <command>` from the office root with the PATH `office up` ran with (minus mise's per-version folders). systemd runs a job once when a scheduled time passed while the computer was off. Unlike container catch-up, a timer enabled for the first time waits for its first scheduled time. A job that restricts both the day of the month and the weekday has no timer equivalent, and `office up` refuses it. `office down` removes the units; never edit them by hand.

In the container, supercronic runs the crontab with each command wrapped in `office cron run`, which stamps the time of each success in `~/.local/state/office/cron/` (the home volume, not the office). When the container starts, `office cron catch-up` runs once, in order, every job whose most recent scheduled time is later than its last success, including jobs that never succeeded. That covers a computer that was off at the scheduled time.

The template ships two jobs:

- `cron/update-references.sh` (06:00): `office sync --references`.
- `cron/upgrade-tools.sh` (06:30): `office upgrade-tools`. For each exact pin in the root's and each desk's `mise.toml` (never a clone's), it asks `mise latest <tool> --minimum-release-age 1d` for the newest version at least a day old and installs it. Only after the install succeeds does it rewrite the pin. It skips a file with uncommitted changes, and keeps the old pin when an install fails. Changed files (and a `mise.lock` beside them, if the office uses one) go into one commit, such as `chore: bump node 26.13.1 → 26.14.0`, made as `office cron <office-cron@localhost>` through `git -c`, so no git config changes. It never pushes. It notifies the first desk's app (`notifications.send`) of what moved or failed, stays silent when nothing changed, and exits non-zero on a failure, so the job counts as missed and runs again at the next start.

## First run

```sh
office init ~/my-office --name mine
cd ~/my-office
office up
```

Then:

1. **Executor.** Open `http://localhost:41440` and finish the first-run setup. Create a token under **Account settings → Tokens**, named `opencode`, save it, and restart:

   ```sh
   (umask 077; echo "EXECUTOR_TOKEN=<token>" > ~/.local/share/office/mine/opencode-executor.env)
   office up
   ```

2. **A model.** Log Claude Code in, then connect OpenCode's Claude Agent provider to that login (or connect another provider in OpenCode's settings):

   ```sh
   docker exec -it office-mine-opencode-1 claude auth login
   P=$(grep OPENCODE_PASSWORD ~/.local/share/office/mine/secrets.env | cut -d= -f2)
   curl -u "opencode:$P" -X POST -H 'content-type: application/json' \
     -H 'x-opencode-directory: /home/assistant/workspace' -d '{"methodID":"claude-login"}' \
     http://127.0.0.1:41497/api/integration/claude-agent/connect/external
   ```

3. **Apps.** `office apps deploy`. It creates the OpenCode account in Executor from `secrets.env` and links it to every app that needs it.
4. **Check.** `office check`.

OpenCode's API picks a session's folder from the `x-opencode-directory` header or the `location[directory]` query parameter; it ignores `?directory=` and falls back to its start folder.

## Not yet

- Desks share one Executor token; scoped connections per desk need a browser sign-in from the container.
- Containers aren't blocked from the LAN.
