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

An office keeps its own content: desks, skills, plugins, Executor apps, cron jobs and any extra services. It also pins the versions of what runs in its containers (OpenCode, Claude Code, Executor and mise); see "Versions".

## Install

`office` is one executable carrying the template, bundled plugins and image files. Put it on your PATH, such as at `~/.local/bin/office`. Docker with Compose and Buildx, and Git, are host prerequisites. Portable encrypted secrets also need host SOPS and age; no Node/npm runtime is needed. `office --version` prints its version and build commit.

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

Updating `office` changes no office. Each office picks the new one up when you run, in it, `office sync` (refreshes the plugin copies, which you then commit), `office up` (in container mode, rebuilds the `opencode` image with the new `office`) and `office check` (confirms the container runs the host's `office`). `office up` keeps the OpenCode, Claude Code, Executor and mise versions the office last applied; only `office up --upgrade` applies newer ones from `office.yaml` (see "Versions"). In host mode the cron timers run the executable itself, so they use the new `office` straight away.

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
| `office init <dir> [--name <name>]` | Creates an office from `template/`: root files, a starter `office.yaml` at this tool's versions with its `office.lock`, one example desk, and a git repository on branch `main` |
| `office setup [--owner-email <email>] [--generate-age-key]` | Resumes onboarding after init or clone: checks prerequisites and secrets, syncs, starts Executor, bootstraps its owner and organization-bound local token, then starts OpenCode, deploys apps and checks. Human provider logins remain separate. `--generate-age-key` explicitly consents to creating a host identity/public recipient config |
| `office executor credentials [--password-only]` | Deliberately decrypts and reveals the stored owner login on the host, even with Executor stopped. Password-only writes exact password bytes, without a newline, for a clipboard pipe; it does not verify the live password |
| `office sync [--references]` | Clones and updates references and desk repositories, refreshes the office's copies of the tool's plugins (saying what it replaced), scaffolds declared desks that are missing, copies declared skills into `skills/` (recording the commit in `.source.json`), links enabled skills into each `.opencode/skills/`, clones declared plugins. It never writes to `AGENTS.md` or other hand-written files |
| `office check` | Reports drift between `office.yaml` and the folders, and plugin copies that differ from the tool's; the versions and whether `office.lock` matches, a warning for versions outside the range this tool was tested with and for a pending upgrade; when the containers run, also whether they run the applied versions, Executor's health, whether the container's `office` is the host's (`office --version`), whether every app is deployed for the `apps` framework Executor serves; for the root and each desk, on the mode's OpenCode server, its agents, its skills (expected loaded, the rest not) and its Executor connection; and the cron runner (supercronic in the container, or the host's timers) |
| `office instructions [folder]` | Prints the guidance the office plugin gives a session started in that folder, from the same code |
| `office up [--upgrade]` / `office down` | Starts or stops the compose project `office-<name>`: `executor`, `opencode` (container mode only) and the office's own `compose.yaml`. `up` runs the versions it last applied and prints what `office.yaml` has moved to since; `--upgrade` applies those (see "Versions"). In container mode `up` builds the base image with this `office` inside it, and the office's `Dockerfile` on top of it when there is one. In host mode `up` also installs the office's `mise.toml` tools with the host's mise and the cron timers; `down` removes the timers. See "Host mode" |
| `office pin` | Writes `office.lock` for the versions `office.yaml` pins, looking up any it doesn't already hold on GitHub or Executor's registry |
| `office pair [--origin <url>]` | Prints a one-time link that connects the OpenCode desktop app or a browser to the office's OpenCode server. It works once, within five minutes; the app stays signed in until the password changes. `--origin` replaces the address in the link |
| `office apps deploy` | Deploys every app in `executor/apps/*` and `<desk>/executor/apps/*` from its files, creating apps that don't exist, and links the OpenCode account to each app that declares one. It first type-checks every app against the `apps` framework Executor serves (with this executable acting as Bun) and sets each app's `apps` dependency to that version, deploying nothing if one fails. Each app's `office.ts` is replaced by one for the office's mode |
| `office upgrade-tools` | Bumps each exact pin in the office's own `mise.toml` files (root and desks), and the versions in `office.yaml`, to the newest release at least the office's minimum release age old, and commits the changed files alone as `office cron`. See "Cron" |
| `office update [--check] [--minimum-release-age <age> \| --version <release>]` | Replaces this `office` executable with a release from GitHub: the newest at least a day (or `<age>`) old and newer than this one, or exactly `<release>`. `--check` only reports. It changes no office; see "Updating" |
| `office cron crontab \| catch-up \| run <command>` | The cron runner the container and the host's timers call; see "Cron" |

## Layout

| Path | What it is |
|---|---|
| `src/` | The CLI in TypeScript on Bun: `cli.ts` (arguments), `schema.ts` (the shape of `office.yaml` and `office.lock`, shared with the office plugin), `office.ts` (reads `office.yaml`), `versions.ts` (pins, the lock, what was applied), `releases.ts` (release lookups on GitHub and the registry), `layout.ts` (what the folders should hold), `tool.ts` (the tool's own files, its version, the plugin bundles, the image's build folder), `build.ts` (compiles the executable), `commands/` and `cron/` (`container.ts` for supercronic, `host.ts` for systemd timers). Runtime dependencies: `yaml` and `valibot` |
| `bin/office` | Runs the CLI from the checkout with Bun |
| `plugins/` | The `office` plugin (the guidance for a session's folder, from `instructions.ts`, which `office instructions` also runs) and the `knowledge` plugin. Each is bundled with what it imports into one `index.js`, which `office sync` copies into each office's `.opencode/plugins/<name>/`, where it stays committed so a clone works in the container with nothing installed |
| `template/office/` | What `office init` copies once: `AGENTS.md`, `README.md`, `office.yaml`, `.opencode/opencode.jsonc`, `skills/office/`, `executor/apps/opencode/`, `cron/`, `knowledge/`, `mise.toml` (with pre-commit), `.pre-commit-config.yaml` (gitleaks), `.gitignore` |
| `template/desk/` | What `office sync` scaffolds for a new desk, including its starter Executor app |
| `image/Dockerfile` | The base image: Debian 13 with OpenCode, Claude Code and mise at the office's versions and checksums (build arguments), supercronic pinned by the tool, build tools and the compiled `office`. User `assistant`, uid 1000 |
| `image/entrypoint.sh` | Writes the machine note to `/etc/opencode/machine.md`, installs the tools the office's `mise.toml` files declare, runs missed cron jobs and starts supercronic, then runs OpenCode |
| `image/config/opencode.jsonc` | The container's managed settings: no self-update, and the machine note as an instruction |
| `compose.yaml` | `executor` (its image from the office's versions) and `opencode` (in the `container` profile, which `office up` enables in container mode). Ports are on `127.0.0.1` only |

The executable embeds `template/`, the plugin bundles, `image/` and `compose.yaml`. Docker can't read files inside it, so `office` unpacks `image/` and `compose.yaml` into `~/.cache/office/image-<hash of their content>/` and runs Docker from there; `office up` puts a copy of the executable in that folder for the image.

## Runtime

`office up` names the compose project `office-<name>` and sets:

| Variable | Value |
|---|---|
| `OFFICE_DIR` | The office, bind-mounted at `/home/assistant/workspace` |
| `OFFICE_STATE` | The office's runtime state: `office.yaml`'s `state`, else `~/.local/share/office/<name>` |
| `OFFICE_DESKS` | The desk names, for services such as a dashboard |
| `OFFICE_OPENCODE_IMAGE` | `office-opencode:<opencode>-claude<claude>-mise<mise>`, or `office-<name>-opencode:<the same>` when the office has a `Dockerfile`. The versions in the name keep offices on different versions from sharing an image |
| `OFFICE_EXECUTOR_IMAGE` | `ghcr.io/usefulsoftwareco/executor-selfhost:<version>@<digest>` |
| `OFFICE_OPENCODE_URL` | OpenCode as containers reach it: `http://opencode:4096`, or in host mode the configured URL with a loopback host replaced by `host.docker.internal`. The office's own services (a dashboard API) use it |

The state folder holds:

| Path | Holds |
|---|---|
| `secrets.env` | `OPENCODE_PASSWORD` for the OpenCode server. In container mode `office up` creates it; in host mode it is the host server's password, which you put there (see "Host mode") |
| `opencode-executor.env` | `EXECUTOR_TOKEN`, OpenCode's own Executor token. `office apps deploy` uses it from the host too |
| `opencode-home/` | The container user's home: sessions, provider sign-ins, the Claude Code login, mise's tools |
| `applied.json` | The versions `office up` last applied, and the highest OpenCode and Executor the office has run |
| `backups/` | What `office up --upgrade` saved before an upgrade: `<time>-executor-<version>.tar.gz` (Executor's data volume) and `<time>-opencode-<version>/` (OpenCode's database files) |

Executor keeps its database and keys in the `office-<name>_executor-data` volume.

| Address | Serves |
|---|---|
| `http://localhost:41440` | Executor's dashboard. Use exactly this address: it must match `BETTER_AUTH_URL` |
| `http://127.0.0.1:41497` | OpenCode, for the TUI or web UI (user `opencode`, password from `secrets.env`) |

Override the ports with `EXECUTOR_PORT` and `OPENCODE_PORT`. Executor runs with `EXECUTOR_APPS_ALLOW_PRIVATE_FETCH=true`, so app code can reach `http://opencode:4096` or the host's server; every app in that Executor shares this.

Executor apps reach OpenCode through `opencode.ts`, which reads the server's address, its credential host and the office's folder as the server sees it from the app's `office.ts`. The committed `office.ts` holds container mode's values; `office apps deploy` sends one for the current mode instead. The OpenCode account's label records the host it was connected for (`OpenCode (<name> office at <host>)`), because Executor sends the password only to the hosts an account was connected with; when the mode changes the host, `office apps deploy` connects a new account and links it to every app.

The office's `.opencode/opencode.jsonc` connects sessions to Executor as the `office-executor` MCP server. Each value is `{env:...}` followed by `{file:...}`, so it comes from whichever exists: the container sets `OFFICE_EXECUTOR_URL` and `OFFICE_EXECUTOR_TOKEN`; in host mode `office up` writes the gitignored `.opencode/office-executor.url` and `.opencode/office-executor.token` (mode 600), and `office down` removes them.

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

In host mode, `office up` turns each job into a systemd user timer, `office-<name>-<script>.timer`, with `OnCalendar` in UTC and `Persistent=true`, whose service runs `office cron run <command>` from the office root with the PATH `office up` ran with (minus mise's per-version folders). systemd runs a job once when a scheduled time passed while the computer was off. Unlike container catch-up, a timer enabled for the first time waits for its first scheduled time. A job that restricts both the day of the month and the weekday has no timer equivalent, and `office up` refuses it. `office down` removes the units; never edit them by hand.

In the container, supercronic runs the crontab with each command wrapped in `office cron run`, which stamps the time of each success in `~/.local/state/office/cron/` (the home volume, not the office). When the container starts, `office cron catch-up` runs once, in order, every job whose most recent scheduled time is later than its last success, including jobs that never succeeded. That covers a computer that was off at the scheduled time.

The template ships two jobs:

- `cron/update-references.sh` (06:00): `office sync --references`.
- `cron/upgrade-tools.sh` (06:30): `office upgrade-tools`.
  - For each exact pin in the root's and each desk's `mise.toml` (never a clone's), it asks `mise latest <tool> --minimum-release-age <age>` for the newest version at least that old and installs it; only after the install succeeds does it rewrite the pin, and a failed install keeps the old one.
  - For the four versions in `office.yaml`, it reads each project's newest hundred GitHub releases without a login, keeps the line the office runs (`v<semver>` tags for OpenCode, Claude Code and mise; Executor's `executor@2.…` pre-releases, not its v1 line), drops releases younger than the age, and takes the highest version, never a lower one than the pin. It confirms the release file, or Executor's image on ghcr.io, exists, then rewrites only those version lines in `office.yaml` and `office.lock`. A failed lookup (GitHub's rate limit, no network) skips that tool and is reported. It never rebuilds or restarts anything.
  - Ages come from `upgrades` in `office.yaml`: a tool's own, else `minimum_release_age`, else a day.
  - It skips a file with uncommitted changes (for the versions, `office.yaml` or `office.lock`). Changed files (and a `mise.lock` beside them, if the office uses one) go into one commit, such as `chore: bump opencode 2.3.0 → 2.4.0, node 26.13.1 → 26.14.0`, made as `office cron <office-cron@localhost>` through `git -c`, so no git config changes. It never pushes. It notifies the first desk's app (`notifications.send`) of what moved or failed, stays silent when nothing changed, and exits non-zero on a failure, so the job counts as missed and runs again at the next start.

## First run

```sh
office init ~/my-office --name mine
cd ~/my-office
office setup
```

Setup asks before creating an age identity and asks for your Executor owner email; it never invents an email. For unattended setup, install the prerequisites first, supply `--owner-email <email>`, and explicitly consent with `--generate-age-key` if needed. Missing required input stops with guidance instead of waiting on stdin. Cron activation follows the existing `up` behavior without another approval prompt: starting a template office runs its missed jobs, including jobs never run, which can update references and commit tool pin changes. `init` still creates files only; `up` still starts services only.

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
     -H 'x-opencode-directory: /home/assistant/workspace' -d '{"methodID":"claude-login"}' \
     http://127.0.0.1:41497/api/integration/claude-agent/connect/external
   ```

`office setup` deploys apps and runs checks. It makes no model request and does not verify a provider's billing or model access. `office pair` prints the next-step link for the desktop app or a browser.

OpenCode's API picks a session's folder from the `x-opencode-directory` header or the `location[directory]` query parameter; it ignores `?directory=` and falls back to its start folder.

## Portable secrets and the Claude gateway

Install [SOPS](https://getsops.io/docs/installation/) and [age](https://github.com/FiloSottile/age/releases) on the host PATH using their standalone releases and published integrity checks, or your package manager. Tested releases are SOPS **3.13.3** (2026-07-23) and age **1.3.2** (2026-08-29), both stable and older than a day. With mise already installed, `mise use --global sops@3.13.3 age@1.3.2` installs those exact versions. Office does not install tools silently.

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
