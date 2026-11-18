# __OFFICE__ office

An office is a source-controlled folder of desks for OpenCode. The folder a session starts in decides what the agent knows and can do. It is run with the `office` command; `office --help` lists its commands.

After init or clone, run `office setup` to resume onboarding. It guides host prerequisites, SOPS/age enrollment and owner email, creates Executor's owner/token without browser copying, starts OpenCode, deploys apps and checks. Review `cron/crontab` first: missed jobs run at container startup. Provider sign-in remains human-controlled; use `office pair` for the app.

Setup asks before installing or updating host mise, SOPS and age to exact stable releases at least three days old. Declining keeps working installed tools, and newer installed versions are never downgraded. Managed copies live under `$XDG_DATA_HOME/office/host-tools`, defaulting to `~/.local/share/office/host-tools`. Office resolves them without shell activation, global mise selection changes or shell profile edits. For unattended setup, `--install-deps` authorizes these changes; otherwise missing tools stop setup without a prompt. Docker with its daemon and Git remain separately installed prerequisites. Identity creation still requires `--generate-age-key` or interactive consent, and a new owner still needs `--owner-email <email>` or interactive input.

`office.yaml`'s `git` block declares who the office commits as (`name`, `email`) and whether it uses your GitHub login through gh (`credentials: gh`); setup reads it and, when interactive, offers to fill it in (the identity from your global git identity, the key when a source doesn't read without a login). With `credentials: gh`, setup sets GitHub up without further options: gh on the host (installed like mise, SOPS and age), one browser login made with `gh auth login` on the host (unattended, setup stops with that command), gh as git's HTTPS credential helper (`gh auth setup-git`, which writes your global git config) and a gh pin in `mise.toml`; `office up` shares the host's gh configuration read-only with the container. Without it there is no GitHub step. Before cloning, setup reads every source and names any that doesn't read, with the likely cause. In container mode the login must be in gh's `hosts.yml` (not the system keyring) and not an expiring token; setup says when it isn't.

`office shell` opens a shell in the running container, in the folder matching the one you are in; `office exec -- <command>` runs one command there. Neither starts anything.

Portable owner credentials are SOPS-encrypted in `secrets/executor-owner.enc.json`, selected by `secrets.executor_owner` in `office.yaml`. Commit encrypted records and public `.sops.yaml` recipients yourself; keep age private identities and runtime state outside this repository. `office executor credentials` deliberately reveals the stored owner login, even offline; `--password-only` is suitable for a clipboard pipe. Never put its output in logs or agent transcripts.

## Layout

| Path | Holds |
|---|---|
| `office.yaml` | The versions the containers run (and Socket Firewall's), how old a release must be before the daily job bumps them, whether package downloads go through Socket Firewall (`socket_firewall`), the desks, references, desk repositories, enabled skills, copied skills and cloned plugins |
| `office.lock` | The checksum of each version in `office.yaml`, written by `office pin`; don't edit it |
| `AGENTS.md`, `.opencode/opencode.jsonc` | Your instructions and config for every session. No tool writes to `AGENTS.md` |
| `skills/<id>/` | The skill library. Only skills `office.yaml` enables are linked into a `.opencode/skills/` |
| `.opencode/plugins/` | OpenCode plugins every session loads: a link to each package's plugin, which `office sync` keeps, and any of your own |
| `.office/packages/` | Packages pulled into the office, committed so a clone needs nothing fetched: built-in ones from the `office` executable, such as `office` (the guidance for a session's folder, which `office instructions` prints, the `office` skill and the `office-executor` MCP server) and `knowledge` (lists the articles in `knowledge/` in every session), and ones copied from another repository. They are read-only: `office check` reports an edit and `office sync` restores the copy. To change one, copy it into `packages/` under a name of your own |
| `.office/mise/` | The mise tools packages declare, one file per package, written by `office sync` and committed; change only their versions. `.office/` is the tool's: what you edit is at the root |
| `packages/` | Packages written in this office |
| `knowledge/` | Articles every session sees listed, through the `knowledge` package |
| `mise.toml` | Tools every desk gets; a desk's own `mise.toml` adds more |
| `machine.toml` | Machine-wide tools and mise settings, the office's own. mise loads it only through a link in its global conf.d, after the packages' tools in `.office/mise/` (whose list `office sync` owns): in host mode sync makes the links once you agree in `office setup`, and the container makes them inside itself. Inside a folder with a `mise.toml`, that file wins |
| `executor/apps/` | Executor apps the whole office shares, such as `opencode` (start a session and wait for it) |
| `cron/` | `crontab` and the scripts it runs, for jobs that need the file system: in the container, or as systemd user timers in host mode. A job missed while the computer was off runs at the next start. `upgrade-tools.sh` commits daily bumps of the pins in the `mise.toml` files, `machine.toml` and `.office/mise/` as the office's git identity, else `office cron`; revert such a commit to undo it |
| `references/` | Read-only clones, gitignored |
| `<desk>/` | A desk: `AGENTS.md`, `.opencode/`, `mise.toml`, its Executor app in `executor/apps/<desk>/` (none with `app: false` in `office.yaml`), and gitignored `repos/` and `scratch/` |
| `Dockerfile`, `compose.yaml` | Optional: system packages on top of the base image, and extra services `office up` starts. A service reaches Executor with the office's key: `env_file: [{ path: "${OFFICE_STATE}/office-executor.env", required: false }]` gives it `EXECUTOR_TOKEN` and `EXECUTOR_ORGANIZATION`, and Executor is at `http://executor:4400` |
| `.pre-commit-config.yaml` | The gitleaks hook, which blocks commits that contain secrets |

## Conventions

- `office init` and `office setup` install git's pre-commit hook in this clone (`pre-commit install`, with the pre-commit the office package provides in `.office/mise/office.toml`), so commits run the gitleaks hook; they leave a hook of your own alone, and `office check` says the hook's state. In another clone, run `pre-commit install` there before your first commit. The container has the same pre-commit, so commits made there run the hook too.
- OpenCode, Claude Code, Executor and mise run at the versions in `office.yaml`. The daily `upgrade-tools` job bumps them and commits as the office's git identity (else `office cron`); nothing restarts until you run `office up --upgrade`, which backs up and applies them (`office up` alone keeps the applied versions and says what is pending). After changing a version by hand, run `office pin`. An office never goes back to an older OpenCode or Executor.
- `office pair` prints a one-time link that connects the OpenCode app or a browser to this office.

- Change `office.yaml`, then run `office sync`. It clones, scaffolds missing desks, installs, updates, restores and removes packages and links library skills and package plugins; it never overwrites hand-written content.
- A desk's jobs are code in its Executor app: a schedule or webhook starts a workflow, which can run an OpenCode session in the desk's folder (`agent.ask`).
- Skills enabled at the root reach every desk. Enable a skill for one desk under `desks.<desk>.skills`.
- `office check` reports drift between `office.yaml` and the folders, and the running containers' state.
- OpenCode runs in the office's container or, with `opencode: { mode: host, url: ... }` in `office.yaml`, on a server already running on the host. Executor always runs in a container. After switching, run `office up` and `office apps deploy`.
