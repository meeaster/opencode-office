---
name: office
description: Configure or onboard this office with office.yaml and office setup; change desks, references, skills, plugins, packages, Executor apps, cron jobs, its git identity or GitHub access.
---

# Working on the office

Use `office` from any folder inside the office; `office.yaml` declares its structure. For onboarding after init/clone, run `office setup`. Credential display is human-only: let the human run `office executor credentials` in their terminal, keeping passwords out of agent transcripts. Private age identities and runtime state belong outside the repo; commit only public recipients and SOPS-encrypted records.

| To | Do |
|---|---|
| Add a desk | Add it under `desks:` with a description, then `office sync`. Sync scaffolds `<desk>/` with `AGENTS.md`, `.opencode/opencode.jsonc`, `mise.toml` and a starter Executor app (unless the desk sets `app: false`). Deploy the app with `office apps deploy` |
| Clone a repository for a desk | Add `{ name, url, description }` under `desks.<desk>.repos`, then `office sync` |
| Add a reference | Add `{ name, url, ref?, description }` under `references:`, then `office sync` |
| Add a skill | Create `skills/<id>/SKILL.md`, enable it under `skills.enabled` (every desk) or `desks.<desk>.skills` (one desk), then `office sync` to link it |
| Copy a skill from another repository | Add `{ name, repo, ref, path }` under `skills.copied`, enable it, then `office sync`. Commit the copy |
| Add a plugin | A local plugin goes in `.opencode/plugins/<name>/`; the links there are packages' plugins, which `office sync` keeps. A published one is one line in `.opencode/opencode.jsonc` `plugins`. One developed in another repository goes under `plugins:` in `office.yaml` |
| Add a package | A built-in one (`knowledge`, `artifact-share`) is `{ name, settings }` under `packages:`; one from another repository is `{ name, repo, path, ref, settings }` (`ref` a tag or full commit SHA). `settings` are as its `package.yaml` declares. Then `office sync` and commit what it writes: it installs the package in `.office/packages/<name>/`. Its plugin loads everywhere with no `opencode.jsonc` edit and provides what the package gives OpenCode, its skills and MCP servers included, with no `skills.enabled` entry; files it creates outside its folder are the office's, created once (a deleted one stays deleted). A built-in package updates with `office`; a copied one when you change `ref` and sync |
| Remove a package | Delete its entry under `packages:`, then `office sync` and commit. For a built-in or copied package, sync removes `.office/packages/<name>/` and each file it created that is unchanged, keeps and names the changed ones, and leaves the office's own files. A package written for this office stays until you delete its folder. The `office` package can't be removed |
| Change a package in `.office/packages/` | Don't edit it there: those copies are read-only, `office check` fails on an edit and `office sync` restores the copy. Copy the package into `packages/<another name>/`, list that instead of the original, and sync |
| Write a package for this office | `packages/<name>/` (not a built-in package's name) with `package.yaml` (`name`, `description`, `settings`, each with `description` and `default` or `required: true`), `skills/<id>/SKILL.md` (loaded only when the package's plugin registers them with `ctx.skill.transform`), `plugin/` (an OpenCode plugin importing only Node's and Bun's built-ins, `@opencode/plugin` and `effect`, finding its package folder with `realpathSync` and the office by walking up to `office.yaml`, and reading its package's `.settings.json` itself), `scripts/`, `template/`; list it under `packages:` with only its `name` and `settings`, then `office sync` |
| Change a desk's Executor app | Edit `<desk>/executor/apps/<desk>/`, then `office apps deploy` |
| Add a file-system job | Add a script to `cron/` and a line to `cron/crontab`: a five-field cron expression (UTC) or `@daily`, then the command, run from the office root. Restart the container with `office up`. A job that exits 0 is stamped; one missed while the container was down runs at its next start |
| Pin a tool | Exact versions in the root's or a desk's `mise.toml`. The daily `upgrade-tools` job bumps them and commits as the office's identity, else `office cron`; it skips a file with uncommitted changes |
| Set who the office commits as | `git: { name, email }` in `office.yaml`, then `office up`. It is the container's git default and the cron jobs' identity; a repository's own config overrides it |
| Clone or push a private GitHub repository | Add `credentials: gh` under `git:` in `office.yaml`, then the user runs `office setup` on the host: gh, their browser login, `gh auth setup-git` and a gh pin in `mise.toml`. The login belongs to the user: never run `gh auth login`, `logout` or `switch` from a session |
| Let a service in `compose.yaml` call Executor | Add `env_file: [{ path: "${OFFICE_STATE}/office-executor.env", required: false }]` and `EXECUTOR_URL: http://executor:4400` to the service, then `office up`. It gets the office's key as `EXECUTOR_TOKEN` and `EXECUTOR_ORGANIZATION`; never print or copy them |
| Run a command in the container from the host | `office exec -- <command>`, or `office shell`, from the folder it should run in |
| Change the OpenCode, Claude Code, Executor or mise version | Edit `versions:` in `office.yaml`, run `office pin`, commit `office.yaml` and `office.lock`, then `office up --upgrade`. The daily job bumps them too, waiting the ages under `upgrades:`; it never restarts anything. Never set an older OpenCode or Executor than the office has run |
| Update the container's Debian packages, Chromium among them | `office up --refresh` rebuilds the image with current ones and restarts the container. In container mode a host systemd timer runs it every Sunday; `office check` warns when the last refresh is more than eight days old |

`office check` reports drift between `office.yaml` and the folders. `office instructions [folder]` prints the guidance the office plugin gives a session in that folder.
