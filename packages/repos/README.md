# repos

This built-in `office` package keeps the office's working repositories: the checkouts under `repos/` that people and agents edit, commit in and push from. Each has a name and a description; one with a URL is cloned and fetched by `office sync`, one without is listed only. Every new OpenCode and Claude Code session in the office gets the whole inventory, missing checkouts included.

Read-only checkouts to look things up in are references (`references:` in `office.yaml`), not working repositories.

## Install

Add the package and its entries to `office.yaml`:

```yaml
packages:
  - name: repos
    settings:
      entries:
        - name: opencode-office
          description: Office CLI and shipped packages.
          url: https://github.com/example/opencode-office.git
        - name: notes
          description: Personal notes and planning.
```

Run `office sync`. It clones `repos/opencode-office/` and leaves `repos/notes/` for you to create: a checkout without a URL has no remote for the office to use, and the office never guesses one from Git config.

| Field | Meaning |
|---|---|
| `name` | Its folder, `repos/<name>/`: one folder name of letters, digits, `.`, `-` and `_`, starting with a letter or digit. Each name once. |
| `description` | What it holds, which every session reads. Required and not blank. |
| `url` | Its origin, as Git clones it. Optional: without it the checkout is local only. |
| `ref` | The branch or tag the first clone checks out. Only with a `url`. |

A wrong entry (a repeated or unsafe name, a blank description, a `ref` without a `url`) is named and stops this package's checkouts before any Git runs: `office sync` rejects it with the package's settings, and `office setup` before it clones anything.

## What sync does

Only a full `office sync` (and the sync `office setup` and `office refresh` run) touches checkouts; `office sync --packages` and `office packages update` don't. Each entry with a URL is one item of the sync:

- **Missing:** cloned, at `ref` when it has one.
- **A checkout whose origin is the declared URL:** fetched from origin into its remote-tracking branches (`refs/remotes/origin/*`) only, whatever fetch mapping the checkout configures: no tags, no pruning, no submodules. Fetches of linked worktrees that share Git metadata run one at a time within a sync. `HEAD`, the branches, the index and the working files stay as they are. Sync says when upstream has commits you haven't merged. The origin is the first `remote.origin.url`, the one Git fetches from, and must lead where the declared URL leads, after Git's `url.<base>.insteadOf` rules (the checkout's own included); a relative local `url` is relative to the office.
- **Anything else** (a folder that isn't a checkout of its own, a checkout with another or no origin, a link at `repos/` or at the checkout, a linked worktree whose Git metadata is outside `repos/`): named as a failure, never fetched, and left as it is. Messages hide the credentials in any URL.

`office sync --verbose` shows Git's progress under each checkout as it comes; otherwise Git says only what went wrong.

A failed item makes `office sync` exit 1 while the other checkouts, references and packages still complete. Sync runs no Git on a local-only entry.

`office setup` plans GitHub access for each entry with a URL as one the office pushes to, from `office.yaml` as it is, before the first sync. `office check` reports a missing checkout, and anything sync wouldn't fetch, without fetching; every session's inventory says the same of each folder (missing, or not a checkout here). A local-only checkout is read, never written: its folder may be a link.

## Removing an entry or the package

Removing an entry, or the package, stops sync managing the checkout and sessions listing it. The folder, its commits and its local changes stay; delete it yourself when you no longer want it.

The office's `.gitignore` keeps `repos/` (and `scratch/`) out of the office's own repository, whether or not the package is selected; `office check` says when the office's rules no longer ignore them, or when the office's repository already tracks files in them.
