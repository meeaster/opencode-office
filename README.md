# opencode-office: the `office` tool

An **office** is a source-controlled folder of work for OpenCode and Claude Code. Every session in it loads the office root's instructions, config and skills; one started inside a working repository under `repos/` also loads that repository's own.

## Quick start

You need Linux x64, Docker with Compose and Buildx, and Git.

**With an AI agent** that can run terminal commands, such as Claude Code, OpenCode or Codex, paste this:

> Install the `office` tool and set up an office for me by following https://raw.githubusercontent.com/meeaster/opencode-office/main/INSTALL.md. Ask me the questions it lists before you run anything.

**By hand:**

```sh
curl -fsSL https://raw.githubusercontent.com/meeaster/opencode-office/main/install.sh | sh
office init ~/office --name <name>
cd ~/office    # edit office.yaml: add a git: identity, and the repos package for your working repositories
office setup
git add -A && git commit -m "Set up the office"   # setup never commits; on a fresh machine set a git identity first
```

[INSTALL.md](INSTALL.md) goes through the same steps with the decisions spelled out, and "First run" below covers setup's options.

This repository holds the `office` command, the template `office init` copies, the built-in packages (the `office` package every office runs among them), the base image of the `opencode` container and the compose file for the two services every office runs:

- **Executor** holds every service account and runs the office's schedules, webhooks and approvals. It always runs in a container.
- **OpenCode** serves the office, in one of two modes that `office.yaml` chooses:
  - **container** (the default): the office's `opencode` container, with the office mounted at `~/workspace`.
  - **host**: an OpenCode server on this machine. The office attaches to it by default; opt in to a managed background service on Linux with systemd.

  ```yaml
  opencode: container
  # or
  opencode:
    mode: host
    url: http://127.0.0.1:49374
  ```

An office keeps its own content: instructions, skills, plugins, Executor apps, cron jobs and any extra services. It also pins the versions of what runs in its containers (OpenCode, Claude Code, Codex, Executor and mise) and of Socket Firewall, which every package download goes through, and how old a release must be before package managers, mise or the upgrade job take it; see "Versions" and "Socket Firewall".

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

Updating `office` changes no office. Each office picks the new one up when you run, in it, `office sync` (updates the office's copies of the built-in packages, which stay out of Git), `office up` (in container mode, rebuilds the `opencode` image with the new `office`) and `office check` (confirms the container runs the host's `office`). `office up` keeps the OpenCode, Claude Code, Executor, mise and sfw versions the office last applied; only `office up --upgrade` applies newer ones from `office.yaml` (see "Versions"). In host mode the cron timers run the executable itself, so they use the new `office` straight away.

**Updating an office that already has packages:** retain the working executable (and the matching image in container mode) until package sync and a representative package command succeed. `office --version` identifies the build. If the new executable rejects the candidate, `.office/current` still identifies the active package set, and packages load from it only while every copy there passes this executable's checks. Fix the reported candidate and retry with the new executable. Update the host and container executables together (`office up`). A failed application *after* publication leaves the new generation active: fix the external delivery problem and rerun `office sync --packages`.

A missing discovery link is recreated. A file, directory or other link at `.office/packages` stops sync, which names it and changes nothing: move the entry aside and run `office sync --packages`.

#### Offices with desks

Earlier releases organized an office into desks: top-level folders declared under `desks:` in `office.yaml`, each with its own repositories in `<desk>/repos/`, scratch folder, instructions and Executor app. This release has none. Any command that reads `office.yaml` (sync, check, up, down, the sessions' office guidance and package text) refuses one that still has `desks:`, even empty, names the key and changes nothing; office never moves an owner's files.

To move an office off desks, outside the CLI and before running this release in it: move each working checkout into root `repos/<name>/` without recloning (`git worktree move` for a linked worktree, `git worktree repair` from the main checkout afterwards) and declare it under the [`repos` package](packages/repos/README.md), with its `url` when it has an origin; move a desk's Executor app from `<desk>/executor-apps/<slug>/` to `executor-apps/<slug>/`, keeping its slug, so `office apps deploy` updates the same app; move scratch work into root `scratch/`; fold a desk's `AGENTS.md`, `.opencode/` and `mise.toml` into the root's or a repository's own; name the app for job notifications under `executor.notifications`; make the office's `.gitignore` ignore `/repos/` and `/scratch/`; then delete `desks:`. Until then, keep running the office, `office down` included, with the executable it was made with: install the new one beside it rather than over it while any office still has desks. Sessions find `office` on their own PATH (see "Full-sync work, access and session text"): after the move, make sure the OpenCode server's PATH and the PATH Claude Code is launched with both reach the new executable for the moved office, and the old one for an office that still has desks. A session started before the move is history: resumed, it keeps the old paths and desk guidance it started with. Start a fresh session at the new path for the current context, rather than rewriting stored sessions.

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

`pnpm run build` only builds `target/office`. `bin/office` runs the CLI from the checkout with Bun, without building. `pnpm run typecheck` checks the CLI and the plugins; `pnpm test` runs the unit tests, `pnpm test:e2e` the end-to-end tests (`*.e2e.test.ts`, which run a compiled executable), and `pnpm test:all` both (launcher behavior tests also use host `jq`, already included in the container).

## Commands

`office --help` lists them. Every command except `init` and `update` acts on the office in the current folder or above it, or on `--office <dir>`.

| Command | Does |
|---|---|
| `office init <dir> [--name <name>]` | Creates an office from `template/`: root files, a starter `office.yaml` at this tool's versions with its `office.lock`, the built-in `office`, `knowledge` and `browser` packages (see "Packages") and a git repository on branch `main`, with git's pre-commit hook when this machine already has the office package's pre-commit (see "The office CLI's tools") |
| `office setup [--owner-email <email>] [--generate-age-key] [--install-deps] [--verbose]` | Resumes onboarding after init or clone: checks prerequisites and secrets, the office's commit identity and GitHub, reads every source, syncs, installs git's pre-commit hook, offers the office's system setup when something is pending (see "Tools"), starts Executor, bootstraps its owner and the office's organization-bound Executor key (see "The office's Executor key"), then starts OpenCode, deploys apps, runs the system setup's verify scripts, offers to restart a managed OpenCode server running with older settings, and checks. Human provider logins remain separate. `--generate-age-key` consents to creating a host identity/public recipient config. `--install-deps` authorizes installing mise and the versions of SOPS, age, gh and pre-commit the office pins (see "The office CLI's tools"). The identity and GitHub come from `office.yaml`'s `git` block; see "Git and GitHub" |
| `office executor credentials [--password-only]` | Deliberately decrypts and reveals the stored owner login on the host, even with Executor stopped. Password-only writes exact password bytes, without a newline, for a clipboard pipe; it does not verify the live password |
| `office sync [--packages \| --references] [--verbose]` | By default, clones and updates references and declared plugins and applies packages (their `sync` functions, such as the `skills` package's links, and their full-sync work, such as the `repos` package's checkouts), writing the mise tools they declare into `machine.packages.toml` (raising a version below what a package needs, and saying so) and their mise setup into `.office/mise/` (see "Tools"). Use `--packages` after changing package settings: it installs or restores packages at their declared pins, applies settings, tools, plugin links and panels, and skips unrelated Git checkouts. It still fetches a remote package when its pinned copy is needed. `--references` refreshes only references. |
| `office references list` | Load every selected package and show the name, URL, ref and claimant of each reference as `office.yaml` and the packages declare it now, without fetching. It can differ from what sync last applied until the next sync; `office check` compares desired origins with the actual Git checkouts. |
| `office skills list` / `office skills update` | The `skills` package's commands, when it is selected. `list` prints each standalone skill its sources offer, with its source and whether it is enabled; `update` moves each Git source with a `track` and relinks its enabled skills. See "Standalone skills" |
| `office packages update` | Moves each package from another repository that has a `track` to where it points now (a branch's newest commit, or the highest stable SemVer tag matching a pattern such as `v2.*`: of the tags whose name ends in `MAJOR.MINOR.PATCH`, the highest version compared as numbers, read with `git ls-remote`), records the full SHA as its `ref` and in `office.lock`, and applies the packages as `office sync` does (settings, packages' `sync` functions such as seeds, tools, plugin links). An untracked package whose `ref` is a tag or branch keeps its `ref`; its `office.lock` commit moves to where the ref points now, and the move is reported. A package whose track or ref resolves to nothing or whose new copy fails keeps its pin, lock entry and copy. It touches no reference, working repository or skill pin, and `office sync` applies pins without moving them. See "Packages" |
| `office seeds diff [<path>]` | The `seeds` package's command. For a seeded file that is pending (its package changed its seed, and the file differs from the seed office laid down), shows what the package changed (the stored seed against the package's seed now) and what you changed (the stored seed against your file), each from `git diff --no-index`, then two lines of guidance and the `office seeds settle` command. Without a path, lists the pending files. For a file that was already there, it compares your file with the package's seed and says this needs manual review; for a path that isn't pending, it says it is current. Paths are relative to the office's folder; quote one that holds a space. Writes nothing in the office. See "Seeds" |
| `office seeds settle <path>` | The `seeds` package's command. Records the package's current seed for a seeded file as dealt with, whether or not the file took its changes: stores the seed in `.office/seeds/`, then records its SHA-256 in `.office/seeds/receipts.json`. The file is left as it is; commit `.office/seeds/`. See "Seeds" |
| `office check` | Reports drift between `office.yaml` and the folders; one line per package (its kind and source, edits to a pulled-in copy, settings, its mise tools (missing from `machine.packages.toml`, or below the package's version) and mise setup, plugin, and the services its `compose.yaml` contributes: their problems, a pending upgrade and, when the office runs, whether they run) and per package panel; a tool in `machine.packages.toml` no package declares, and a warning for a `machine.toml` pin below a package's version; the office CLI's tools (whether this host has the versions `machine.packages.toml` pins, and a pin of one of them in the office's own files) and git's pre-commit hook (installed, registered, this office's build); a warning for a mise `minimum_release_age` setting the office's environment overrides; the versions and whether `office.lock` matches, a Git package whose `office.lock` entry is missing, doesn't match `office.yaml`, or names another commit than its installed copy, and an entry for a package no longer selected (each fixed by `office sync`); each package's own `check` function, such as the `seeds` package's: a receipts file it can't read, a warning for a receipt whose stored seed is missing, isn't a file or doesn't hash to its name, or that sync will drop, and one warning line counting pending seeds, `2 seeds pending; office seeds diff`, which never fails the check (see "Seeds"); warnings for pending upgrades and tested ranges (see "Versions"); when the containers run, also whether they run the applied versions, Executor's health, whether the container's `office` is the host's (`office --version`), whether every app is deployed for the `apps` framework Executor serves; for the root, on the mode's OpenCode server, its agents, its plugins (each package's, the `office` package's included, active) and its Executor connection; and the cron runner (supercronic in the container, or the host's timers); for managed OpenCode, the systemd unit, its server PID, pending restart and secret validation; in container mode, the weekly image refresh timer and a warning when the image's Debian packages are more than eight days old; last, for information and never a failure, what sessions load from outside the office (the global and system config folders, `~/.claude` and `~/.agents` skills, and config, `.opencode/` folders and `AGENTS.md` above the office, in the session's home: the host's, or in container mode `opencode-home/`), one line per item with its path and link target, skills and plugins as the server reports loading them when it runs, and a warning for an outside skill or plugin with the name of one the office provides, saying which loads |
| `office instructions [folder]` | Prints the guidance the `office` package's plugin gives a session started in that folder, from the same code |
| `office instructions --packages` | Prints the text the selected packages add to every new session (each definition's `session`), from the settings the last sync applied. The `office` package's OpenCode plugin and its Claude Code SessionStart hook both run it as a session starts; see "Full-sync work, access and session text" |
| `office opencode inspect [folder]` | Offline inventory of [office-wide and folder-local config and plugin sources](docs/opencode-sources.md), package links, declared plugin clones and observable desktop registration. Does not start OpenCode or check activation. |
| `office instructions --session <id>` | Reads all instruction entries currently stored on that session from the office's running OpenCode server. Prints each key and its full text, including entries written by custom plugins. These entries are one part of the model prompt. From a shell tool in an OpenCode session, use `office instructions --session "$OPENCODE_SESSION_ID"` |
| `office up [--upgrade] [--refresh] [--verbose]` / `office down` | Starts or stops the compose project `office-<name>`: `executor`, `opencode` (container mode only), the services packages contribute and the office's own `compose.yaml`. `up` runs the versions and package compose files it last applied; `--upgrade` applies pending changes. In container mode `up` builds the image and installs the weekly image refresh timer; `--refresh` rebuilds with current Debian packages. In host mode `up` installs Socket Firewall, mise tools and cron timers, and starts opted-in managed OpenCode; `--upgrade` queues a managed restart or takeover. `down` removes the timers and stops the managed server without removing its unit. See "Host mode" |
| `office shell` / `office exec -- <command...>` | A shell, or one command, in the running `opencode` container as its user, in the container folder matching the one you run it from (the office root or a folder in it, such as a working repository; else the office root), with the container's home and mise's tools. `exec` forwards stdin and the exit status, and a terminal when both ends are one, so it works in pipes. Neither starts or rebuilds anything; in host mode they say to run commands on the host |
| `office pin` | Writes `office.lock`'s runtime pins for the versions `office.yaml` pins, looking up any it doesn't already hold on GitHub or Executor's registry, and keeps its `packages:` section |
| `office pair [--origin <url>]` | Prints a one-time link that connects the OpenCode desktop app or a browser to the office's OpenCode server. It works once, within five minutes; the app stays signed in until the password changes. `--origin` replaces the address in the link |
| `office gui dev <package>` | While a local package's panel is being built, installs the bundle on the desktop app's machine each time the build writes it; see "Panels" |
| `office apps deploy` | Installs missing catalog apps and type-checks local apps against the framework Executor serves. It compares the files it would upload, including generated settings and framework pins, with each app’s active version. Matching apps report `unchanged`; only new or changed apps get a new version. Account links are checked either way |
| `office apps adopt <catalog-id>` | Copies an installed Executor catalog app's currently deployed source into `executor-apps/<catalog-id>/` for customization. Future deployments target that app in place |
| `office upgrade-tools [--commit] [--apply]` | Bumps exact pins in the office's `mise.toml` (the root's), `machine.toml`, `machine.packages.toml` and `office.yaml` to the newest eligible release (`tools.minimum_release_age`, or a runtime's own age). By default it updates your working copy, including files with local edits. `--commit` skips inputs with uncommitted changes and commits only upgraded files as the office's git identity, else `office cron`. Independently, `--apply` runs `office up --upgrade` if the bump succeeded, even if the pins were already current. Run `--apply` from a separate terminal because managed OpenCode can restart. |
| `office update [--check] [--minimum-release-age <age> \| --version <release>]` | Replaces this `office` executable with the newest eligible GitHub release newer than this one (default minimum age: `0d`), or exactly `<release>`. `--check` only reports. It changes no office; see "Updating" |
| `office cron list` / `office cron run <job-id>` | The `cron` package's: lists the ids of the jobs that apply, or runs one now, exiting with its script's status; see "Cron". `cron supercronic` and `cron catch-up` are the container's, which its entrypoint runs; catch-up starts `cron catch-up-job` in a fresh process per job |
| `office context --model <provider/model#variant>` | Measures the tokens the office adds to the first request of a session started in the current folder on the running host-mode OpenCode server. Repeat `--model` to compare models; see "Measuring what the office adds" |

### Measuring what the office adds

Run `office context` in the folder you want to measure. Pass at least one model in OpenCode's `provider/model` notation, optionally followed by `#variant`:

```sh
office context --model 'openai/gpt-6-luna#low' --model claude-agent/haiku
```

For each model, the command sends two real requests: one from a fresh empty folder outside the office and one from the current folder. It prompts each session with `Reply with exactly: OK`, counts input tokens including cache reads and writes, and deletes the session. It prints both totals and the difference, followed by each plugin instruction entry and its size in characters. If your `office.yaml` has a `context.models` setting, remove the `context` block and pass those models with `--model` instead.

A model whose request fails (for example a provider's "Insufficient balance") is reported with the provider's message, the others are still measured, and the command exits non-zero. Every probe session is titled `office context probe`; a run first deletes sessions with exactly that title, which an interrupted run left. It works only in host mode for now: in container mode the empty baseline folder would have to exist inside the container, and the command refuses.

### Native Claude Code in the office

In a [mise-activated shell](https://mise.jdx.dev/cli/activate.html), run `claude` from the office root or a nested repository. The office launcher runs the installed Claude Code in the same folder and adds `CLAUDE.md` and `AGENTS.md` discovery via Claude's built-in instruction plugin. The extra settings file applies only to that invocation; your normal user and project settings, plugins, and sign-in still apply. The office doesn't install Claude on the host, edit your Claude profile, or change `claude` outside the office. If you pass `--settings <file-or-json>` or `--settings=<file-or-json>` before `--`, your explicit settings take precedence: the launcher passes them through without adding the office file.

The launcher also loads the required `office` package's Claude plugin. Its session-start hooks give Claude the same repository-scoping guidance the package supplies to OpenCode (investigate at the root, then move the current session to the target repository before editing) and the text the office's packages add to every session (`office instructions --packages`, run with the first `office` on the PATH Claude Code was started with).

`office sync` maintains `.office/claude/bin/claude` and `.office/claude/settings.json`. New offices already expose the launcher in the root `mise.toml`. For an existing office, run `office sync` and add the following to the **office root's** `mise.toml`:

```toml
[env]
_.path = ["{{ config_root }}/.office/claude/bin"]
```

If `[env]` already exists, add only the `_.path` line there; if it already sets `_.path`, add the launcher directory to the existing list. Keep all other entries. Review and trust the changed file with `mise trust mise.toml` if mise asks. Remove the path entry to opt out.

### Refresh an office

Run `office refresh` to update tracked package pins and the `office.lock` commits of untracked packages whose `ref` is a tag or branch, run `office skills update` when the `skills` package is selected (its failure stops refresh), run a full sync (including references), start services with ordinary `office up`, then run `office check`. These stages run in order. Sync applies the package settings and integrations once, using the new pins. If a stage fails, later stages do not run; successful changes already made remain on disk for review. Use `office sync` instead to apply existing pins without moving them. `office refresh` does not upgrade the CLI or imply `office up --upgrade`.

### What progress commands print

`office check` and the final check in `office refresh` use Clack in a terminal: progress by area, totals, and the full warnings and failures. Use `--verbose` for every successful check and the outside-office inventory. When piped, `office check` keeps its original plain lines and exit status: warnings pass, failures exit nonzero.

`office setup`, `office sync` and `office up` show what runs now, in stages. Setup's are, in order: Tools, Secrets, Git and GitHub, This machine (host mode only), Repositories and packages, System packages, Services, Apps and Checks; `office sync` is the Repositories and packages stage alone and `office up` the Services stage alone. Each stage ends in one line with a short summary and its time.

- **In a terminal** (stdin and stdout both one), a running stage shows a spinner with its elapsed time. A slow command (a mise install, an image build, Compose) shows its last three lines under a stationary heading, refreshed at most ten times per second. Success clears the live lines; failure prints the recent output. Up to eight Git operations run at once under one progress line, at most four of them new clones. Successful results print together, while a failure appears immediately and keeps git's last lines. Questions are prompts. A few steps take the terminal for themselves and pause the display: the `gh auth login` browser login, the system packages step, where mise asks for your sudo password, and `office check` at the end of setup. Setup's closing next steps (`office pair`, the Executor dashboard, provider logins, the shell line) come in a box.
- **Without a terminal** (agents, cron, a pipe), it prints one plain line per event, `<stage>: <message>`, with no escape codes: `tools`, `secrets`, `git`, `machine`, `repos`, `system`, `services`, `apps`, `checks`. A command's output appears only when it fails (its last lines, prefixed `| `), or every line with `--verbose`, which also asks git for its progress. Nothing ever prompts: the flags answer, or the command stops naming the flag, as before. The closing steps are `next:` lines. A stop goes to stderr as `office <command>: stopped: <reason>`.

A failure stops the command with exit code 1; Ctrl+C stops it with 130 and stops the commands it started. Rerunning continues: setup skips what is already in place. `office sync` never lets git prompt for a login (it fails that source instead, naming git's error); `office setup` reads every source with your credentials before it syncs.

## Layout

| Path | What it is |
|---|---|
| `src/` | The CLI in TypeScript on Bun: `cli.ts` (arguments), `schema.ts` (the shape of `office.yaml`, `office.lock` and a package's `package.yaml`, shared with the `office` package's plugin), `office.ts` (reads `office.yaml`), `versions.ts` (pins, the lock, what was applied), `sfw.ts` (Socket Firewall: what is wrapped, the wrappers and the environment file), `host-env.ts` (a host-mode office's environment file and sfw folder), `host-tools.ts` (the programs the CLI runs on the host: its own mise, and the office package's tools), `hook.ts` (git's pre-commit hook in an office), `releases.ts` (release lookups on GitHub and the registry), `layout.ts` (what the folders should hold), `packages.ts` (the three kinds of package; installs, updates, restores and reads them), `package-services.ts` (the discovery and generated-secret adapter for the [standard Compose planner](standard/compose/README.md)), `package-system.ts` (a package's one-time machine setup: where it applies, its fragment part, its check), `desktop.ts` (installs package panels on the desktop app's machine), `timers.ts` (the office's systemd user timers: the image refresh timer and packages' `host.timers`), `package-shutdown.ts` (packages' part of `office down`), `tool.ts` (the tool's own files, the built-in packages as offices get them, its version, the image's build folder), `report/` (how setup, sync and up show progress: one reporter, a Clack renderer for a terminal and plain lines otherwise), `build.ts` (compiles the executable), `vendor-artifact-share.ts` (regenerates the libraries the artifact-share package carries, from pinned devDependencies), and `commands/` (office workflows). Runtime dependencies: `yaml`, `valibot` and `@clack/prompts` |
| `bin/office` | Runs the CLI from the checkout with Bun |
| `template/office/` | What `office init` copies once: `AGENTS.md`, `README.md`, `office.yaml`, `.opencode/opencode.jsonc`, `executor-apps/opencode/`, `mise.toml` (node), `machine.toml` (empty, the office's own; `office sync` writes `machine.packages.toml` beside it), `.pre-commit-config.yaml` (gitleaks), `.gitignore` |
| `packages/` | The packages that ship with the CLI, embedded in the executable (see "Packages"): the core packages every office has, `tooling`, `mise-integration`, `office`, `references`, `seeds` and `cron` (scheduled jobs, which the CLI's container code reads through `src/container-schedule.ts`), and the official ones an office lists, `knowledge`, `artifact-share`, `design`, `browser`, `aws-emulator`, `repos` and `skills`. `packages/office/plugin/` is the source of the `office` package's plugin, with `instructions.ts`, which `office instructions` also runs; offices get it bundled with what it imports into one `plugin/index.js` |
| `image/Dockerfile` | The base image: Debian 13 with OpenCode, Claude Code, mise and Socket Firewall at the office's versions and checksums (build arguments), sfw's wrappers (`office sfw-wrappers`), supercronic pinned by the tool, build tools, Chromium (with `AGENT_BROWSER_EXECUTABLE_PATH` pointing agent-browser at it) and the compiled `office`. Its apt layer upgrades Debian's packages as of the office's last refresh (the `APT_REFRESH` build argument). User `office`, uid 1000 |
| `image/entrypoint.sh` | Writes the office's environment file to `/etc/opencode/env.sh` (`office env --container`: Socket Firewall's wrappers first on PATH unless switched off, the office's release ages for package managers and mise) and sources it, writes the machine note to `/etc/opencode/machine.md`, links the office's `machine.packages.toml`, the packages' fragments in `.office/mise/` and `machine.toml` into mise's global conf.d in the home volume, installs the tools they and the office's root `mise.toml` declare, runs missed cron jobs and starts supercronic, then runs OpenCode |
| `image/config/opencode.jsonc` | The container's managed settings: no self-update, and the machine note as an instruction |
| `compose.yaml` | `executor` (its image from the office's versions) and `opencode` (in the `container` profile, which `office up` enables in container mode). Ports are on `127.0.0.1` only |

The executable embeds `template/`, the built-in packages as offices get them (staged by `src/build.ts` in `target/packages/`, with the `office` plugin bundled), the licence, `image/` and `compose.yaml`. Docker can't read files inside it, so `office` unpacks `image/` and `compose.yaml` into `~/.cache/office/image-<hash of their content>/` and runs Docker from there; `office up` puts a copy of the executable in that folder for the image.

## Runtime

`office up` names the compose project `office-<name>` and sets:

| Variable | Value |
|---|---|
| `OFFICE_DIR` | The office, bind-mounted at `/home/office/workspace` |
| `OFFICE_STATE` | The office's runtime state: `office.yaml`'s `state`, else `~/.local/share/office/<name>` |
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

`office.yaml`'s `tools` block pins what runs in the office's containers and says how old a release must be before anything takes it. The CLI supplies the versions a new office starts at. These are separate from the `office` executable's own version, which `office update` changes (see "Updating").

```yaml
tools:
  minimum_release_age: 3d          # package managers, mise and its tools, and every runtime below without its own
  opencode: { version: 2.3.0, minimum_release_age: 0d }
  claude: 2.1.322                  # just a version: inherits the age above
  codex: 0.170.0
  executor:                        # the block form is equally valid
    version: 2.0.0-beta.49
    minimum_release_age: 7d
  mise: 2026.11.7
  sfw: { version: 1.16.0, enabled: false }    # Socket Firewall; only sfw has enabled (default true)
```

- `minimum_release_age` is one age, `3d` when `office.yaml` sets none (or has no `tools` block). It is an age as mise writes one: hours, days or weeks (`36h`, `1d`, `2w`); `0d` means no wait. It applies to the package managers and mise through the office's environment file (see "Socket Firewall"), and to the pins `office upgrade-tools` bumps in the office's mise files (see "Cron"). There are no per-tool ages for mise tools.
- The runtimes are `opencode`, `claude`, `codex`, `executor`, `mise` and `sfw`. Each is a version, or a mapping of `version` and `minimum_release_age`, its own age for `office upgrade-tools`; without one it takes the general age. A mapping without `version`, or a runtime left out, runs this tool's default version. Any other key under `tools` or in an entry is an error naming it.
- An office that pins no runtime's version runs this tool's defaults, `office check` says so, and `office upgrade-tools` leaves them. Supercronic, the Debian base image and Bun stay pinned by the tool.

- `office.lock` is committed and written only by the tool. Its runtime pins, written by `office pin` (and `upgrade-tools`), hold the SHA-256 of each release file the image downloads (OpenCode's, Claude Code's, mise's and sfw's linux-x64 assets, as GitHub reports them) and Executor's image digest. sfw publishes no checksum file of its own, so its entry holds GitHub's digest of each file, recorded when pinned, and also `platforms`, the digests of the linux-x64, linux-arm64, darwin-x64 and darwin-arm64 files a host-mode office installs from. An `office.lock` from before sfw was pinned reads with the tool's default sfw, and `office sync` adds `sfw` to an old `versions` block and its entry to the lock once. Change a version by hand, then run `office pin`. A lock that doesn't match `office.yaml` stops `office up --upgrade` and fails `office check`, naming `office pin`. Its `packages:` section, written by `office sync` and `office packages update`, locks each Git package's commit; each writer keeps the other section as it is, and refuses to rewrite a file whose other section it can't read. Every command that reads `office.lock` refuses a top-level key that is neither a runtime pin nor `packages`, naming it, and nothing rewrites the file while one is there: a full sync stops before it writes anything. Seed receipts are not in `office.lock`; the `seeds` package keeps them in `.office/seeds/receipts.json` (see "Seeds"). An office whose lock still has the `seeds:` section an earlier release wrote must move it first, with the adoption step that release's notes give.
- `office up` runs what it last applied (`applied.json` in the state folder), so a bump the daily job records changes nothing until someone runs `office up --upgrade`. That prints the changes, refuses an older OpenCode or Executor than the office has run (their data only migrates forward), stops what changes and backs it up into `backups/`, builds and starts the new versions, and after an Executor upgrade runs `office apps deploy` so every app matches its `apps` framework.
- `office check` warns, without failing, when an upgrade is pending or a pin for a tool the mode applies (other than Executor) falls outside the CLI's tested range. For Executor, it checks the pin against the lock, the running image against the applied pin, service health, and deployed apps against the framework Executor serves.
- Debian's packages are not pinned, and in container mode a weekly timer refreshes them; see "Image refresh".
- In host mode the pins apply to Executor and, while Socket Firewall is on, sfw. The managed-host cron job updates the host's agent CLIs through their native launchers. An unmanaged host updates its own CLIs. `office check` notes the host's OpenCode version and the tested range if different; that is not a warning.

## Host mode

1. Put the host server's password in the state folder. For the OpenCode background service:

   ```sh
   mkdir -p <state> && (umask 077; echo "OPENCODE_PASSWORD=$(opencode service get password)" >> <state>/secrets.env)
   ```

2. `office setup` once, which asks whether the office may manage this machine (see "Machine"); `--manage-machine` says yes unattended. Or, for an office set up before host mode, `office setup --manage-machine` then `office sync`.
3. `office up`. It starts `executor` and the office's own services, removes an `opencode` container left from container mode, writes the MCP files above, installs Socket Firewall (see "Socket Firewall"), runs `mise trust` and `mise install` (through sfw) for the root's `mise.toml`, then `mise install` from `/` for the office's machine-wide tools (`machine.packages.toml`, `.office/mise/` and `machine.toml`, through their links; it says what to run when there are none), and installs the cron timers.
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

The container installs Codex from the full Linux package at `tools.codex` (`versions.codex` in an office.yaml from before `tools`), verifying its checksum from `office.lock`. Existing offices without a Codex pin start at the CLI's default; `upgrade-tools` writes the explicit pin on the first bump. To take a stable release immediately, set its version, run `office pin`, then apply it with `office up --upgrade`.

To run the same job on demand, use `office cron run package.office.update-agent-clis` from a separate terminal, not from a terminal owned by the managed server. To reschedule or disable it, override it in the cron package's settings, `- { name: cron, settings: { overrides: { package.office.update-agent-clis: { schedule: '15 9 * * *' } } } }` or `{ enabled: false }`, and run `office up`. Disabling the job leaves the shared auto-update policy in place, and stops only the scheduled run: `office host-agent-cli-update`, run directly, still updates on a managed host.

Only an OpenCode version mismatch or a verified client takeover triggers reconciliation; a Claude-only change leaves the server alone. The updater verifies the registered version and systemd PID after a restart. Session records persist, but an active prompt or persistent terminal can be interrupted. A connected client using automatic discovery can compete to start a server; the updater attempts at most one verified takeover and reports a failure if it cannot reclaim the address safely. An explicitly attached client (`opencode --server <managed URL>`, with its normal password environment) does not start a competitor. Check the timer's service journal if a run fails.

- **Start and check.** Plain `office up` starts a stopped service and leaves a healthy one running. `office down` stops the cron timer and managed service and prevents the installed unit from starting again before `office up`. If the unit, `env.sh` or encrypted secrets have changed, `up` reports a pending restart. `office check` compares the unit to what the office would write, reports whether it is enabled and active, verifies that the server PID is the unit's PID, and checks encrypted secrets.
- **Take over.** Plain `office up` refuses if a registered service is running outside the unit or the old `opencode-serve.service` is active. Disable any old supervisor and its restart timer yourself: the office does not disable or delete units it didn't write. `office up --upgrade` takes over the verified local OpenCode background service; another listener must be stopped by its owner. Restart is queued in systemd, so it finishes even when called from an OpenCode session that is disconnected. Saved sessions survive; open terminals and in-flight work may not.
- **Recover after an OpenCode client restart or upgrade.** A TUI or desktop client may replace the server outside the unit and that replacement won't get office settings or secrets. `office check` detects it; `office up --upgrade` returns ownership to systemd. Use the same OpenCode version for the server and clients. Use `office down`, not `opencode service stop`, to stop the unit; systemd may restart a process stopped from outside. Remove `managed` and its associated `env_commands` and `secrets.server`, then `office sync` to stop, disable and remove the unit, or run `office sync --release-machine` to release all machine files. Use a separate terminal when removing a running unit.

`opencode.env_commands` is optional. Each command runs through `/bin/sh` in the office root before secrets are decrypted. The office's absolute gh is used for direct `gh` calls when available. Trimmed stdout becomes the variable. On failure the variable is left unset and the journal names the variable, not either output stream, so a logged-out gh need not keep OpenCode down. Put commands here, not literal credentials.

## Socket Firewall

[Socket Firewall](https://github.com/SocketDev/sfw-free) (`sfw`) runs a package manager behind a local proxy that refuses packages Socket has confirmed as malicious, at any depth of the dependency tree. Every office uses it unless `office.yaml` turns it off, in both modes, with `enabled: false` in sfw's entry:

```yaml
tools:
  sfw: { version: 1.16.0, enabled: false }
```

- **Wrappers.** `npm`, `npx`, `pnpm`, `pip`, `pip3`, `uv`, `uvx` and `cargo` are links to one script in a folder first on PATH. It drops its folder from PATH, so sfw finds the real command, and runs `sfw <command>`; a nested call (an npm script running npm) reaches the real command behind the same proxy, and `OFFICE_BEHIND_SFW=1` keeps a wrapper reached again from starting a second sfw. The folder's `mise` runs `mise install`, `use` and `upgrade` behind sfw, `reshim` without the folder (so mise points its shims at the real mise) and anything else as the real mise under the name it was called by, which mise's shims and `mise activate` rely on. Wrappers, not aliases, so agents' non-interactive shells are covered too. `src/sfw.ts` is the one list.
- **Release ages.** The environment file makes package managers and mise take only releases at least `tools.minimum_release_age` old (`3d` by default), with the firewall on or off, each in its own unit. For `3d`: `NPM_CONFIG_MIN_RELEASE_AGE=3`, `pnpm_config_minimum_release_age=4320`, `UV_EXCLUDE_NEWER="3 days"`, `PIP_UPLOADED_PRIOR_TO=P3D` and `MISE_MINIMUM_RELEASE_AGE=3d`. npm and pip count whole days, so an age in hours rounds up to the next day and never waits less (`36h` is `2` and `P2D`); pnpm takes minutes, uv `36 hours`, mise the age as written. With `0d`, npm and pnpm get `0` (pnpm otherwise waits a day of its own), mise `0d` (which turns off its own one-day default), and uv and pip, which wait for nothing unless told, get no variable. mise's variable overrides a `minimum_release_age` under `[settings]` in any mise config file, so the office's age applies wherever the office's environment is loaded; `office check` notes a different one in the office's `machine.toml` or `mise.toml`, and a package can't set any of these variables. npm older than about 11.10 ignores its variable with a warning (11.6.2 does, 11.20.0 doesn't), uv before relative durations rejects `3 days` (0.9.5 fails, 0.13.8 works), and pip before 26 has no `PIP_UPLOADED_PRIOR_TO`: pin current ones.
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

Scheduled jobs are the core `cron` package's. Packages declare theirs; the office adds its own and changes packages' in the cron package's settings. A core package need not be listed in `office.yaml`; list it once to configure it:

```yaml
packages:
  - name: cron
    settings:
      jobs:
        daily-report: { schedule: '0 6 * * *', script: cron/daily-report.sh }
      overrides:
        package.office.upgrade-tools: { enabled: false }
        package.office.update-references: { schedule: '0 5 * * *' }
```

Schedules are five-field UTC cron expressions or time macros such as `@daily`. A script is a regular `.sh` file, given as a plain relative path inside its declaring package (or the office folder, for the office's own jobs), reached through no symlink. Every job runs under `/bin/sh` from the office root, with `OFFICE_CRON_COMMAND` set to the `office` that runs it. `office cron list` prints the ids, one per line: `office.<name>` for the office's own jobs, `package.<package>.<name>` for a package's. `office cron run <job-id>` runs one now and exits with its script's status. Keep a job's name when renaming its script: the id, which names its timer and its success stamp, follows the name.

`jobs` are the office's own; they have no overrides, so edit them. `overrides` are keyed by a package job's id and can set `schedule`, `enabled` or both. An override naming a job no selected package declares (one of a package since deselected, say) is an error, as is one naming the office's own job.

A package declares a job in its `setup` with `cron.add` from `@office/cron`, listing `@office/cron` under `office.dependencies` in its `package.json`. For example, in `packages/reports/office.ts`, with `printf 'report from %s\n' "$PWD"` in `packages/reports/scripts/report.sh`:

```ts
import { cron } from "@office/cron";
import { Package } from "@office/sdk";

export default Package.define({
  settings: { type: "object", additionalProperties: false, properties: { enabled: { type: "boolean", default: true, description: "Schedule the report" } } },
  setup(ctx) {
    if (ctx.settings.enabled) cron.add(ctx, { name: "report", schedule: "15 9 * * *", script: "scripts/report.sh", when: "host" });
  },
});
```

`when` is `host` (which covers a managed host), `managed-host` or `container`; without it the job runs in every mode. A job for another mode is still declared, so an override for it is accepted, and `enabled: true` doesn't make it run. A job a package wants only when one of its settings is on is simply not added; its name is then not declared, so an override for it is an error. A name is at most 48 lowercase letters, digits and dashes, and unique within its package.

**Where a mistake is found.** A declared job's shape, name, schedule or script path is checked by the jobs registry's parser, and the cron package's settings by its schema: either way `office sync` fails before it switches the package set. A script that isn't there, an override for an unknown job, or a host schedule a timer can't express is found by the cron package's `sync`, after the switch: sync exits 1 naming the package and the job. A disabled job and one for another mode are checked all the same.

**When a schedule takes effect.** `office sync` checks every job and changes no timer. `office up` installs, updates and removes timers; until then `office check` reports the difference. A job's eligibility is read when its timer fires, so one disabled since the last `up` doesn't run.

**A broken package stops every job.** `office cron run`, like every package command, loads every selected package, the office's own jobs included: while one fails to load, every scheduled run fails naming it, until it is fixed or removed from `office.yaml`. `office check` names it.

In host mode, `office up` installs a systemd user timer and service per job, named `office-<name>-cron-<job-id>`, with UTC `OnCalendar` and `Persistent=true`; the service runs `office --office <dir> cron run <job-id>`. An existing timer catches up once after a missed interval; one enabled for the first time waits for its first scheduled time. A host schedule can't restrict both the day of the month and the weekday, since a timer can't express cron's either-day rule. `office down` removes them through the cron package's `down`, even with another package broken; if the cron package itself can't load, its timers stay installed, `office down` says so and exits 1, and the office's own shutdown still completes. `office check` names a timer that is missing (a job's service left without its timer included), inactive, on another schedule or no longer wanted, and a leftover service no job wants.

In container mode, the entrypoint runs `office cron supercronic`, which prints the crontab for Supercronic (in UTC, numeric, no paths), then `office cron catch-up`, then Supercronic; both commands refuse on a host. Catch-up takes the job ids once and runs each job in a fresh process, `office cron catch-up-job <office> <id>`, which reads the packages as they are then, skips an id no longer enabled, and runs the job unless its last success is at or after its latest due minute (a stamp that doesn't read as a time is no success): a job that publishes a new package set is seen by the next, which loads that set. Successes leave a stamp per job id under `$XDG_STATE_HOME/office/cron/<office>` (by default `~/.local/state/office/cron/<office>` in the home volume); a failed script leaves none and doesn't stop the others. Starting a container-mode office removes every host timer of the office before the container starts. `office up` passes the container a hash of the crontab, so a changed schedule recreates it; `office check` compares the running container's with the jobs as they are now and reports a Supercronic that isn't running.

The required `office` package supplies these daily jobs in both modes (plus `package.office.update-agent-clis` on managed hosts):

- `package.office.update-references` (06:00 UTC): `office sync --references`.
- `package.office.upgrade-tools` (06:30 UTC): `office upgrade-tools --commit`.
  - Up to three runtime release checks run at once. Office caches GitHub release pages under `release-pages/` in the office state directory and checks each page with GitHub on every run. An unchanged page needs no download; if GitHub is unavailable, the lookup still reports a failure. Minimum release ages are evaluated at the time of the run.
  - For the root's `mise.toml`, `machine.toml` and `machine.packages.toml` (never a clone's), it checks the file's requests together with `mise outdated --bump --json` and the office's `MISE_MINIMUM_RELEASE_AGE`. It leaves ranges alone and installs each eligible upgrade before rewriting its exact pin, keeping the rest of the line (`machine.packages.toml`'s package comment included). A failed install keeps the old pin.
  - For the runtimes' versions in `office.yaml`, it reads each project's newest hundred GitHub releases without a login, keeps the line the office runs (`v<semver>` tags for OpenCode, Claude Code, mise and sfw; Executor's `executor@2.…` pre-releases, not its v1 line), drops releases younger than the age, and takes the highest version, never a lower one than the pin. It confirms the release file, or Executor's image on ghcr.io, exists, then rewrites only those version lines in `office.yaml` and `office.lock`. A failed lookup (GitHub's rate limit, no network) skips that tool and is reported. It never rebuilds or restarts anything.
  - A runtime waits its own `minimum_release_age` under `tools`, else `tools.minimum_release_age`; every mise tool waits `tools.minimum_release_age`, the age its package manager waits in the office's environment, so mise never picks an `npm:` or `pipx:` version that pnpm or pip then refuses. pnpm also checks each dependency's age, so a release old enough can still pull in a newer dependency it refuses: that install fails, the job reports it, and the pin stays.
  - It rewrites only the version of each entry, in whichever form it is written (`claude: 2.1.327`, `{ version: …, minimum_release_age: … }` or the block form), keeping comments, quotes and order; a runtime the block doesn't list yet is added at its end. In an office.yaml from before `tools` it bumps `versions`.
  - It skips a file with uncommitted changes (for the versions, `office.yaml` or `office.lock`). Changed files (and a `mise.lock` beside them, if the office uses one) go into one commit, such as `chore: bump opencode 2.3.0 → 2.4.0, node 26.13.1 → 26.14.0`, made as the office's git identity from `office.yaml`, else `office cron <office-cron@localhost>`, through `git -c`, so no git config changes. It never pushes, even when the office has GitHub credentials. The job logs upgrades and failures and exits non-zero on a failure, so it counts as missed and runs again at the next start.

## Image refresh

The base image pins Debian by digest, so its packages, Chromium among them, only get security fixes when the image's apt layer is rebuilt. Docker reuses that layer while its inputs stay the same, so `office up` passes the time of the office's last refresh (`refreshed` in `applied.json`) as the `APT_REFRESH` build argument. `office up --refresh` records a new time, which rebuilds the layer with `apt-get upgrade` and current packages, rebuilds the office's own `Dockerfile` on top, and restarts the `opencode` container on the versions last applied; it never applies `office.yaml`'s newer ones. Any other `office up` keeps the last refresh's packages, so a rebuild never falls back to older ones. It notifies the Executor app `executor.notifications` in `office.yaml` names (through its `notifications.send`) with the Chromium version it moved to, or why it failed; without one, or when Executor can't be reached, it logs the message instead.

The container can't rebuild itself, as it has no Docker socket, so in container mode `office up` installs a systemd user timer on the host, `office-<name>-refresh-image.timer`, which runs `office up --refresh` on Sundays at 07:00 UTC with `Persistent=true`, the PATH and the `*_PORT` variables `office up` ran with. OpenCode resumes a session whose turn the restart interrupted; a shell command it was running is lost. On a machine without a systemd user manager, `office up` says so and `office check` warns; run `office up --refresh` yourself. `office check` warns when the last refresh is more than eight days old.

## Standalone skills

The official `skills` package delivers **standalone skills**: skill folders the office chooses by ID, linked into the root's `.agents/skills/<id>`, where every session in the office, inside a working repository too, finds them. Selecting a source offers its skills; only the IDs under `enabled` are linked. A skill a package's OpenCode plugin registers is that plugin's, not a standalone skill (see [registering assets](docs/opencode-authoring.md)).

```yaml
packages:
  - name: skills
    settings:
      sources:
        - folder: skills                     # each child folder holding a SKILL.md, by folder name
        - repo: https://github.com/example/agent-skills.git
          ref: 0123456789abcdef0123456789abcdef01234567  # the full commit sync uses; office skills update moves it
          track: 'v2.*'                      # optional: a branch such as main, or a pattern of stable SemVer tags
          skills:
            - { name: review, path: engineering/review }  # linked as .agents/skills/review
      enabled: [review]
```

A skill comes from one of three sources, and its ID is what it is linked as:

| Source | Offers | ID |
|---|---|---|
| A package's `skills.add(ctx, { directory })`, from `@office/skills` in its `setup` | That one folder of the package; the package declares `@office/skills` as a dependency | The folder's last part |
| `{ folder }` | Each child folder of that office folder holding a `SKILL.md`; no folder is scanned unless a source names it | The child's name |
| `{ repo, ref, track?, skills }` | Each named folder of the repository at the commit `ref` | Its `name` |

- An ID is lowercase letters and digits joined by single dashes. `office skills list` prints one row per offer, sorted, with its ID, source and `enabled` or `available` (`conflicting` when two sources offer one ID, and an enabled ID no source offers gets its own row). It reads the settings and the packages as they are now, fetches and writes nothing, and says on standard error when a Git source isn't fetched yet.
- `office sync` fetches each Git source's commit into `.office/skills/git/` once, then uses that checkout offline; it never moves a pin. A Git source listed under `sources` is fetched and checked even when none of its skills is enabled, so every source the settings name is one sync can resolve and verify. It links each enabled skill's whole folder, supporting files included, with a relative link that works on the host and in the container. A skill a pulled-in package offers is linked through `.office/packages/<name>/`, which follows the published package set, so its link outlives the generation it was made in.
- What the package linked is recorded in `.office/skills/links.json`, which isn't committed, and only those links are its own: sync replaces or removes a recorded link only while its target is still the recorded one. A link someone changed is the owner's from then on, and a manual skill in `.agents/skills/` is never touched. Only a missing record counts as empty: one that isn't a file, doesn't read, or records anything but links at `.agents/skills/<id>` stops sync, naming it. Each managed link is named in the exclude block by its exact path (see "Office's plumbing stays out of Git"); `.agents/skills/` itself is never excluded, so your own skills there are committed.
- Before changing any link, sync checks every enabled skill and every folder a Git source names, enabled or not, following links to where they really are: an ID two sources offer, an enabled ID no source offers, a folder whose `SKILL.md` isn't a regular file inside it or that leads outside its source, and a destination already taken by something it didn't record (a folder, a file, a dangling link, or its own link after the receipt was lost) each stop the sync, naming the ID, the sources or the path. No link changes then, and the rest of that sync (plugin links, panels, clones, the exclude block) doesn't run; what ran before it stays done. The one thing such a sync still changes is the exclude block's line for each recorded link that is no longer the package's (gone, or replaced by the owner): that line goes at once, before any fetch, so Git shows what the owner put there even when a Git source can't be fetched. `office skills update` releases those lines the same way before it resolves a track or fetches. `office check` reports the same problems, any missing or stale link, and a Git source's cached checkout that isn't at its pinned commit, and neither fetches nor changes anything.
- `office skills update` moves each Git source that has a `track`: a branch to its newest commit, a tag pattern to the highest stable tag, as `office packages update` resolves them. It fetches that commit and checks the whole candidate before it changes the source's `ref` in `office.yaml`: every folder each source names, and every link change sync would make, conflicts with the owner's files included. Any problem leaves that pin and every link as they were. Then it edits that one value, keeping every comment, relinks the enabled skills and updates the exclude block's lines for the package's links at once, without waiting for a sync. It prints the old and new commit and, for a GitHub repository, a link comparing them. The first source that fails stops the command, exit 1; sources updated before it stay updated. Those checks are all it promises: a write that fails after the pin moved (a link the owner made in that moment, a full disk) isn't undone. `office refresh` runs it when the package is selected. Both need the package synced once since it was selected: until then its commands can't run, and refresh stops with `not synced yet; run office sync`.
- To stop using standalone skills, empty `enabled` and run `office sync`, which removes the package's links and their exclusions, then remove the package's entry. Removing the entry first leaves its links in `.agents/skills/` as they are, no longer excluded from commits, since nothing is left to withdraw them: delete them by hand.

## Packages

A package is a capability an office opts into, where the tool itself holds only what every office needs to run. It is a folder of the same shape, whatever its kind:

```
<name>/
  package.json          # names its definition, the office packages it depends on and what it shares
  office.ts             # package definition, at the path package.json names (or a package.yaml)
  plugin/               # an OpenCode plugin it registers with opencode.plugins.add: everything it gives OpenCode
  skills/<id>/SKILL.md  # skills that plugin registers
  scripts/              # package-owned, for tooling and CI
  gui/                  # a desktop app panel it registers with opencode.panels.add: src/, package.json (build dependencies), dist/gui-experimental.cjs (built, committed)
  compose.yaml          # services it adds to the office's compose project
```

There are three kinds, by where a package comes from:

| Kind | Comes from | `office.yaml` entry | Lives in the office at | Editable |
|---|---|---|---|---|
| Shipped with the CLI (core or official) | Inside the `office` executable | `- name: knowledge` (a core package needs no entry) | `.office/packages/<name>/` | No |
| Remote | Another repository | `name` with `repo`, `path` and `ref` | `.office/packages/<name>/` | No |
| Local | Written in the office | `- name: mine` | `packages/<name>/` | Yes |

- An entry without `repo` names a package shipped with the CLI when this tool ships one of that name, and the office's own otherwise; a local package can't use such a name. The core `references` package is implicit: an existing `references:` section needs no package entry. It owns `references list`.
- A **core package** ships with the CLI and is always on: `tooling`, `mise-integration`, `opencode`, `office`, `references`, `seeds` and `cron`. A core package need not be listed; list it once to configure it. An **official package** ships with the CLI and is on when `office.yaml` lists it: `knowledge`, `artifact-share`, `design`, `browser`, `aws-emulator`, `repos` (working repositories, see [its README](packages/repos/README.md)) and `skills`.
- `office` is a core package: an optional entry may only configure its settings (below). It holds what every office needs from OpenCode, given by its plugin: the guidance for a session's folder (which `office instructions` prints), the text packages add to every session (`office instructions --packages`), the `office` skill, the `office-executor` MCP server (see "Runtime"), and the `compact_session` tool, which compacts the calling session once its current reply ends.
- A built-in package follows the `office` executable. If a new executable ships the name of a selected local or Git package, `sync`, `packages update` and `refresh` stop before changing either source, its pin or its links. Rename the package and selection to resolve the collision. Full sync still recognizes the historical untracked first-party entries for the original built-ins.
- A remote package moves when its `ref` changes: a tag, a branch or a full 40-character commit SHA (git can't fetch an abbreviated one). With `track` (a branch, or a tag pattern such as `v1.*`, resolved as `office packages update` describes), `office packages update` moves `ref` to the full SHA it resolves and applies the package; `office sync` installs whatever `ref` pins and never moves it.
- `office.lock`'s `packages:` section records each Git package's `repo`, `path`, `ref` and the full `commit` that `ref` resolved to, sorted by name. While an entry's `repo`, `path` and `ref` match `office.yaml`, sync installs exactly that commit on every machine, whatever the tag or branch points to now. When they differ, or the package is new, sync resolves `ref` again and rewrites the entry; a deselected package's entry goes. The section changes only together with the published package set: a sync that fails before publishing (a fetch or validation failure, a refused candidate) leaves it as it was, while one that fails while applying after publication has already written the new section, like the new package set; rerun `office sync --packages` to finish applying. An office without Git packages has no `packages:` section, and one without an `office.lock` gets one holding only that section. To move an untracked tag or branch on purpose, run `office packages update`. Sync reports each entry it adds, moves or removes (`office.lock: locked <name> at <commit>`, `office.lock: removed <name>`); commit `office.lock` after it changes. Update the host and container executables together before the first sync that writes the section: an older executable rejects an `office.lock` with a `packages:` section, and a leftover `.office/publishing.json` with a `lock` key from an interrupted sync. To go back to one, finish or recover that sync with the newer executable first, then remove the section by hand or restore `office.lock` from Git.
- Local packages in `packages/` are committed with the office. Pulled-in ones live in `.office/packages/`, which sync keeps out of Git (see "Office's plumbing stays out of Git"): a fresh clone gets them from its first `office sync`, which restores built-ins from the executable and fetches a remote package at the commit `office.lock` locks (else at its `ref`), and changes are reviewed through `office.lock` and `office.yaml`. A CI workflow should get a pulled-in package's files the same way: install the `office` version the office pins and run `office sync --packages` before using them. For existing Pages workflows that commit the renderer, see [artifact-share migration](packages/artifact-share/README.md#install). A built-in package's `test/` stays in this repository, which runs it with `pnpm test`.

`.office/packages/` is a dot-folder, so searches and a plain `ls` skip what the office pulled in; `packages/` holds only the office's own packages. A pulled-in package is read-only: its `.source.json` records the SHA-256 of each file as installed (and, for a remote package, the repository, path, ref and commit). `office check` fails when a file differs from the record. `office sync` repairs a built-in from the executable. For a remote with the same declared source and ref, it fetches the **locked commit** from `office.lock` (else the recorded one), even if the tag or branch moved. If that commit is unavailable, repair fails, naming it, and leaves the copy and the lock in place. If the record itself is damaged, the lock still names the commit; without a lock entry, restore the record from office history or pin the full commit SHA. To change a package, copy it into `packages/` under a name of your own and list that instead.

Every package has a `package.json`. It is npm's format, but office never fetches anything from a registry and a package is never published:

```json
{
  "name": "@office/notes",
  "description": "Publish office notes",
  "private": true,
  "exports": { "./format": "./format.ts" },
  "office": {
    "definition": "./office.ts",
    "dependencies": ["@office/references"]
  }
}
```

- `name` is `@office/<name>`, the name `office.yaml` selects it under, and `description`, optional, says what it is for. The definition states neither. No package can be called `sdk`: that name is `@office/sdk`'s.
- `office.definition` is the path of its definition inside the package: a module (any file name) or a `package.yaml`. Office looks for no file by name; a package without a `package.json`, or whose `office.definition` is missing or leads outside the package, doesn't load, and the error says what to add.
- `exports` is its public API: what another package may import, as `@office/notes` (the `"."` entry) or `@office/notes/format`. An import of a path it doesn't list fails with Bun's own error. `"exports": {}` shares nothing; a package that leaves `exports` out makes no promise, and its files can be imported by path.
- `office.access`, optional, is the path of the package's access declaration inside the package: the repositories it reads or pushes to, which `office setup` reads before it clones anything. See "Full-sync work, access and session text".
- `office.dependencies` lists the `@office/<name>` packages it requires: each that its definition or the modules it shares import, type-only imports included. A provider imported only from an integration module is optional and goes in `office.integrations` instead; see "Optional integrations". Each dependency must be selected (the core packages always are); a missing one stops sync and every package command before any package loads, naming both and saying to add it to `office.yaml`. Declaring a dependency doesn't select it, and an import that isn't declared isn't checked yet. `@office/sdk` is always available and is never listed: listing it is a problem that stops sync and every package command. Package managers ignore the `office` key, so nothing asks a registry for an `@office` name.
- A package may keep its own `devDependencies` and `node_modules` for its tests, plugin and tools. Its definition and the modules it shares import only `@office/…` packages, Node's built-ins and its own files: a library pnpm installs doesn't resolve its own dependencies when a definition loads.

Sync links each package it loads as `node_modules/@office/<name>` in the package set it publishes, and the compiled `office` loads every definition through that link, so a package's `@office/…` imports resolve inside the set it belongs to: on the first sync, while sync checks a new set, and afterwards. Beside the links it writes `node_modules/@office/sdk`, the SDK's own source, as types for editors and `tsc`: its root entry throws at runtime, since a package office loads always gets the executable's SDK. Its `@office/sdk/applied-settings` entry runs: a package's Bun script reads its applied settings through it (see "Applied settings"). For editors it links `packages/node_modules/@office` to the published set (kept out of Git; a real folder there is yours and is left alone), so TypeScript follows the same imports with no generated configuration: the template's `tsconfig.json` just includes `packages`. Running from source (`bin/office`) resolves a local package's imports through that editor link, against the published set rather than the one being checked; offices run the compiled `office`.

A module definition's default export is `Package.define({...})` from `@office/sdk`, the one thing a package imports to be a package. Anything else fails to load, naming the package and saying to use `Package.define`; so does a key or a `setup` call the SDK doesn't have. `@office/sdk` is the executable's own copy whatever is on disk, in every process that loads a definition, and has named exports only: `Package`, `Registry` and the types.

```ts
// packages/notes/office.ts
import { Package } from "@office/sdk";
import { defaultTitle } from "./defaults.ts"; // a sibling exporting a string

export default Package.define({
  settings: {
    type: "object",
    additionalProperties: false,
    properties: { title: { type: "string", default: defaultTitle, description: "Page title" } },
  },
  commands: {
    "notes title": { summary: "Print the page title", aliases: ["notes heading"], result: ({ settings }) => settings.title },
  },
});
```

Office loads the module synchronously as trusted code when it reads the package, including during `check`. Ship its relative imports in the package; consumers need no build step or dependency install. A `package.yaml` definition has the same data keys, without the functions, and needs no SDK; having no `setup`, it registers no OpenCode plugin. Compose still reads `compose.yaml`.

A definition declares:

| Key | |
|---|---|
| `settings` | One JSON Schema for the package's settings; see "Settings". Without it, the package accepts none |
| `integrations` | Optional. When each optional provider its `package.json` maps is used; see "Optional integrations" |
| `commands` | Its CLI commands by name: `{ summary, usage?, aliases? }` and exactly one handler, `result` or `run` (see below). The handler receives `{ office, entries, settings, args }`: `office`, the office's folder (`dir`), its `name`, its `mode` (`host`, `managed-host` or `container`) and the `launcher` that runs office here; `entries`, which reads a registry; the package's settings as `office.yaml` has them in that run; and `args`, the words typed after the command's name. `usage`, such as `<path>`, follows the name in help. A package with only `commands` works |
| `sync(inputs)` | Optional. Runs at each sync that switches and applies the package set with every selected package loaded, after every `setup`, with `{ office, entries, settings }`. Returns the lines to print, which sync shows under the package's name. See "Sync and check functions" |
| `fullSync(inputs)` | Optional. Work only a full `office sync` does, as a list of items `{ item, run(output) }`, each shown as a part of sync's progress; see "Full-sync work, access and session text" |
| `session(inputs)` | Optional. Text every new OpenCode and Claude Code session in the office gets, from `{ office, settings }` with the settings the last sync applied; see "Full-sync work, access and session text" |
| `check(inputs)` | Optional. Runs at `office check` with every selected package loaded, with the same inputs and `host`, whose timers it can only read: `host.timers.set` and `clear` throw there. Returns problems, each `{ level: "warning" \| "failed", message }`. It only reports: it must write nothing |
| `committed` | Optional. Folders directly under `.office/` that are committed, such as `.office/seeds/`: sync leaves each out of the block that keeps `.office/` out of Git |
| `setup(ctx)` | Optional. `ctx.settings` (validated, defaults applied), `ctx.registry(handle)` to register a registry the package owns, `ctx.add(handle, value)` to add to one |
| `up(inputs)` | Optional. Runs at the end of `office up`, after the office's own work, with every selected package loaded, in loading order, with `{ office, entries, settings, host }`. Returns the lines to print. One that throws stops the later ones and `office up` exits 1; what started stays up. See "Up, down and host timers" |
| `down(inputs)` | Optional. Runs at the start of `office down`, in a shutdown process of its own, with `{ office, settings, host }` and no `entries`: no `setup` runs. It undoes what the package itself installed. The office's own shutdown runs after it in the `office down` process, whatever happened there |
| `namespace`, `secrets`, `tools`, `host`, `system`, `opencode`, `executor_app`, `spawns` | As below and in their sections |

Select `notes`, run `office sync --packages`, then `office --help` and `office notes title`. Names and aliases are sequences of lowercase words (digits and dashes allowed). The longest declared name or alias the words given start with runs, and every word after it reaches its handler, `result` or `run`, as `args`, exactly as typed, in order, flags and words with spaces included: `office notes show "my notes/a b.md" --raw` gives `notes show` the two arguments `my notes/a b.md` and `--raw`. `--office <dir>`, `--help` and `--version` stay the CLI's. A command parses its own words; one that takes none says so, as `references list` does. A name or alias whose first word is one of the CLI's own commands (such as `sync`, `apps` or `check`), or `opencode inspect` and names under it, is reserved; each name has one owner, and `notes` and `notes show` from two packages are both allowed, the longer winning. [The built-in listing](packages/references/office.ts) declares an imported handler directly.

A command has one handler, and the type and the definition's check refuse both or neither:

- **`result`** returns text, or a promise of it, for a command whose output is data: a list, a file another program reads. That text, with a final newline added when it has none, is all the command writes on standard output, and only if the command succeeds: nothing for `""`, and nothing when the handler throws, sets a nonzero `process.exitCode`, or anything fails before the process exits. Whatever the package set prints while it loads (definitions, `setup`s, the processes they start) and what the handler prints itself go to standard error. The `cron` and `references` packages' listings are `result` commands; `office cron supercronic > crontab` gets only the crontab.
- **`run`** acts, for a command that runs a script, prompts or streams: its standard output, standard error and terminal are the caller's while it runs, and its exit status is the command's (`process.exitCode`), as `office cron run` passes on its script's. What the package set prints while it loads still goes to standard error.

Human-facing progress and messages from a `result` command, Clack's included, belong on standard error: print them with `console.error`, or give Clack `process.stderr` as its output, never the returned text.

A package command, `office --help` and bare `office` load every package `office.yaml` selects on each run, in two phases. First every definition is read and every package's settings checked against its schema; with any invalid setting no `setup` runs: a package command fails naming each package and setting, and help lists the built-in commands, every command the definitions declare, and each problem. Otherwise every `setup` runs with the entry's current settings, every `setup` finishes before any entry is parsed, and the command runs on what was registered in that run. Nothing is read from an earlier run, so an edit to a package, a setting, a name or an alias shows at once, and a command can differ from what sync last applied until the next sync. Imports between packages still follow the last sync: definitions load through the published set's `node_modules/@office/<name>` links, so a newly selected package, local ones included, loads only after `office sync`. Keep `setup` to registrations and actions inside the handler. Before importing any package, every run that reads definitions (package commands and help, `office check`, `office up` and the others; not `office gui dev`, which reads the registrations the last sync applied and runs no package code, see "Panels") checks the whole selection: every built-in or Git copy against its record (`office sync` restores an edited one), every `package.json`, every declared dependency, that the published set links every selected package to its folder, and that no selected package is one the last sync rejected or has no copy yet. With any problem, no package's code runs: a package command fails naming each problem (and saying the command may be unknown, since no package loaded to tell), help lists the built-in commands and the problems, `office check` reports each problem as a failure, and `office up` fails naming them; `office down` instead leaves those packages out of its packages' part (see "Up, down and host timers"). A local package loads as it is. Past that check, one package that fails to load fails every package command, naming it; help still lists what the definitions that loaded declare, and adds a line per failed package and per reserved or duplicate name, which never runs. Sync checks the same names and settings and rejects the whole candidate on a problem, references included: with an invalid setting it sets up nothing and publishes no package set.

Packages load only in an office with a published package set: an active `.office/current` holding a selection, as sync leaves it. In a fresh clone, or after a first sync that stopped before publishing, help shows the built-in commands and a package command says to run `office sync`; commands such as `office check` that run without a set report the required built-ins as not synced yet and load no package. This only checks that a set is available; it doesn't show that this machine trusts the office, since a copied office passes it too.

To contribute a reference from `packages/notes/office.ts`:

```ts
import { Package } from "@office/sdk";
import { repositories } from "@office/references/repositories";

export default Package.define({
  setup(ctx) {
    ctx.add(repositories, {
      name: "notes-manual", url: "https://example.org/notes.git", ref: "main",
      description: "Notes format and examples.",
    });
  },
});
```

`references` exports the `repositories` handle, made with `Registry.define({ id: "references.repository", key: entry => entry.name, parse })`, registers it with `ctx.registry(repositories)`, and calls `inputs.entries(repositories)` in its list handler. Each entry read has a typed `value`, its `owner` (the adding package's name, or `office.yaml` for the office's own references) and the `folder` that package's definition was loaded from in that run (the office's folder for `office.yaml`); `references list` prints the owner as `package <name>`. Another package can define a registry the same way: its ID is `<package>.<name>`, starting with its own name, and `parse` validates each entry, any JSON object (a value that isn't one, such as one holding a function, fails the run naming the adding package and the registry). Handles match by ID, so a consumer's own handle object with the provider's ID adds to the same registry; an entry added to a registry no selected package registered fails the run, naming the adding package and the ID. The registered provider's parser validates and normalizes each addition whenever packages load, at sync and on each package command, once every `setup` has finished; every read returns its own copy of the parsed value. A registry says what makes an entry unique with `key: entry => entry.name`: two entries with one key fail the run, naming the registry, the key and both owners (`office.yaml` for the office's own references). With `keyScope: "package"` keys are unique only within each package's own entries, as tool requirements are; without `key`, equal entries are all kept. The parser checks the fields it needs: `references` refuses an entry without a `name`.

A command in a different package can import that same handle and read the entries as the provider, loaded in the same run, parsed them.

A definition imports what another selected package lists in its `package.json` `exports` as `@office/<package>/<subpath>`. A provider can use ordinary relative imports and read assets beside its own modules (`import.meta.dir` is its folder as linked in the package set). Importing a provider does not select it; for one the office may leave out, see "Optional integrations". Earlier releases wrote `.office/tsconfig.contracts.json` for editors; an office `tsconfig.json` that extends it replaces that line with `"include": ["packages"]`, and a leftover `.office/tsconfig.contracts.json` link can be deleted.

Managed packages are published under `.office/generations/`; `.office/current` selects them and `.office/packages` follows it. Local `packages/` stay editable. After an interrupted tracked update, run `office sync --packages` to finish the recorded switch and reconcile external files. Office retains the current and preceding generation, plus any held by a running CLI reader or the required Office server plugin. Shipped plugins read current settings and assets through the discovery path. A settings reload is not a code upgrade: reload OpenCode to load new plugin code. A process that opens package files independently of Office does not acquire a reader lease.

`setup` receives the package's resolved `settings` and may return a promise. Each run gathers what packages register once: commands and help, sync, `office check`, and the reader that finishes `office setup` or `office refresh` all load every selected package, check every setting, run every `setup` and parse every entry. Nothing a package registers is saved between runs. Sync keeps `.office/` out of Git through `info/exclude`, all but the folders packages declare `committed`, such as the `seeds` package's `.office/seeds/`; a fresh clone recreates the rest with `office sync --packages`.

**What a failure stops.** A selected package that fails to load, whose `setup` throws or whose entry is refused (by its parser, by a registry's key, or because no loaded package registered the registry) fails package sync, naming it: no package set is published, and nothing a set applies changes, the shared `machine.packages.toml`, fragments, machine links, plugin links, what packages' `sync` functions write (seeded files) and the applied references included, in host and container mode. A full sync runs packages' full-sync work, such as the `repos` package's checkouts, only after its own package set was published and applied whole. A local package is linked live into the published set, so a broken edit there also fails its commands until fixed; a pulled-in package's last good copy stays usable when its replacement is refused. A package that can't be fetched doesn't stop the others: the rest publishes, sync exits 1 naming it, and its commands fail with "rejected by the last sync" until a sync fetches it. While a selected package is unread that way, what it claims and registers is unknown, so that sync reconciles no package's tools or machine files, runs no package's `sync` function (so no seeded file or receipt changes), leaves the exclude block as it is, and says so; its plugin link stays.

**Sync and check functions.** A definition's `sync` and `check` take part in the office's own sync and check. They run in the order packages load: the core packages, then `office.yaml`'s order; every `setup` has finished first, so `entries` returns what every package added. `sync` runs only when every selected package loaded: not after a rejected candidate, not while a package is unread, and once per tracked update (`office refresh`'s deferred publish runs them in its full sync). A `sync` that throws stops the sync there, exit 1 naming the package: the lines earlier packages returned are still printed, later packages' functions and a full sync's later steps don't run, and the new package set stays switched; run `office sync` again once fixed. A `check` that throws is a failed line naming the package, and the other packages' checks still run; with any package that doesn't load, no `check` runs, and the line saying which checks were skipped says so. Office can't stop a `check` from writing; that it only reports is the package author's rule.

**Full-sync work, access and session text.** A package that keeps something outside the office up to date, such as checkouts it fetches, uses three parts of the package API, each shown by [examples/package-work](examples/package-work/) (`mirrors`, which checks repositories at each full sync and lists them in every session; copy it into an office's `packages/` to try it):

- **`fullSync(inputs)`** gets `{ office, settings, verbose }`, `verbose` true when the sync runs with `--verbose` (show progress such as Git's meter then, and only what went wrong otherwise), and returns a list of items, each `{ item, run(output) }` with `item` unique in the list. Only a full `office sync` runs them (and the syncs `office setup` and `office refresh` run), after the references are cloned and updated, and only when that same sync admitted and applied the package set with every selected package loaded and no step of it failed (an owner's folder where a package's plugin link belongs, say): never at `office sync --packages` or `office packages update`, not after a rejected candidate, not while a package is unread, and not after a `sync` function throws, which still stops the sync there. They run in a reader bound to the package set that sync published; if office.yaml's packages changed since, or another sync published a set, none runs and sync names why. Items run alongside each other, each a part of sync's progress; `output(line)` shows a line of progress under it as it comes. An item the work stopped before it settled, or anything else that leaves the work incomplete, is a FAILED line too. `run` returns `{ ok: true, summary? }` or `{ ok: false, reason }`; a failed or throwing item is named with its package and reason, makes sync exit 1, and every other item, of this package or another, still runs. A `fullSync` that throws is named the same way and runs none of its items.
- **`office.access`** in package.json names a module whose default export is `Package.access(settings => [{ name, url, access: "read" | "read-write" }])`. `office setup` reads every declared repository anonymously to plan the GitHub login (a `read-write` one is planned for pushing), then with this machine's credentials, before it clones anything; `office check` checks the login for their hosts. It runs before any package set exists, on a fresh clone of an office included, with office.yaml's settings as written: it imports only `@office/sdk` and the package's own files and reads each setting only when it has the expected type, since the schema check comes later, in sync. Built-in and local packages' declarations are read; a Git package's code isn't fetched before the first sync, so its declaration isn't. A declaration that throws or returns anything else stops setup, naming the package, before any clone, and so does a local package whose package.json names `office.access` but doesn't read. The `skills` package declares its Git sources this way.
- **`session(inputs)`** gets `{ office, settings }`, with the settings the last sync applied, and returns text every new session gets: the packages' texts, in load order, separated by blank lines, are what `office instructions --packages` prints from the published package set. The `office` package's OpenCode plugin attaches it to each session as the `packages` instruction entry (`office instructions --session <id>` shows it), and its Claude Code plugin's SessionStart hook prints it, so both read the files the text describes as the session starts. Each runs the `office` on its own PATH: the plugin the one on the OpenCode server's PATH (its service unit's, the container's, or that of the shell that started it), the hook the one on the PATH Claude Code was launched with; where two executables are installed side by side, check that both resolve to the one meant for that office. A package selected but not yet synced adds nothing, and blocks no other's text; nor does one that doesn't load (a rejected or missing copy, say), which adds nothing with the packages that import it; after the sync that deselects a package, new sessions no longer get its text. A `session` that throws adds nothing and is named on standard error.

**Up, down and host timers.** A definition's `up` runs at the end of `office up`, `office setup` and `office refresh`'s finishing step and `office upgrade-tools --apply`, once every selected package has loaded: `office up` gathers every package before it starts anything, and with one that doesn't load it starts nothing and names it. `down` runs at the start of `office down`, in a process of its own that checks the selection without running anything, leaves out each package that fails a check and every package that depends on one, imports the rest, and calls each `down` with its settings checked against its own schema; no `setup` runs, so a `setup` that would throw isn't seen. Each package left out, and each `down` that throws, is named, and `office down` exits 1; what a package left out installed, such as its timers, stays installed. The office's own shutdown runs whatever happens there, even when that process can't start. With no published package set, no package takes part.

`check`, `up` and `down` get `host.timers`, the office's systemd user timer code, scoped to the calling package: `set([{ id, calendar, run }])` makes the package's timers equal the list, `clear()` removes them all, and `status()` reports what is installed for it, a service left without its timer included (`{ id, files, active, calendar, persistent, next?, last? }`, where `files` is `pair`, `timer` or `service`: with only the service there is no timer, so it is never active and has no calendar). A timer is named `office-<office>-<package>-<id>`, is persistent, and its service runs `office --office <dir>` and the words in `run`, with the environment and Git identity an unattended run needs. A package can't reach another package's timers or any other unit; a same-named file office didn't write, or a unit systemd loaded from elsewhere, is refused, naming it, by `status()` too. `set` throws in container mode, where starting the office removes every package's host timers before the container starts; `check` can only read. The `cron` package's `up` and `down` use it for its jobs.

**The applied references.** After each switch of the package set, `office packages update` with `apply: false` included, sync writes `.office/resolved/references.json`, a plain file listing each resolved reference with its owner: `office.yaml`'s own first, then the packages' in the order they were set up. It is written by rename, replacing whatever was at the path. What can't load packages reads it: the office plugin's guidance and `office instructions`, setup's GitHub access planning, and reference refresh (`sync --references`, sync's own clone step and the `package.office.update-references` job, whose script runs `sync --references` after `office cron run`, like every package command, has loaded every selected package). Without the file they read `office.yaml`'s own references; a file that doesn't read is reported by name and never taken as empty, and no checkout is touched. If the set switched but the file couldn't be written, sync says so, exits 1 and clones or updates no reference in that run; the next sync writes it. `office references list` and `office check` read the packages as they are now. Reload OpenCode after updating `office` so the office plugin's new code reads the file.

Empty contributions and deselection withdraw listings but keep the checkouts. `sync --references` refuses an unexpected Git origin; move the retained checkout aside yourself to adopt a different source. As with Git, a relative file remote is relative to the checkout.

The checkout records the applied origin, requested ref and checked-out commit together in its local Git config after a successful refresh. `office check` compares that record with the desired source and actual HEAD offline.

A missing copy of a Git package is installed again at the commit `office.lock` locks for it, never at a moved tag; without a lock entry, a copy whose source record matches the selection is kept, and with no copy at all the ref is resolved and installed as a new package would be. An existing copy that is damaged, such as one whose source record doesn't read, is repaired at the locked commit; with no lock entry and a ref that can move (a branch or tag), sync refuses to repair it, names the package and leaves the copy as it is: restore its record or `office.lock`, or pin a full commit SHA.

`office check` with a package that fails to load reports it as failed, by name, and carries on: the checks whose expected state depends on every package's claims (the shared tool file, fragments, machine destinations and the checkouts of packages' references) and every package's own `check` function are skipped, with one line saying so, and the rest still run.

**Refreshing a checkout.** A reference refresh holds a **per-checkout lease** under `.office/resolved/checkout-leases/` for the whole of cloning or updating it, fetch included: a second refresh of the same checkout runs no Git on it and fails naming it. Each existing checkout fetches into an invocation-private Git ref; new clones fetch into private sibling directories. Fetches of different checkouts run in parallel. Office passes the locked file descriptor explicitly to the Git commands that mutate a live checkout, so if only Office dies, Git still holds the lease until it exits; there is no PID or timeout to reclaim. A Git wrapper must preserve inherited descriptors for the lifetime of the mutator. This requires BSD-style `flock` (Linux glibc or macOS libSystem); Office refuses to apply without it. A refresh racing a sync can act on a reference that sync just changed; the next run uses the new list. A hard stop can leave a `.office-<name>-*` staging directory under `references/` or a `refs/office-fetch/*` ref in a clone. Neither blocks retry; remove leftovers only when no refresh is running.

`aws-emulator` contributes `floci` by default. If the office already declares it, keep your declaration with `settings: { source_reference: false }` on the package, or remove your declaration to adopt the built-in reference, then sync.

Existing YAML packages continue to work, named by `office.definition` like a module. The YAML examples below describe the same fields. When converting a package, point `office.definition` at the new file; a file it doesn't name is not read, and an import or validation error fails the read. Sync keeps the failed selection's existing settings, tool pins and plugin link; removing its selection from `office.yaml` requests cleanup.

Office reads a managed replacement in a staging directory with the consuming office's settings. A broken definition, a job the cron registry's parser refuses or an invalid Compose declaration leaves the installed files and tracked pin in place. A job whose script the new commit lacks is found only by the cron package's `sync`, so that commit is published, and sync then exits 1 naming the job; fix the package and update again. A failed initial sync makes `office init` exit nonzero. For both definition formats, repair uses the executable or pinned repository rather than importing an edited installed definition. An exact Git SHA takes precedence over a contradictory source record.

On a managed host, the machine record keeps each package's applied environment entries. A package that failed to load changes nothing, so every entry, fragment and link stays; once sync loads every package, deselecting one withdraws its entries, fragment and link. `office down`'s own shutdown reads applied Compose files and office-owned units without loading selected definitions; only its packages' part, in a process of its own, loads them to run each `down`.

```yaml
settings:              # one JSON Schema; see "Settings" below
  type: object
  additionalProperties: false
  required: [url]
  properties:
    url: { type: string, description: What the setting means }
namespace: share       # optional, for a package with services: what they're named after; see "Services"
secrets:               # generated once, for a package with services; see "Services"
tools:                 # mise tools it needs, at the exact version it was tested with; see "Tools"
  "npm:agent-browser": "0.43.0"
executor_app: {}       # an Executor app in executor-app/; see "Executor apps"
spawns:                # for a package with services: the label on Docker resources they create themselves; see "Services"
  label: share_owner=office-${OFFICE_NAME}-share
```

### Optional integrations

A package can use another package only when the office selects it: an **optional provider**. `office.integrations` in its `package.json` maps each one to a module inside the package, which office imports only while the integration is active; the base definition never imports the provider. A provider is either required (`office.dependencies`) or optional, never both, and neither the package itself nor `@office/sdk` can be one. A module path outside the package, or a link leading out of it, is refused when the `package.json` is read, as for `office.definition`, and so is a module that is the same file as the definition or as another provider's module, under another path or through a link: that file would load whether or not its integration is active. Modules may still import shared helpers of the package; the manifest is not an import sandbox. [examples/optional-integrations](examples/optional-integrations/) holds the packages below; copy them into an office's `packages/` to try them.

```json
{
  "name": "@office/chatgpt-routing",
  "private": true,
  "exports": {},
  "office": {
    "definition": "./office.ts",
    "integrations": { "@office/mock-executor": "./executor.ts" }
  }
}
```

The package keeps one settings schema for everything, the integration's options included, and its definition says when each integration is active, under `integrations`, keyed `@office/<name>`:

```ts
// packages/chatgpt-routing/office.ts (abridged)
export default Package.define({
  settings: {
    type: "object",
    properties: {
      routes: { type: "object", default: {}, properties: { gmail: { enum: ["off", "direct", "executor"], default: "direct" } } },
      executor: { type: "object", default: {}, properties: { app: { type: "boolean", default: false }, name: { type: "string", default: "chatgpt" } } },
    },
    // Gmail through Executor needs the app: there is no fallback to the direct route.
    if: { properties: { routes: { properties: { gmail: { const: "executor" } }, required: ["gmail"] } }, required: ["routes"] },
    then: { properties: { executor: { properties: { app: { const: true } }, required: ["app"] } }, required: ["executor"] },
  },
  integrations: { "@office/mock-executor": { requested: settings => settings.executor.app } },
});
```

```ts
// packages/chatgpt-routing/executor.ts
import { apps } from "@office/mock-executor/apps";
import { Package } from "@office/sdk";
import type definition from "./office.ts";

export default Package.integration<typeof definition>()({
  setup(ctx) {
    const { routes, executor } = ctx.settings;

    ctx.add(apps, { app: executor.name, tools: routes.gmail === "executor" ? [{ name: "gmail.search", readOnly: true }] : [] });
  },
});
```

- **When it is active.** `requested(settings)` gets the package's validated settings. `true` activates the integration: if `office.yaml` doesn't select the provider, the command or sync fails naming both packages, and no other route is used instead. `false` keeps it off. `undefined`, or no `requested`, leaves it to `enabledByDefault: true`, which activates it only while the provider is selected; with neither, selecting the provider activates nothing. Give a switch whose omission must differ from `false` no `default`, as `review-kit`'s `skills` setting has none: left out, the author's default offers the skill whenever `skills` is selected; `false` turns the offer off. Cross-field rules, such as a route that needs the app, belong in the schema, so they fail before any setup. A policy for a provider `package.json` doesn't map fails the definition.
- **What runs.** Every selected package's settings are checked first, an inactive integration's options included: a dormant typo fails, naming the setting, before any integration module loads. Then each package's `setup` runs followed by its active integrations', which get `ctx.settings` (the package's settings) and `ctx.add`, and add entries as the package: `owner` and `folder` are the package's, whatever order `office.yaml` lists the packages in. Activity is decided from the selection being gathered (`office.yaml` for commands and check, the candidate for sync), never from the links an earlier package set left, so a deselected provider's stale link activates nothing, before or after sync. `office down` loads no integration module, and `office gui dev` runs no package code: it reads the registrations the last sync applied, so a panel an active integration adds shows there only after a sync.
- **Diagnostics.** Two kinds, at two stages. Before any package's code runs, the whole selection is checked as for any package: a selected provider's copy, its `package.json` and the consumer's (a module outside the package or shared with another, a provider also listed as required), and the required dependencies. A problem there names its package and stops every package's code from running, so no policy or integration module is reached. Past that, the integration's own diagnostics name the consumer, `integration @office/<provider> (<module>)` and what went wrong: a policy that throws (with its cause) or returns anything but `true`, `false` or `undefined` synchronously (a Promise, from an `async` policy, is refused, never awaited); a request for a provider `office.yaml` doesn't select; a selected provider whose definition didn't load, which is also named by its own error; and a module that fails to import, isn't made with `Package.integration`, or whose `setup` throws, with the original cause. Any of them fails the command, or sync, which then publishes nothing.
- **Dependencies.** A selected optional provider counts as a dependency for updates that move packages together, for checking a replaced package before it is published, and for `office down`, whether or not the integration is active: if the provider is left out of shutdown, an ownership conflict included, so is its consumer. Selection is what `office.yaml` lists, not what resolved or loaded. An unselected one counts for none of them.
- **Withdrawal.** When an integration turns off, what it added is gone from the next gathering; the provider's own sync reconciles what it delivered. A skill offer is one: with `skills` selected, turn `review-kit`'s offer off and remove `review-checklist` from `skills`'s `enabled` in the same edit; sync then removes its link. Turning only the offer off leaves an enabled ID no source offers, which the skills package refuses.
- **Types.** `Package.integration<typeof definition>()` types `ctx.settings` from the definition through a type-only import, so the module imports nothing of it at runtime. Its provider import needs the provider's types where the package is written, such as an office selecting it or a `tsconfig.json` `paths` entry to its sources, as [the example's](examples/optional-integrations/tsconfig.json) has; that is independent of whether an office using the package selects the provider. The CLI reads none of it.

### Settings

A package declares the settings it accepts as one JSON Schema (draft 2020-12, synchronous) under `settings`, whose root has `type: "object"`; a root that is only a `$ref` isn't accepted. This is the only way to declare settings, and `office.yaml` keeps them under the package's entry:

```ts
settings: {
  type: "object",
  additionalProperties: false,
  properties: {
    port:    { type: "integer", default: 4566, description: "The loopback port" },
    storage: { enum: ["memory", "persistent"], default: "memory", description: "Storage mode" },
    source_reference: { type: "boolean", default: true, description: "Include the source checkout" },
  },
},
```

- **Checked before any setup.** Every selected package's settings are checked against its schema, with its defaults applied, before any package's `setup` runs; `office sync`, `office check` and every package command check them. A value is checked against its declared type and never coerced (a quoted `"4600"` for an integer setting is refused), a setting the schema doesn't name is refused when it has `additionalProperties: false`, and a `required` one left out is named. A `settings` that isn't a JSON object (`null` included), a root without `type: "object"`, or a schema that doesn't compile, is a settings problem too: no package is set up, and help still lists the commands. Use `$defs` and local `$ref`s for reuse; schemas are not fetched from the network. `format` is an annotation.
- **Typed.** `Package.define` types `ctx.settings` and a command's `settings` from the schema with no annotation or `as const`. The supported shapes are booleans, numbers, text, enumerations, and lists (`items`) and objects (`properties`) of those. A property with a top-level `default` or listed in `required` is present; one with neither may be undefined, and a `default` inside a condition doesn't count. Anything else is loosely typed, as any setting value: a property using `$ref`, conditions or combinators on its own, a list with `prefixItems` as a list of any values, and a root using one of them, or an object without `properties`, as an object whose every key may be absent. A package that declares no settings has none to read. Either way the values are the validated ones.
- **Delivered.** Sync publishes the resolved settings, booleans included, in the office's applied settings snapshot (see "Applied settings"). Each top-level setting whose value is text, a number or true/false reaches the package's compose file as `<NAMESPACE>_<NAME>` (here `FLOCI_PORT`), in capitals with other characters as `_`; lists, objects and null don't. A value holding a single quote or a line feed fails, naming the package and the setting.
- **Gates.** A setting named by `host.setting`, `host.services.<id>.setting` or `executor_app.setting` must be declared `type: boolean`. One named by a system setup, the package's own `system` block or a recipe it contributes, must also have `default: false`: an office opts in. Only `true` set in `office.yaml` turns a system setup on, and a schema that resolves the setting to `true` when `office.yaml` doesn't set it (a default in a condition or a combinator) is refused.
- A secret can't have the variable of a setting the schema declares, whether `office.yaml` sets it or not.

`office.yaml` lists the packages, each with its settings:

```yaml
packages:
  - name: knowledge              # official
  - name: artifact-share         # official, with a setting
    settings:
      url: https://example.github.io/my-office
  - name: reports                # remote
    repo: https://github.com/example/office-packages.git
    path: packages/reports
    ref: <commit or tag>
    track: 'v1.*'                # optional: what office packages update moves ref along
  - name: something-local        # this office's own, in packages/something-local/
```

`office sync` applies the packages in this order:

1. For each package, installs a package shipped with the CLI (core or official) from the executable, or copies a remote one at its locked commit (at `ref` when `office.lock` has no matching entry), with the repository's licence when the folder has none, into `.office/packages/<name>/`, and writes its `.source.json`. It replaces a copy of a package shipped with the CLI that differs from the executable's, a remote copy whose record differs from the entry's repository, path or ref, and any pulled-in copy whose files were edited, saying which.
2. Writes each package's `.office.json`, what the office declares to every package apart from its settings: `{ "opencode": "host" }` or `"container"`, `office.yaml`'s mode (see "Modes"). With every selected package loaded, publishes their settings, with defaults applied, in `.office/runtime/settings.json` (see "Applied settings"). A setting the package doesn't declare, or a required one left out, is an error naming the field, and nothing is published.
3. Runs each package's `sync` function, in the order packages load, the `seeds` package's among them, which lays down the files packages declare (see "Seeds"). This and the next step run only with every selected package loaded; a `sync` function that throws stops the sync here (see "Sync and check functions").
4. Writes the mise tools each package declares into `machine.packages.toml`, and its mise setup (in a host-mode office its host install, and its system setup where it applies) into `.office/mise/<name>.toml` (see "Tools").
5. For each package that [registers a server plugin directory](docs/opencode-authoring.md) with `opencode.plugins.add`, links it as `.opencode/plugins/<name>` (a relative link, kept out of Git), making it discoverable from the root and every folder below it without an entry in `opencode.jsonc`, and installs the panel a package registers with `opencode.panels.add`. A folder name alone registers nothing. While a selected package is unread (its fetch failed), the others' plugins and panels are still linked, relinked and withdrawn, each checked before the package set is published, and the unread package's link stays as the last sync left it. A conflict with a `plugins:` entry or an entry of the office's own at the destination is reported, never replaced. A link is Office's because of its target text (`../../packages/<name>/…` or `../../.office/packages/<name>/…`), so when the package leaves `office.yaml` sync removes it, dangling or not; links elsewhere stay. If the package's plugin moves (between `packages/` and `.office/packages/`, or to another registered directory), sync relinks it and says to restart OpenCode, which keeps loading the old location until then. See [OpenCode sources, scope and upgrade recovery](docs/opencode-sources.md).

A package's registered plugin is how it reaches OpenCode: OpenCode loads it directly, and nothing else of a package is linked into `.opencode/`. The plugin registers the package's skills with `ctx.skill.transform`, as `artifact-share` does for `skills/share-artifact/`, and its MCP servers with `ctx.mcp.transform`, as `office` does for `office-executor`; tools, hooks and instructions come from the plugin too. A package that wants a folder offered as a standalone skill instead, enabled by the office, uses `skills.add` (see "Standalone skills").

A plugin runs with nothing installed: there is no `node_modules` beside it. It imports only what the runtime provides (Node's and Bun's built-ins, and the `@opencode/plugin` and `effect` modules OpenCode gives every plugin), or ships its own bundle, as the `office`, `browser`, `design` and `aws-emulator` packages do: each one's `plugin/` in an office holds one `index.js` built with what it imports, the tool's code or `@office/sdk/applied-settings`. OpenCode loads `plugin/server.ts`, else `plugin/index.ts` (or `.js`), or the entry exported by a `package.json` there that has `name` and `exports`, and reloads a plugin when a file it imports inside `plugin/` changes.

OpenCode loads the plugin through the link and resolves its relative imports from there, so a plugin can't import a file outside `plugin/` (`../office.ts` fails to load), and its own path may be the link's or the package folder's. It finds its package folder with `realpathSync` on its own folder, and the office by walking up to `office.yaml`, never by a fixed number of folders. A plugin that uses its settings reads its entry of the office's applied settings when it needs them (in a hook or transform), or watches it, so it sees the values the next `office sync` publishes (see "Applied settings"); one that depends on the office's mode reads `.office.json` the same way, never the environment it runs in.

To uninstall a package shipped with the CLI or a remote one, delete its entry from `office.yaml` and run `office sync`. It unlinks the plugin and removes `.office/packages/<name>/`. Nothing the package laid down in the office is deleted: the `seeds` package names each file it seeded as left in place and drops its receipts, keeping their seeds in `.office/seeds/`; delete the files you don't want. Commit what it changed; `git restore` brings it back. A local package stays until you delete its folder.

`.source.json` and `.office.json` are the office's records, so they are left out of the file hashes; any other file in a pulled-in copy, a `.settings.json` an earlier sync wrote included, is package content, so sync restores the copy without it. Sync writes no settings into a package folder, and leaves one in a local package's folder for its owner to delete. `office check` reports a folder in `packages/` that `office.yaml` doesn't list (sync never removes one) and one that has the name of a package shipped with the CLI, and a folder in `.office/packages/` that no entry wants, which sync removes.

A receipt marking a file as already there (`existing: true`) has no stored seed, so that file is never offered updates. To bring one in, run `office seeds settle <path>` on it: the receipt then names the package's current seed, so later changes are offered. Do this for each file that still equals its package's seed, and commit `.office/seeds/`. A receipt with a hash whose seed is missing from the store makes `office check` warn: copying the office's unchanged file to `.office/seeds/<sha256>` repairs it.

There is no package registry and no version range. The packages that ship with the CLI, besides the core `tooling`, `mise-integration`, `opencode`, `references`, `seeds` and `cron`:

| Package | Does |
|---|---|
| `office` | A core package, in every office: folder guidance, the `office-executor` MCP server, the `compact_session` tool, and the `office`, `office-package-creator`, `openai-skill-creator`, `opencode-sessions` and `opencode-plugin` skills |
| [`knowledge`](packages/knowledge/README.md) | Lists the office's `knowledge/` articles, with their descriptions, in every session, refreshed on each prompt. `office init` adds it |
| [`artifact-share`](packages/artifact-share/README.md) | The user asks an agent to share something; it goes in the office's `artifacts/`, which a workflow publishes as a GitHub Pages site with an index page. The site may be public, even for a private repository |
| [`design`](packages/design/README.md) | The office runs its own [Doop](https://github.com/kgoedecke/doop) design canvas as package services, and every session reaches it as the `doop` MCP server, with an agent key a person creates once |
| [`browser`](packages/browser/README.md) | Browser automation: agent-browser (a mise tool the package declares) drives a headless Chromium in either mode, and in a host-mode office Browse drives the user's own Chrome, installed once and self-updating; each an MCP server where it applies, with a skill saying which to use when. `office init` adds it |
| [`aws-emulator`](packages/aws-emulator/README.md) | The office runs [Floci](https://github.com/floci-io/floci), a local AWS emulator, and its web console as package services, and every session gets the `floci` skill and the AWS CLI (a mise tool the package declares) to test against AWS APIs without a real account |
| `skills` | Standalone skills, enabled by ID and linked into `.agents/skills/`; see "Standalone skills" |

The `office` package has two settings for skills outside the office that its sessions shouldn't get: `ignore_claude_synced_skills`, on by default, and `ignore_skill_folders`, a list of more folders. OpenCode loads every skill under `~/.config/opencode/skills`, `~/.claude/skills` and `~/.agents/skills` into every session, and its permission rules can only deny a skill by ID, so a folder another program fills, such as the one the Claude desktop app syncs account skills into, has no switch of its own. These are one. `ignore_claude_synced_skills` covers that folder, `~/.claude/skills/synced`, and is on in every office without setting anything; `false` lets those skills load. `ignore_skill_folders` adds folders of your own and never replaces it:

```yaml
packages:
  - name: office
    settings:
      ignore_skill_folders:
        - ~/.agents/skills/unwanted
      # ignore_claude_synced_skills: false   # to load the Claude app's synced skills
```

Each folder is an absolute path, one starting with `~` (the home of the server the sessions run on: the container's in container mode), or one relative to the office root; a folder that doesn't exist hides nothing. After `office sync`, the package's plugin removes every loaded skill whose file is inside one of them, at any depth, from the sessions of the root and every folder below it, while skills beside the folder still load. Nothing lists skill IDs: OpenCode reloads its skills when a folder changes and the plugin removes them again on each load, so a skill added to the folder later never appears, and removing a folder from the settings brings its skills back on the next sync, without a restart either way. A removed skill is gone from the server's skill list for the office's folders, so it is neither offered to the model nor loadable by ID there; sessions outside the office are unaffected.

The removal goes by folder alone: a skill in an ignored folder is removed whatever skill of the office or of a package has its ID. Which of two skills with one ID OpenCode keeps is its own; `office check` says which loads while OpenCode runs.

### Applied settings

Sync publishes every selected package's resolved settings, defaults included and `{}` for a package without any, in one file per office, `.office/runtime/settings.json`: `{ "packages": { "<name>": { ... } } }`, with every object's keys sorted, so the same settings always give the same bytes. Settings are not secrets, and the file holds nothing else. It is the office's runtime state, never committed: a new office's `.gitignore` lists `.office/runtime/`, sync's exclude block lists it too (before publishing it, so a first sync that stops in a package's `sync` function still keeps it out), and no package may declare it `committed`. Before publishing, sync asks Git whether it ignores the file, in the office's repository or a repository whose worktree holds the office: when a rule of yours re-includes it (Git's last matching rule, such as `!/.office/runtime/` in `.gitignore`, outranks the exclude block) or the file is tracked, sync names the rule or says it is tracked, fails and leaves your files, the index and any earlier snapshot as they were. When Git can't answer (it isn't installed, or fails) and the office's folder or one above it holds a `.git` (a repository folder or a linked worktree's file), sync fails the same way; an office with no `.git` above it publishes without Git. It is read and written only in the office's own `.office/runtime/`: a `.office` or `.office/runtime` that is a link, or a snapshot that isn't a regular file, is refused, by sync and by every reader.

- **When.** Sync publishes it while applying a complete package set, holding the package application lock: after the set is admitted and published, before any package's `sync` function runs and before plugins are linked, so each sees the settings it is applied with. It replaces the file by rename, and only when its bytes change. A candidate that is refused (a setting that doesn't validate, a definition that doesn't load) leaves the previous file; so does a sync that couldn't fetch a selected package, which still switches the package set, and an update that doesn't apply (`office refresh`'s first step). A `sync` function that throws afterwards leaves the new file published. A deselected package's entry goes with the next complete sync. Every application makes `.office/runtime/` before it links plugins, so a plugin can watch it before anything is published there.
- **Office.** A reader names its office explicitly: a plugin or script from its own package folder's real location (`officeRootOf(packageDir)` finds the nearest folder above it holding an `office.yaml`, which it doesn't read), a launcher from what started it. Never the working folder, which can be inside a repository with its own `office.yaml`.
- **Shell.** `office settings get <package> --office <dir>` (or `office --office <dir> settings get <package>`; `--office=<dir>` too) prints the package's entry as JSON on standard output. It reads only the file: no package is loaded, `office.yaml` isn't read and nothing is repaired, so it works while a definition doesn't load or `office.yaml` doesn't parse. A missing file, a malformed one, a redirected one and a package without an entry each fail with a message on standard error naming the file or the package, and nothing on standard output; a malformed file's message doesn't quote it.

  ```sh
  port=$(office settings get aws-emulator --office "$office" | jq -r .port)
  ```

- **Code.** `@office/sdk/applied-settings` is TypeScript that imports only Node's built-ins: Bun runs it as it is and a bundle can include it, but Node doesn't strip types under `node_modules`, so a plain Node reader bundles it or runs `office settings get`. `readAppliedSettings(officeRoot, name)` returns the entry or throws an `AppliedSettingsError` whose `problem` is `missing-snapshot`, `malformed-snapshot`, `missing-package` or `redirected-snapshot`. `watchAppliedSettings(officeRoot, name, onChange, onError)` starts watching `.office/runtime/`, so a replacement by rename is seen, then reads the entry: its `settings` are undefined when that read failed, as before a sync has applied the package. It calls `onChange` each time the entry differs from the last one read, by value, whatever the order of its keys: the first sync that applies it, then each change; another package's change calls nothing. A failed read goes to `onError` and keeps the last value. It never throws and never writes. `canonicalJson(value)` is the text it compares: keys sorted, arrays in order. A package's Bun script imports it from the package set sync installed (run it with `bun --no-install`, so a missing module fails rather than being fetched), as `artifact-share`'s renderer does; a plugin bundles it, as the built-in plugins do.

  A script in a local package, `packages/notes/scripts/settings.ts`, run from anywhere with `bun --no-install packages/notes/scripts/settings.ts`:

  ```ts
  import { dirname } from "node:path";
  import { officeRootOf, readAppliedSettings } from "@office/sdk/applied-settings";

  const packageDir = dirname(import.meta.dir);

  console.log(readAppliedSettings(officeRootOf(packageDir), "notes"));
  ```

  The same package following its settings until interrupted, as a plugin does:

  ```ts
  import { dirname } from "node:path";
  import { officeRootOf, watchAppliedSettings } from "@office/sdk/applied-settings";

  const watch = watchAppliedSettings(officeRootOf(dirname(import.meta.dir)), "notes", settings => console.log("applied", settings), console.error);

  console.log("now", watch.settings);
  process.on("SIGINT", () => watch.close());
  ```

`office check` reads the file once and compares each package's settings with its entry, reporting a missing, malformed or redirected file, an entry that differs and one for a package `office.yaml` no longer selects; what it says sessions hide (the `office` package's skill folders) is from the file too, as the plugin sees it. Package `check` functions and commands still get the settings `office.yaml` has now. Check never writes the file: run `office sync` to publish it.

### Seeds

A seed is a file a package lays down once in the office, which is the owner's from then on, such as a folder's `AGENTS.md` or a workflow. The core `seeds` package does it, and a package declares each seed in its `setup`:

```ts
import { Package } from "@office/sdk";
import { seeds } from "@office/seeds";

export default Package.define({
  setup(ctx) {
    seeds.add(ctx, { destination: "notes/AGENTS.md", source: "guidance/notes.md" }); // a file
    seeds.add(ctx, { destination: "notes/examples", source: "starter/examples" });   // a folder, like cp -r
    seeds.add(ctx, { destination: "notes/active/.gitkeep", text: "" });              // text
  },
});
```

- `destination` is a path relative to the office, outside `.office/`, and may come from a setting. Each seed has exactly one of `source`, a file or folder in the package (a folder lays down every file under it, hidden ones included, below `destination`), or `text`. The type makes both or neither a compile error. A file keeps its mode and text is written 0644, whatever the umask; a file that was already there keeps its own.
- Nothing is found by folder name: a package that calls `seeds.add` for nothing has no seeds, whatever folders it has. List `"@office/seeds"` in `office.dependencies`.
- Sync lays each declared file down once. Before writing, it stores the seed's bytes as `.office/seeds/<sha256>`, and after, it records a receipt in `.office/seeds/receipts.json`: the package and the SHA-256 it wrote, or `"existing": true` for a file that was already there, which is kept. Sync never creates a file for a path with a receipt again, so a file the office deletes stays deleted, on a fresh clone too. Receipts are sorted by path, one per line, so a commit's diff shows one line per changed receipt. The store keeps a `.gitattributes`, `* -text -filter -ident -working-tree-encoding`, so Git never converts a stored seed or the receipts. Commit `.office/seeds/`; office never deletes a stored seed.
- **Every declaration is checked first.** A source that doesn't exist, leads outside its package or through a link below the package's folder, a destination in `.office/`, outside the office or through a linked folder, two declarations of one file (from two packages or one), or a file where another declaration needs a folder: any of these stops sync, naming the package and the path, before a single seed file, stored seed or receipt is written. Each declared destination is checked even when its folder holds no file, and a path with a line break or NUL is refused; a clash is named even where the office's own files also stand in the way. A declaration of the wrong shape (both or neither of `source` and `text`, or an unknown key) is refused when the packages load, so no new package set is published; the others are found once the files can be read, after the set has switched, which stays switched. A receipts file that isn't valid JSON of the right shape, or isn't a file (a link, dangling or not, included), stops sync, `office check` and both commands, naming it, and is never replaced: restore it from Git.
- **A write that fails** part-way (disk, permissions) keeps the receipts of the files already written and stops sync naming the path; the next sync carries on. If the receipts file can't be written either, sync gives that error too, after the path's.
- **Nothing is deleted.** When no selected package declares a path that has a receipt any more, because its package dropped the seed or was removed from `office.yaml`, sync leaves whatever is at the path, without looking, says `left in place: <path> (package <name> no longer seeds it)`, and drops the receipt. Cleaning up is the owner's. A package selected again finds its files without receipts and marks each as already there; settle the ones you want updates for. A file you deleted before deselecting it is created again.
- **A path that changes hands** in one sync, one package dropping it and another declaring it, loses the first receipt; the file, if there, is marked as already there for the second, which never replaces it on the first's receipt.
- **A package that can't be read** in a sync (one that couldn't be fetched) stops every seed in that sync: with it unread, a dropped seed can't be told from one that wasn't loaded. The next sync that loads every package applies the changes.

### When a package changes a seed

Each sync, for every receipt whose package still declares its path, compares three things: the seed the receipt's SHA-256 names (in `.office/seeds/`), the package's seed now, and the office's file. Nothing about the outcome is stored; it is worked out again on each run, by sync, `office check` and the `office seeds` commands alike.

| Package's seed vs receipt | Office's file | Sync |
|---|---|---|
| Same | Anything | Nothing |
| Different | Same bytes as the stored seed | Stores the new seed, replaces the file (by rename, with the seed's mode) and records the new SHA-256: `updated <path> …` |
| Different | Same bytes as the new seed | Stores and records the new seed; the file is unchanged |
| Different | Deleted | Stores and records the new seed; the file stays deleted |
| Different | Other bytes | Leaves the file and the receipt; reports it as pending, with `office seeds diff <path>`, on every sync until settled |

Bytes are compared exactly, so a file whose line endings a checkout changed counts as different and is offered rather than replaced. A receipt marking a file as already there (`existing: true`) has no stored seed and is never offered. When the stored seed is missing, isn't a file (a folder or a link) or doesn't hash to its name, sync leaves the file, the receipt and whatever is in the store, and names the seed to restore (removing what isn't a file first): `git checkout -- .office/seeds/<sha256>` when it was committed, or, if it never was, copy the file as office laid it down (for an unchanged file, the office's file) to `.office/seeds/<sha256>`; `seeds diff`, `seeds settle` and `office check` give the same advice, and the two commands refuse that path. A folder or a link at a seeded path (or a path through a linked folder) counts as other bytes: it is pending and never replaced.

For a pending file, `office seeds diff <path>` shows both sides: what the package changed and what you changed, each against the seed office laid down, so a rule you deleted shows as your deletion rather than as new guidance. It ends with:

```text
Keep owner deletions deleted, including package rewrites of deleted rules or sections.
If nothing else applies, leave the file unchanged and settle.

When you have dealt with it:
  office seeds settle <path>
```

Merge what you want into your file, then run `office seeds settle <path>`: it stores the package's current seed and records it in the receipt, leaving the file as it is, so the path is current until the package changes the seed again. Settling without editing declines the update; settling a file sync would replace because it is unchanged declines the replacement, and the file stays as it is. Nothing else makes an edited file current. Earlier seeds stay in the store. Commit `.office/seeds/` and your file.

### Tools

`machine.toml`, `machine.packages.toml` and `.office/mise/` are machine-wide; every `mise.toml` is folder-scoped:

| File | Applies | Who changes it |
|---|---|---|
| `machine.toml` at the office root | The whole machine | The office, freely: tools, versions and mise settings (except `minimum_release_age`, which the office's environment sets from `tools.minimum_release_age` and so overrides; see "Socket Firewall"). Sync never rewrites it |
| `machine.packages.toml` at the office root | The whole machine | Sync adds and removes tools as packages declare them, and writes each line's comment; the versions are the office's (`office upgrade-tools` bumps them; sync only raises one below what a package needs) |
| `.office/mise/<package>.toml` | The whole machine | Sync alone: a package's mise setup (host install, system setup), rewritten on every sync |
| `mise.toml` at the office root | The office folder | The office: what the office repository itself needs |
| `repos/<name>/mise.toml` | That working repository | The repository |
| A repository's `mise.toml` | That repository | The project |

`.office/` is the tool's; what you edit is at the root. Each file's header comment says which kind it is, `machine.toml`'s and `machine.packages.toml`'s each name the other, and `machine.toml`'s and the root `mise.toml`'s too. `office init` writes a starter `machine.toml`; `office sync` writes `machine.packages.toml`.

mise loads none of `machine.toml`, `machine.packages.toml` or `.office/mise/` where they are (it reads `mise.toml`, `mise.<env>.toml` and a few other names in a folder, not these), so the machine-wide files apply only through links in mise's global conf.d: in a host-mode office `office sync` makes them, once you agreed in `office setup` (see "Machine"), and the container makes them inside itself at start. Without the links the files apply nowhere, so `office check` fails in a host-mode office without consent. Through the links they are global config, in every folder alike, the office's included: `machine.toml` wins over `machine.packages.toml` everywhere, and a `mise.toml` (the office's, a working repository's) wins over both in its folder, as project config wins over global. mise does load `mise/config.toml` and `mise.toml` in place below `.office/`, so `config` and `mise`, like `machine`, are reserved package names.

A package that needs a CLI registers it in `setup(ctx)` with `import { requirements } from "@office/tooling/requirements"` at module scope and `ctx.add(requirements, { name, minimumVersion })`, by the name a `mise.toml` gives it, at the exact version it was tested with (never a range or `latest`). That version is where an office starts and a floor it shouldn't go below; newer versions are the office's choice. `office sync` writes every package's tools into one file, `machine.packages.toml` at the office root, which the office commits: a `[tools]` table with one line per tool, each with a comment naming the packages that declare it:

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

A package's mise setup, when it has one, goes in its own fragment, `.office/mise/<name>.toml`, which stays out of Git and which the office never edits: sync writes it whole and rewrites it on every sync, and deletes it when the package has no setup in this office or leaves `office.yaml`. The file's first line names the package; sync never touches a file in that folder whose first line doesn't name one of its packages, refuses to write a package's setup over such a file, and links only its own (`office check` reports any other file there: move its tools to `machine.toml`).

The required `mise-integration` package exports tasks, install-once hooks and native bootstrap recipes. Import its handles at module scope, for example `import { installs } from "@office/mise-integration/claims"`. The import resolves from the office, including for local and pinned Git packages. See `packages/browser/office.ts` for a settings-gated install and independent Chrome recipe. A task-only package can register `ctx.add(tasks, {name: "audit", description: "Run audit", script: "scripts/audit.sh"})` without a tool requirement. Each task runs as `<package>:<name>`. Installs claim the `destination` they manage, independently of their readiness marker. Native `bootstrap.files` entries also claim their paths. Conflicting destinations stop publication; Office does not infer what a shell script writes.

A definition's YAML or TypeScript manifest fields take part in the same policy. For example, the host form is:

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

The corresponding system setup form is:

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

### The office CLI's tools

A tool the CLI itself runs belongs to the CLI; `machine.toml` is for your own choices. The required `office` package registers the minimum versions from `packages/office/floors.ts` for SOPS and age (encrypted secrets), gh (GitHub logins and sources) and pre-commit (the gitleaks hook). `office upgrade-tools` bumps their adopted versions in `machine.packages.toml`. A host-mode office links that file machine-wide (`office-<name>-0-packages.toml`). The container installs tools from the last container-mode sync; run `office sync --packages` before starting the new image. It skips package files retained from a host-mode sync.

The CLI runs the version `machine.packages.toml` pins, as mise installed it, which it finds with `mise which <command> --tool=<tool>@<version>`, run from `/` without config files: no shims, PATH entry, link or consent needed, so it works the same from your terminal, cron jobs, systemd timers and CI, in either mode. Until that version is installed, the newest copy mise installed, on PATH or left in host-tools by an earlier release serves, and `office check` says which.

| Program | Installed by | Where | Version |
|---|---|---|---|
| mise, for the CLI | `office setup`, unless a mise on PATH is as new | `$XDG_DATA_HOME/office/host-tools/bin/mise` (`~/.local/share/office/…`) | The newest stable release at least three days old, checked against its SHA-256 |
| SOPS, age, gh, pre-commit | `office setup` on any host; in host mode also `office up`, through the links; the container at start | mise's own install folder, one copy that the CLI and, through the links, agents share | `machine.packages.toml`; the package's starting versions until `office sync` writes it |
| `host-tools/bin/gh` | `office setup` | A link to that gh | The path `gh auth setup-git` writes into git's credential helper, which stays the same across versions |
| sfw | `office up` in host mode; the image | See "Socket Firewall" | `office.yaml` |

`office setup` asks first (`--install-deps` says yes unattended; one yes covers mise and the tools), then installs the tools with one `mise install sops@… age@… gh@… pre-commit@…`, from `/` without config files and through Socket Firewall's mise wrapper once sfw is installed. That selects nothing anywhere: the tools apply in a folder only through the office's links or the container's. The very first setup needs SOPS and age before you have agreed to the machine links, and has them, since the CLI finds them without links. Once the office's copies are installed, setup removes what earlier releases installed privately in host-tools (their `sops`, `age` and `age-keygen`, and `host-tools/mise/`) and points `host-tools/bin/gh` at the office's gh. pre-commit needs Python 3 on the host; the image has it.

A pin of one of these tools in the office's own files (the root's `mise.toml`, or `machine.toml`) is yours, so office never edits it. It wins over `machine.packages.toml` where it applies, so agents can run another version than the CLI does: `office check` names each such pin, with its file, so you can remove it unless it holds the tool back on purpose.

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

A package can add a tab to the OpenCode desktop app's session side panel. Its `gui/` holds the source, a `package.json` with its build dependencies and the built bundle, such as `gui/dist/gui-experimental.cjs`, which is committed; the package registers that bundle in `setup` with `opencode.panels.add(ctx, { file })` from `@office/opencode` ([registering assets](docs/opencode-authoring.md)), and a bundle it doesn't register gives it no panel. Building is the package's own script, typically Vite with `@opencode/plugin/gui/vite`. The panel shows for sessions on any server and reads its data over RPC from the package's plugin on the session's own server (`props.session.server.client.rpc(...)`), so the plugin registers the RPC and the panel and plugin share its definition.

The app loads a panel only from its own sidecar server, which reads the config of the machine the app runs on. So for each package with a panel, `office sync`:

1. Works out that machine: this one on Linux or macOS; Windows when it runs in WSL (recognised by the kernel or its interop entry, with Windows' folders asked of `cmd.exe` and mapped with `wslpath`); none inside the office's container, where it says to run `office sync` on the host. When Windows can't be reached it says why and goes on.
2. Copies the bundle into the panel's own folder there, `%LOCALAPPDATA%\office\gui\<name>\` on Windows or `~/.local/share/office/gui/<name>/` (`$XDG_DATA_HOME`) on Linux and macOS. Windows sees no file changes under `\\wsl.localhost`, so the folder is on Windows' own disk. Beside it go a generated `package.json` that names the plugin `office-<name>` and exports only `./gui-experimental`, so the sidecar never runs the package's server half, and `office-panel.json`, recording the bundle's SHA-256 and the office that installed it.
3. Adds the folder's `file://` URL to `plugins` in that machine's `opencode.json` (`%USERPROFILE%\.config\opencode\`, or `~/.config/opencode/`; `opencode.jsonc` when that is the file there), changing nothing else in it, comments included, or nothing at all when the result wouldn't parse to the same configuration plus that entry. The sidecar watches the bundle and its config and reloads open windows within seconds.

`office check` reports each panel: installed, registered and this office's build. The install is per machine, so offices that share a panel replace each other's copy and the last sync wins; check names the office that installed a different build. When a package leaves `office.yaml`, its panel stays installed, since other offices may use it: sync (for a pulled-in package) and check say how to delete the folder and its `plugins` entry.

While building a local package's panel, `office gui dev <name>` watches the bundle the last sync applied for it and installs each new build, beside the package's own watch build; it runs no package code. `OFFICE_APP_CONFIG_DIR` and `OFFICE_APP_PANELS_DIR` together replace the app machine's config and panels folders, for tests and scratch offices.

### Services

A package can add containers to the office: a `compose.yaml` at its root is what gives it services, and nothing goes in `package.yaml` for it. `office up` adds each package's file to the compose project `office-<name>`, in either mode, after the tool's files and before the office's own `compose.yaml`, in package-name order, so the office's file can override a package's service.

```yaml
# packages/notes/package.yaml: its name and description are in its package.json
# namespace: notes             # what services, volumes and variables are named after; the name by default
settings:
  type: object
  additionalProperties: false
  properties:
    title: { type: string, default: Notes, description: The app's title }
    port: { type: integer, default: 41500, description: The loopback port the app is published on }
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
      - "127.0.0.1:${NOTES_PORT}:3000"
  notes-db:
    image: postgres:18
    volumes:
      - notes-data:/var/lib/postgresql
volumes:
  notes-data:
```

- **Names.** Every service, volume, network, config and secret the file defines is named after the package's namespace, `<namespace>` or `<namespace>-*`. The namespace defaults to the package's name. For example, `design` sets `namespace` to `doop` in its package definition, so its services are `doop` and `doop-db`. Namespaces use lowercase letters, digits and dashes. So packages can't define or change `executor`, `opencode` or each other's services: a namespace can't be `executor` or `opencode`, and two packages in an office can't claim the same one, which `office check` reports on both packages' lines and `office up` refuses, naming both.
- **Ports.** Every published port binds `127.0.0.1`: `"127.0.0.1:<port>:<port>"`, or `host_ip: 127.0.0.1` in the long syntax. `network_mode: host` is refused. `office check` reports a file that breaks these rules on the package's line, and `office up` refuses to apply it, naming each problem.
- **Paths.** Relative paths (a `build` context, a bind mount, an `env_file`) are the package's folder: `office up` includes each package's file with that folder as its project directory, since Compose would otherwise resolve them against the tool's own `compose.yaml`.
- **Variables.** Besides the office's variables (see "Runtime"), a package's file gets its settings as `<NAMESPACE>_<SETTING>` (the names in capitals, any character but letters and digits as `_`; `title` in `notes` is `NOTES_TITLE`) and its secrets. The applied settings are authoritative: the Compose launcher reads the generated `settings.env` into its environment, overriding shell variables and making the same values available to the office's compose file. Secrets remain scoped to the package's include; shell variables can override them.
- **Resources the services create.** A service given the Docker socket (an emulator starting containers, a CI runner) creates containers, networks and volumes that aren't part of the compose project, so `docker compose down` leaves them. If it labels them, declare the label in `package.yaml` as `spawns: { label: <key>=<value> }`: one label, letters, digits and `. _ -`, not a `com.docker.` key, its value holding `${OFFICE_NAME}` once (the only variable, replaced with the office's name) and the namespace as a part between `-`, `_` or `.`, such as `floci_namespace=office-${OFFICE_NAME}-floci`, so it can't match another office's or package's resources. `office down` then removes every container with the label, running or stopped, before stopping the services, so none keeps Compose from removing the office's network, and every network with the label after. Volumes with the label stay, as the package's own volumes do. The same happens on the `office up` that stops the services of a package that left `office.yaml`. `office check` warns about containers and networks with the label while the package's services are stopped.
- **Secrets.** Any installed package can declare `secrets:` in `package.yaml`, with or without `compose.yaml`. Each variable declares `bytes` random bytes (16 to 1024) as `hex` or `base64`, with an optional fixed `prefix`. Its name starts with the namespace in capitals with `_` for `-` (`NOTES_`) and can't be a setting's variable. `office up` generates only missing values in `<state>/packages/<name>.env` (mode 600); it never prints them. To rotate one, delete its line and run `office up`. Consumers opt in: `office secrets get notes NOTES_AUTH_SECRET` writes just that declared value, without a trailing newline, for a pipe or a service. It does not generate a missing value.

To decrypt a SOPS file instead, `office secrets decrypt secrets/example.enc.yaml` writes the full document as JSON using the host's age identity. Run secret-display commands in your own terminal, not in an agent transcript. `office executor credentials` remains the dedicated owner-login command.

`office up` runs the copy of each package's file it last applied, `<state>/packages/<name>/compose.yaml`, as it runs the versions it last applied:

- A package the office hasn't run before is applied on a plain `office up`.
- When a package's file changes, `office up` says so and keeps running the applied copy; `office check` shows it as pending. `office up --upgrade` stops that package's services, backs up each named volume its applied file declares to `backups/` (printing where each went), then applies the new file.
- If Docker cannot inspect an old backup volume by its exact name, the upgrade stops with the old definition still applied. The Docker CLI cannot distinguish a missing volume from denied access by exit code, so even a genuinely absent volume blocks this upgrade. Check the Docker context, inspect permission and storage driver. If data was lost, recover the original volume from a verified backup before retrying `office up --upgrade`. If the volume never existed, keep the upgrade pending and review the applied definition and storage history with the operator; there is no automatic skip.
- A package that leaves `office.yaml` stops contributing on the next `office up`, which removes its applied copy; its containers go as orphans, and what they created with its `spawns` label, kept beside the applied copy as `spawns.label`, goes too. Its volumes and secrets stay, so adding it back finds its data.
- `office down`, `office check` and every other command use the same applied files as `office up`.

Only the compose file is snapshotted, and a changed `spawns` label waits with a pending compose file: a package that builds from files in its own folder builds from the current files whenever Compose rebuilds. Package services have no downgrade guard. Settings aren't gated either: `office up` passes the current ones. `office sync` says when a pulled-in package's copy adds or changes a `compose.yaml`, because its services run on this machine's Docker.

### Host services

In host mode a package can also run a long-lived process under the office's systemd user manager:

```yaml
host:
  services:
    bridge:
      description: Connector MCP bridge
      script: services/start-bridge.sh
      # setting: enable_bridge  # optional boolean package setting
```

`office up` creates declared secrets, then enables and starts the unit. Its script runs from the package directory with the service user's `HOME`. Office puts the launcher directory, `~/.local/bin`, the mise shims and Bun's bin directory ahead of the user manager's PATH. It carries configured XDG, mise and Codex profile paths, not the invoking shell's environment. Ship dependencies or document which commands must already be installed. Launching a unit does not opt into machine management or mise auto-install.

The unit carries the installing office's name and absolute directory. Startup compares both directly with the machine record, without searching for `office.yaml`. Only a matching owner gets the recorded environment, verified against its digest. An unclaimed host needs no `env.sh`; unsafe or changed owned files are errors. When `CODEX_HOME` wasn't set at render time, the manager's profile remains in effect unless the verified machine environment sets it. If neither sets it, Codex uses its normal home.

`office check` reports the unit's state. A changed unit definition waits for `office up --upgrade`; a unit from the earlier name-less `env host-service` launcher must be upgraded before it can start with this executable. Disabling or removing a unit takes effect on `office up`. `office down` disables and removes the office's generated units. Updating code at the same script path takes effect on the next service restart.

### Executor apps

A package can ship an Executor app in `executor-app/` (a `package.json` and `index.ts`, as for the office's own apps) and declare it in `package.yaml`:

```yaml
executor_app:
  setting: executor_app   # optional: a setting whose default is true or false; the app deploys only while it's true
```

`office apps deploy` deploys it under the package's namespace beside the office's own apps, and `office check` lists it with them. Two apps with one slug, such as a package's and a folder in `executor-apps/`, are an error naming both. The folder is read-only in `.office/packages/`, so deploy never edits it: it sends `package.json` with the `apps` version Executor serves, and in place of the app's `package.ts` a generated module, `export const settings = {...}` with the package's resolved settings and `export const opencode = "host" | "container"`. The package's own `package.ts` holds the defaults in the same shape, for type-checking. Deploy then prints a link to Executor's connect page for each account of the app's own (scope `app`) that has nothing linked, or only an account of a provider the app no longer declares; the person whose account it is connects it there. The design package's `doop` app is the example.

### Office's plumbing stays out of Git

Git holds what you author: `office.yaml`, `office.lock`, `packages/<name>/`, `executor-apps/`, `skills/`, docs, and your own `.opencode/` config, plugins and skills, and the folders packages declare `committed` under `.office/`, such as the `seeds` package's `.office/seeds/`: the receipts and the bytes of each seed a receipt names (see "Seeds"). What `office sync` rebuilds is not committed: the rest of `.office/` (pulled-in packages, Git-cloned plugins, mise fragments, generated state, staging), `packages/node_modules/`, Office's links in the root's `.opencode/plugins/`, and the links the `skills` package records in `.agents/skills/`. A plugin entry is Office's when it is a link whose target is one Office writes (a package's plugin, a clone in `.office/plugins/<name>`); a skill link is the `skills` package's while its receipt records it with that target. Real folders, files and other links are yours, stay visible to Git, and are never changed. Sync keeps its plumbing out of commits with one delimited block in the repository's `info/exclude`, which excludes `/.office/*`, takes back `!/.office/<name>/` for each committed folder (sorted, from a package set applied whole; a sync with a package unread or stopped leaves the block as it is, except the lines a package changes at once: `office skills update` for the links it makes and removes, and a skills sync or update that stops, for a recorded link that is no longer its own), excludes the editor link folder `/packages/node_modules/` and each of those links by its exact path, and never edits your `.gitignore` (an ignore rule of your own that covers `.office/` hides the store too). Root `repos/` and `scratch/` hold checkouts and files of their own, never the office's: the template's `.gitignore` ignores both, whether or not a package manages them, and `office check` fails when the office's rules no longer ignore one, when the office's repository already tracks files in one (an ignore rule doesn't untrack them), or when Git can't be asked, without changing the rules or the index. `office check` warns when a receipt's seed is missing from the store or doesn't hash to its name, as on a clone of a commit without `.office/seeds/`: restore it from Git, or, if it was never committed, copy the file as office laid it down to `.office/seeds/<sha256>`. Git-cloned plugins (`plugins:` in `office.yaml`) are checked out in `.office/plugins/<name>` and linked as `.opencode/plugins/<name>`. A fresh clone has no plumbing until `office sync` runs; the container runs it before OpenCode starts, and on the host run it once after cloning. Details: [OpenCode sources](docs/opencode-sources.md#who-owns-each-source).

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
3. **GitHub**, when `office.yaml` has `credentials: gh`, which both declares that the office uses the host's gh login and authorizes what that needs, so unattended setup needs nothing more. It reuses a working `gh auth status` login; otherwise it runs `gh auth login --web --git-protocol https` (with `--insecure-storage --expiring=false` in container mode) in your terminal, and unattended it stops with that command, since a browser login needs you. It runs `gh auth setup-git` when git doesn't use gh for the host (this writes your global git config, so setup says so; for an office-installed gh it records the stable `host-tools/bin/gh` link through `GH_PATH`); in container mode `office up` then shares the login with the container, whose gh is the office package's. Without the key there is no GitHub step and nothing is mounted. If a source on a GitHub host doesn't read without a login (checked with no credentials), interactive setup offers to set GitHub up and writes `credentials: gh` when you accept; unattended setup stops before cloning, naming the key. A repository a package declares read-write, such as a working repository, that reads without a login only gets a one-line note naming the key, never a prompt. SSH remotes are left to your own SSH setup.
4. **Every source is read** (references, plugins, packages, and the repositories packages declare, such as the `skills` package's Git sources and the `repos` package's working repositories) with this host's git credentials before anything is cloned, and any that doesn't read stops setup with the likely cause: not logged in, no access, or organization SSO authorization.

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

To describe an Executor app in session instructions, set `description` in its `package.json`.

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

An earlier `office` had a Claude gateway (a `claude:` block feeding Claude Code a gateway token and base URL). It is gone: delete the `claude:` block and retire its credential and settings. After recreating the old container, check for the old plaintext `<state>/runtime/claude/gateway.json` and remove it if no other installation uses it. The container still ships Claude Code at the version `office.yaml` pins for `claude`.

## Not yet

- Apps share one Executor token; scoped connections per app need a browser sign-in from the container.
- Containers aren't blocked from the LAN.
