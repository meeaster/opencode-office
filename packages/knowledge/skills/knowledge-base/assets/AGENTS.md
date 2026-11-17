---
knowledge-base-format: 2
---

# {{name}} knowledge base

{{what this knowledge base covers, and who reads it}}

This folder is a knowledge base kept with the `knowledge-base` skill. Load that skill before changing anything here.

## Looking something up

1. Start from the list of articles and their descriptions in your session context. Without one, run `grep -r "^description:" articles/` from this folder.
2. Read the articles whose descriptions match, and any article they link to that bears on the question.
3. Answer from the articles: the latest established understanding, not an investigation history or live status feed. Cite the article and the sections you used. Open an article's references (`references/<subject>.md`, linked at its end) only when asked where a claim comes from or when it was observed, or to check one; an observation date there neither guarantees current correctness nor makes an older claim wrong. Open `sources/` or `evidence/` only when the articles don't answer the question or you're asked to check a claim. When a decision depends on current operational state, check the authoritative system rather than treating an article as live telemetry.

## Rules that always hold

- Never change what is already written in `sources/` or `evidence/`. A thread may grow at its end; a later look at a system is new evidence.
- Every claim in an article is backed by its references file, `references/<subject>.md`, which cites only files in this folder or origins listed in `origins.md`.
- After any change, run the skill's `check` on this folder.

## Local rules

{{rules particular to this knowledge base, or "None."}}
