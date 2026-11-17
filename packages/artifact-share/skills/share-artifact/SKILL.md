---
name: share-artifact
description: Share a page, report or document as a published artifact on the office's GitHub Pages site, which may be public. Use only when the user asks to share, publish or update an artifact.
---

# Sharing an artifact

An artifact is one folder in the office root's `artifacts/`, published to a GitHub Pages site with an index page. From a desk, write to the root's `artifacts/`, never to a folder of the desk.

1. **Folder.** `artifacts/<name>/`, with `<name>` in lowercase words and dashes naming what it explains (`q3-latency-findings`, not `report-2`); `themes` is taken by the site's own themes. To update an artifact, change its existing folder; its link stays the same.
2. **Page.** Write a self-contained `index.html`: styles and scripts inline, a `<title>` and a `<meta name="description">` (the index shows both on the artifact's card), nothing loaded from other sites. Images and other files go beside it, linked by relative paths. A Markdown file (`index.md`) also works: the site renders it to an HTML page titled by its first heading, with the `.md` file beside it, and the index shows its first paragraph as the description, so open with a sentence that says what the artifact is. Raw HTML in it shows as text and links other than http, https, mailto and relative ones are dropped, so anything needing markup or scripts is an `index.html`. In Markdown, a ```` ```mermaid ```` block becomes a diagram (see [Diagrams](#diagrams)), a ```` ```diff ```` block shows added and removed lines, and a block tagged with its language (` ```ts `, ` ```python `, ` ```sh `, ` ```sql `, ` ```json ` and most others) is highlighted, all in the reader's theme. Rendered pages and the index follow the theme the reader picks; an `index.html` is shown exactly as written.
3. **Preview.** From the office root, build the site into a new temporary folder and open its `index.html`, checking the index entry and the page:

   ```sh
   bun .office/packages/artifact-share/scripts/build-site.ts "$(mktemp -d)/site"
   ```

   A Mermaid block that doesn't parse stops the build with the artifact's file, the block's number among the page's mermaid blocks (the first is block 1) and the line and column within it to fix. Where `bun` isn't installed, as in the office's container, `BUN_BE_BUN=1 office .office/packages/artifact-share/scripts/build-site.ts "$(mktemp -d)/site"` runs it with the `office` executable.
4. **Publish.** Commit the folder. A push to `main` publishes it through the `publish-artifacts` workflow; push only when the user asks to publish.
5. **Link.** Give the user `<url>/<name>/`, with `url` from `.office/packages/artifact-share/.settings.json`. It works once the workflow has deployed the push.

The site may be public: on a personal GitHub account it is, even when the repository is private. Share only what the user chose to share.

## Diagrams

The site draws Mermaid syntax with its own renderer, which accepts what its reference examples show. Find the diagram's type below, read only that reference, and start from its closest example. A block that doesn't parse fails the whole build and nothing publishes, so preview every page with diagrams.

- **Colours come from the reader's theme.** Leave colours and themes out (`style`, colours in `classDef`, `themeVariables`, a `theme` in front matter): a fixed colour stays the same in every theme and can vanish on a dark one.
- **Width.** A left-to-right diagram wider than the text column (about 640 pixels) is laid out top to bottom.
- **Links.** `click` links keep http, https, mailto and relative addresses; others are dropped.
- **Labels.** HTML tags in labels are dropped, keeping their text; images and icons (`img:`, `fa:`) aren't drawn.

<!-- diagram types -->
| First line | Examples |
|---|---|
| `agentflow-beta` | [references/agentflow.md](references/agentflow.md) |
| `architecture-beta` | [references/architecture.md](references/architecture.md) |
| `block` | [references/block.md](references/block.md) |
| `C4Context`, `C4Container`, `C4Component`, `C4Dynamic`, `C4Deployment` | [references/c4.md](references/c4.md) |
| `classDiagram` | [references/class.md](references/class.md) |
| `cynefin-beta` | [references/cynefin.md](references/cynefin.md) |
| `erDiagram` | [references/er.md](references/er.md) |
| `eventmodeling` | [references/eventmodeling.md](references/eventmodeling.md) |
| `flowchart` | [references/flowchart.md](references/flowchart.md) |
| `gantt` | [references/gantt.md](references/gantt.md) |
| `gitGraph`, `gitGraph:` | [references/git.md](references/git.md) |
| `ishikawa-beta` | [references/ishikawa.md](references/ishikawa.md) |
| `journey` | [references/journey.md](references/journey.md) |
| `kanban` | [references/kanban.md](references/kanban.md) |
| `mindmap` | [references/mindmap.md](references/mindmap.md) |
| `packet` | [references/packet.md](references/packet.md) |
| `pie` | [references/pie.md](references/pie.md) |
| `quadrantChart` | [references/quadrant.md](references/quadrant.md) |
| `radar-beta` | [references/radar.md](references/radar.md) |
| `railroad-ebnf-beta`, `railroad-abnf-beta`, `railroad-peg-beta`, `railroad-beta` | [references/railroad.md](references/railroad.md) |
| `requirementDiagram` | [references/requirement.md](references/requirement.md) |
| `sankey` | [references/sankey.md](references/sankey.md) |
| `sequenceDiagram` | [references/sequence.md](references/sequence.md) |
| `stateDiagram-v2`, `stateDiagram` | [references/state.md](references/state.md) |
| `swimlane-beta` | [references/swimlane.md](references/swimlane.md) |
| `timeline` | [references/timeline.md](references/timeline.md) |
| `treemap-beta` | [references/treemap.md](references/treemap.md) |
| `treeView-beta` | [references/treeview.md](references/treeview.md) |
| `usecase-beta` | [references/usecase.md](references/usecase.md) |
| `venn-beta` | [references/venn.md](references/venn.md) |
| `wardley-beta` | [references/wardley.md](references/wardley.md) |
| `xychart`, `xychart-beta` | [references/xychart.md](references/xychart.md) |
<!-- end of diagram types -->
