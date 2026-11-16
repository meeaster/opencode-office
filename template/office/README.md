# __OFFICE__ office

An office is a source-controlled folder of desks for OpenCode. The folder a session starts in decides what the agent knows and can do. It is run with the `office` command; `office --help` lists its commands.

## Layout

| Path | Holds |
|---|---|
| `office.yaml` | The versions the containers run, how old a release must be before the daily job bumps them, the desks, references, desk repositories, enabled skills, copied skills and cloned plugins |
| `office.lock` | The checksum of each version in `office.yaml`, written by `office pin`; don't edit it |
| `AGENTS.md`, `.opencode/opencode.jsonc` | Your instructions and config for every session. No tool writes to `AGENTS.md` |
| `skills/<id>/` | The skill library. Only skills `office.yaml` enables are linked into a `.opencode/skills/` |
| `.opencode/plugins/` | OpenCode plugins every session loads: `office` (the office's guidance for the session's folder; `office instructions` prints it) and `knowledge`. Both belong to the `office` tool: `office sync` replaces these copies with its own, and `office check` reports a copy that differs, so change them in the tool |
| `knowledge/` | Articles every session sees listed |
| `mise.toml` | Tools every desk gets; a desk's own `mise.toml` adds more |
| `executor/apps/` | Executor apps the whole office shares, such as `opencode` (start a session and wait for it) |
| `cron/` | `crontab` and the scripts it runs, for jobs that need the file system: in the container, or as systemd user timers in host mode. A job missed while the computer was off runs at the next start. `upgrade-tools.sh` commits daily bumps of the `mise.toml` pins as `office cron`; revert such a commit to undo it |
| `references/` | Read-only clones, gitignored |
| `<desk>/` | A desk: `AGENTS.md`, `.opencode/`, `mise.toml`, its Executor app in `executor/apps/<desk>/`, and gitignored `repos/` and `scratch/` |
| `Dockerfile`, `compose.yaml` | Optional: system packages on top of the base image, and extra services `office up` starts |
| `.pre-commit-config.yaml` | The gitleaks hook, which blocks commits that contain secrets |

## Conventions

- Run `pre-commit install` once in each clone, before your first commit. The container installs pre-commit from `mise.toml`, so commits made there run the hook too.
- OpenCode, Claude Code, Executor and mise run at the versions in `office.yaml`. The daily `upgrade-tools` job bumps them and commits as `office cron`; nothing restarts until you run `office up --upgrade`, which backs up and applies them (`office up` alone keeps the applied versions and says what is pending). After changing a version by hand, run `office pin`. An office never goes back to an older OpenCode or Executor.
- `office pair` prints a one-time link that connects the OpenCode app or a browser to this office.

- Change `office.yaml`, then run `office sync`. It clones, refreshes the tool's plugins, scaffolds missing desks and links skills; it never overwrites hand-written content.
- A desk's jobs are code in its Executor app: a schedule or webhook starts a workflow, which can run an OpenCode session in the desk's folder (`agent.ask`).
- Skills enabled at the root reach every desk. Enable a skill for one desk under `desks.<desk>.skills`.
- `office check` reports drift between `office.yaml` and the folders, and the running containers' state.
- OpenCode runs in the office's container or, with `opencode: { mode: host, url: ... }` in `office.yaml`, on a server already running on the host. Executor always runs in a container. After switching, run `office up` and `office apps deploy`.
