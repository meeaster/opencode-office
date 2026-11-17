# knowledge

An `office` package: every session, at the root or in a desk, gets the list of the office's knowledge articles with their descriptions, so an agent reads an article when it matches the task. The list is read again on each prompt, so an article added during a session shows up on the next prompt.

An article is a Markdown file anywhere under the office's `knowledge/` (each folder's `README.md` is left out), with front matter whose `description` says when to read it:

```markdown
---
description: How the nightly export works and what to do when it fails
---
```

## Install

`office init` adds it to every new office. To add it to another office, put this in `office.yaml`, with `ref` a tag or a full 40-character commit SHA of this repository:

```yaml
packages:
  - name: knowledge
    repo: https://github.com/meeaster/opencode-office.git
    path: packages/knowledge
    ref: <commit or tag>
```

Then run `office sync` and commit what it wrote. It has no settings.

## What it holds

| Path | |
|---|---|
| `plugin/index.ts` | The OpenCode plugin, which `office sync` links as `.opencode/plugins/knowledge`. It finds the office as the nearest folder above it with an `office.yaml`, creates `knowledge/` when missing, and attaches the list to each session as the instruction entry `knowledge` |
| `template/knowledge/README.md` | Copied once into the office: how to write an article. The office owns the copy and every article |
