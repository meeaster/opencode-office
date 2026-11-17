# artifact-share

An `office` package: the user asks an agent to share something, the agent puts it in the office's `artifacts/` folder, and a GitHub Pages site built by a workflow serves it with an index page.

**The site may be public.** On a personal GitHub account a Pages site is public even when the repository is private; an organization can make its site private. You decide what is shared; `office` doesn't.

## Install

It is built into `office`. In `office.yaml`:

```yaml
packages:
  - name: artifact-share
    settings:
      url: https://<owner>.github.io/<repository>
```

Then run `office sync` and commit what it wrote: the package in `.office/packages/artifact-share/`, which updates with `office` and is read-only there, and the template files below. Set the repository's Pages source to "GitHub Actions" once (Settings → Pages).

| Setting | |
|---|---|
| `url` (required) | The site's base address; each artifact is published at `<url>/<artifact>/` |
| `title` | The site's name, shown as the index page's heading and on each rendered page's link back to it; `Artifacts` by default |
| `theme` | The theme a reader sees until they pick another, by id; `paper` by default. An id that isn't one of the site's themes fails the build, naming the valid ones |

## What it holds

| Path | |
|---|---|
| `plugin/index.ts` | The OpenCode plugin, which `office sync` links as `.opencode/plugins/artifact-share`. It registers the skill below in every session |
| `skills/share-artifact/` | The skill every session gets, through the plugin: where an artifact goes, how to preview it, when to publish and which link to give, and how to write a diagram the site draws. Its `references/` hold, per diagram type, Mermaid's documentation examples that render with the vendored Pele and set no colours, generated with its table of types in `SKILL.md` (see `scripts/vendor/`) |
| `scripts/build-site.ts` | Builds the site, finding the office as the nearest folder above it with an `office.yaml`: `bun .office/packages/artifact-share/scripts/build-site.ts <output>` copies each `artifacts/<name>/` and writes an index page showing each as a card with its title (its `<title>`, or a Markdown file's first heading), its description (its `description` meta tag, or the Markdown file's first paragraph), the date of its last commit and a cover in two of the theme's accent colours, chosen from its name. Readers can search the cards, sort them and copy each one's link. An artifact with no `index.html` gets one rendered from its `index.md`, else its first Markdown file, with the same stylesheet, titled by the first heading and linking to the `.md` file, which stays beside it. Raw HTML in the Markdown is shown as text (`noHtmlBlocks` and `noHtmlSpans`), not passed through, and link and image addresses other than http, https, mailto, relative and fragment ones (such as `javascript:` and `data:`) are dropped. Fenced code blocks are turned into static HTML at build time, with no script in the page: see [Markdown blocks](#markdown-blocks). The index and rendered pages carry description and Open Graph tags for link previews. HTML artifacts are copied as written, without themes or link checks. The renderer, `Bun.markdown.html` (also used for the title), is the script's one Bun-specific API; Bun marks it unstable, so move the workflow's Bun pin (`oven-sh/setup-bun` `bun-version`) and the tool's (`mise.toml`, which builds the `office` executable that runs the script in the container) together, and rebuild a site to check after a bump. It needs only Bun, and an office whose own site publishes more can call it with a subfolder of that site as `<output>` |
| `scripts/theme.ts`, `scripts/links.ts`, `scripts/blocks.ts` | The build's theme mapping, Markdown link filter, and diagrams, diffs and highlighted code |
| `scripts/vendor/` | The two libraries the build uses, committed as self-contained files so the build needs no install: [Pele](https://www.npmjs.com/package/pele) (MIT, `pele/LICENSE`), which draws Mermaid diagrams as SVG, and [`@pierre/highlights`](https://www.npmjs.com/package/@pierre/highlights) (Apache-2.0, `highlights/LICENSE.md` and `highlights/NOTICE.md`), which highlights code, bundled into one module with its WebAssembly inlined. `vendor/README.md` records each one's version, npm integrity and how it was produced. To move one, change its pin in opencode-office's `package.json` (both are devDependencies of that repository, not of the `office` tool), run `pnpm install` and `pnpm run vendor-artifact-share`, then rebuild a site with diagrams and code to check. The same command regenerates the skill's diagram references from Pele's test corpus at the matching release tag on GitHub, so it needs the network; `pnpm test` checks every example still renders |
| `scripts/themes/` | The built-in themes, in the format of OpenCode's desktop themes: `paper` (the default), `catppuccin`, `dracula`, `everforest`, `github`, `gruvbox`, `kanagawa`, `nord`, `one-dark`, `rosepine`, `solarized` and `tokyonight`. All but `paper` are copied unchanged from [OpenCode](https://github.com/anomalyco/opencode) under its MIT licence, kept in `themes/LICENSE` |
| `scripts/site.js` | The site's one script: the theme picker and light, dark or system switch on every page, saved in the browser and shared across the site, and the index's search, sort and copy link. Without JavaScript the site shows the default theme in the reader's system scheme and hides these controls |
| `scripts/style.css` | The look of the index and of rendered Markdown pages: system fonts only, nothing loaded from other sites. An office's own `artifacts/style.css` replaces it |
| `test/` | Tests of the theme mapping, the link filter and the code blocks, run by this repository's `pnpm test` |
| `template/` | Copied once into the office: `artifacts/AGENTS.md` (what agents may put there), `artifacts/README.md` and `.github/workflows/publish-artifacts.yml`. The office owns these copies |

## Markdown blocks

In a Markdown artifact, fenced code blocks become more than plain code when the site is built:

- A `mermaid` block becomes a diagram: an inline SVG drawn by Pele, which supports Mermaid's diagram types (flowchart, sequence, class, state, ER, Gantt, pie and more). Its colours follow the reader's theme and light or dark choice, a left-to-right diagram too wide for the page is laid out top to bottom, and one still too wide shrinks on a small screen to 70% of its size and then scrolls. It is labelled for screen readers by its `accTitle` and `accDescr`, else by its type. Label text is escaped and HTML tags in labels are dropped; `click` links keep only http, https, mailto and relative addresses, as other links do, and images in diagrams aren't loaded. **A diagram that doesn't parse fails the build**, naming the file, the block (the first mermaid block is block 1) and Pele's line and column within it.
- A `diff` or `patch` block shows file headers in bold, hunk headers (`@@`) muted, and added and removed lines tinted with the theme's diff colours.
- A block in a language `@pierre/highlights` knows (TypeScript, Python, shell, SQL, JSON, YAML, Go, Rust and well over a hundred more, by name or alias) is highlighted with the theme's syntax colours.
- A block in another language, or none, stays plain code, and inline code is unchanged.

## Themes

Each theme has a `name`, an `id` and a `light` and `dark` variant, each with a `palette` of colours: `neutral` (the background), `ink` (the text), `primary` (links), `success`, `warning`, `error` and `info`, and optionally `accent`, `interactive`, `diffAdd` and `diffDelete`. A variant's `overrides` may give code colours as `syntax-comment`, `syntax-keyword`, `syntax-string`, `syntax-primitive` (functions), `syntax-property`, `syntax-constant`, `syntax-type`, `syntax-variable`, `syntax-operator` and `syntax-punctuation`, each a plain colour such as `#d16090`; other overrides are ignored. A role without one takes the palette colour OpenCode gives it (comments the secondary text colour, keywords and constants `accent` or else `primary`, strings `success`, functions `primary`, properties `info`, types `warning`), and diffs take `diffAdd` and `diffDelete`, else `success` and `error`. The cover colours are the palette's accent colours. The build turns each variant into the site's colour variables in a generated `themes.css`, darkening or lightening link, secondary text, code, diff and diagram colours where needed so text stays readable. OpenCode themes given as `seeds` rather than a `palette` aren't supported, nor are code colours given as CSS variables or translucent colours.

An office adds its own themes as `artifacts/themes/<id>.json` in the same format, with `id` matching the file name; they join the picker, and one with a built-in's id replaces it. A file that isn't a valid theme fails the build with its name and the problem. `artifacts/themes/` is never published as an artifact.

An office's own `artifacts/style.css` replaces the package's stylesheet but not `themes.css`, which the pages load first. It sets these variables on the page's root element for the active theme and scheme: `--paper` (background), `--surface` (cards and controls), `--ink` (text), `--muted` (secondary text), `--rule` (borders), `--accent` (links), `--code` (code background), `--tone-0` to `--tone-5`, with `--on-tone-0` to `--on-tone-5` for text set on them and `--series-0` to `--series-5` for diagram series, `--syntax-<role>` for each code role above, and `--diff-add`, `--diff-delete`, `--diff-add-bg` and `--diff-delete-bg` for diffs. Highlighted code colours each token with `var(--syntax-<role>)` and plain text with `var(--syntax-foreground)`, and diagrams draw with Pele's `--pele-*` variables, which the package's stylesheet sets from the theme's; a replacement stylesheet sets them itself, or diagrams keep Pele's own colours. A stylesheet that uses them follows the reader's choice; one that ignores them keeps its own colours. The picker's controls, the search box, the cards' copy buttons, diagrams and diff lines are styled by the stylesheet too, so a replacement should style `.appearance`, `.tools`, `.card`, `.copy`, `.diagram` (a figure holding the SVG, its natural width in `--width`) and `pre.diff` (each line a span, classed `file`, `hunk`, `add` or `delete`), or the pages show them unstyled.

The workflow builds on a push to `main` that changes `artifacts/`, this package's scripts or settings, or the workflow itself, and can be run by hand. An office whose copy of the workflow predates `.office/packages/` still names `packages/artifact-share/`: change those paths to `.office/packages/artifact-share/`, as the copy is the office's and `office sync` never rewrites it.
