# Migrate free-form office knowledge

Existing offices may keep articles anywhere under `knowledge/`, with only a `description`. The plugin still lists those legacy articles, except reserved guidance files and the `references/`, `sources/`, and `evidence/` folders. Sync preserves user files and does not convert them.

1. Inventory the legacy articles and their links. Explain the proposed moves, missing provenance, and any files in reserved folders whose purpose is unclear. Get approval for the conversion.
2. Keep existing local guidance. Add the format 2 front matter and reconcile its rules with the package's seed (`seed/knowledge/AGENTS.md`), rather than replacing it.
3. For each approved subject, move its maintained explanation to `articles/<subject>.md`. Repair incoming and outgoing links. Capture supporting material inside the base, record origins and access methods, and create `references/<subject>.md`. Preserve unknowns as unknowns; a migration is not permission to invent provenance or refresh research.
4. Run the checker and report remaining legacy paths. Outside the maintained folders, Markdown remains discoverable as legacy and the checker warns that it is not format-checked.

The script's `migrate` command converts only format 1 articles that already have inline References sections. It does not convert arbitrary free-form articles.
