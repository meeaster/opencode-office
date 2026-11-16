---
name: office
description: Change this office's structure - desks, references, desk repositories, skills, plugins, Executor apps or cron jobs - with office.yaml and the office command.
---

# Working on the office

The office's structure is declared in `office.yaml` at its root and applied with the `office` command (from any folder inside the office).

| To | Do |
|---|---|
| Add a desk | Add it under `desks:` with a description, then `office sync`. Sync scaffolds `<desk>/` with `AGENTS.md`, `.opencode/opencode.jsonc`, `mise.toml` and a starter Executor app. Deploy the app with `office apps deploy` |
| Clone a repository for a desk | Add `{ name, url, description }` under `desks.<desk>.repos`, then `office sync`. It lands in `<desk>/repos/<name>/` |
| Add a reference | Add `{ name, url, ref?, description }` under `references:`, then `office sync`. It lands in `references/<name>/`, read-only |
| Add a skill | Create `skills/<id>/SKILL.md`, enable it under `skills.enabled` (every desk) or `desks.<desk>.skills` (one desk), then `office sync` to link it |
| Copy a skill from another repository | Add `{ name, repo, ref, path }` under `skills.copied`, enable it, then `office sync`. Commit the copy |
| Add a plugin | A local plugin goes in `.opencode/plugins/<name>/`; `office` and `knowledge` there belong to the tool, and `office sync` replaces edits to them. A published one is one line in `.opencode/opencode.jsonc` `plugins`. One developed in another repository goes under `plugins:` in `office.yaml` |
| Change a desk's Executor app | Edit `<desk>/executor/apps/<desk>/`, then `office apps deploy` |
| Add a file-system job | Add a script to `cron/` and a line to `cron/crontab`: a five-field cron expression (UTC) or `@daily`, then the command, run from the office root. Restart the container with `office up`. A job that exits 0 is stamped; one missed while the container was down runs at its next start |
| Pin a tool | Exact versions in the root's or a desk's `mise.toml`. The daily `upgrade-tools` job bumps them and commits as `office cron`; it skips a file with uncommitted changes |
| Change the OpenCode, Claude Code, Executor or mise version | Edit `versions:` in `office.yaml`, run `office pin`, commit `office.yaml` and `office.lock`, then `office up --upgrade`. The daily job bumps them too, waiting the ages under `upgrades:`; it never restarts anything. Never set an older OpenCode or Executor than the office has run |

`office check` reports drift between `office.yaml` and the folders. `office instructions [folder]` prints the guidance the office plugin gives a session in that folder.
