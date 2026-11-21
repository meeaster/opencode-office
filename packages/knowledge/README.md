# knowledge

This built-in `office` package lists knowledge articles in every session and delivers the `knowledge-base` skill with its checker. The list refreshes on each prompt. The plugin reads files but never writes knowledge.

## Install

New offices include the package. For another office, add it to `office.yaml`:

```yaml
packages:
  - name: knowledge
```

Run `office sync`. The package in `.office/packages/knowledge/` follows the executable and is read-only. Sync copies new seed files (`seed/`) only when the office has not handled them before, and preserves files already there. The office owns `knowledge/`. The package has no settings.

## Plain-file knowledge

| Path under `knowledge/` | Content |
|---|---|
| `AGENTS.md` | Office-owned scope, lookup steps, and local rules |
| `articles/<subject>.md` | Maintained current understanding, with `description` and `updated` front matter |
| `references/<subject>.md` | Section-specific provenance and observation dates for the matching article |
| `sources/` | Preserved statements, meetings, pages, and threads; only threads may grow at their end |
| `evidence/` | Immutable observations; a later look produces a new file |
| `origins.md` | Source systems and access methods, without credentials |

Only articles appear in the session list. Guidance, references, sources, and evidence do not. Article descriptions tell the agent when to read them. Articles explain durable understanding, not investigation histories or live operational status.

Agents read relevant articles proactively and may suggest specific additions that save future research. Writing, capturing, and re-checking require a request or an explicit assignment. "Save this" preserves material; "write this up" synthesizes maintained articles. The package performs no automatic curation or ongoing maintenance.

The plugin registers its own skill, including its absolute path so references resolve from the installed package. From the office root, run the checker with:

```sh
bun .office/packages/knowledge/skills/knowledge-base/scripts/kb.mjs check knowledge
```

The script also provides `init`, `stale`, and `migrate`; use `--help` for their arguments. Checks cover metadata, local links, origins, supported headings, and source and evidence preservation against Git HEAD. Outside Git, preservation cannot be verified. Article meaning and provenance completeness still require review.

## Existing offices

Free-form Markdown articles outside `articles/` remain listed as legacy, except reserved guidance files and provenance folders. The checker warns that these files are not format-checked. Sync neither moves articles nor invents references.

Load the skill's [migration guide](skills/knowledge-base/references/migration.md) before an approved conversion. The script's `migrate` command handles only format 1's inline References sections, not free-form office articles. Existing office-owned `AGENTS.md` and README copies need manual reconciliation when the new guidance is wanted.

The format, references, and checker are adapted from Cairn's plain-file knowledge-base skill.
