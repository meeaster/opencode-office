# artifact-share

An `office` package: the user asks an agent to share something, the agent puts it in the office's `artifacts/` folder, and a GitHub Pages site built by a workflow serves it with an index page.

**The site may be public.** On a personal GitHub account a Pages site is public even when the repository is private; an organization can make its site private. You decide what is shared; `office` doesn't.

## Install

In `office.yaml`, with `ref` a tag or a full 40-character commit SHA of this repository:

```yaml
packages:
  - name: artifact-share
    repo: https://github.com/meeaster/opencode-office.git
    path: packages/artifact-share
    ref: <commit or tag>
    settings:
      url: https://<owner>.github.io/<repository>
```

Then run `office sync` and commit what it wrote. Set the repository's Pages source to "GitHub Actions" once (Settings → Pages).

| Setting | |
|---|---|
| `url` (required) | The site's base address; each artifact is published at `<url>/<artifact>/` |

## What it holds

| Path | |
|---|---|
| `skills/share-artifact/` | The skill every session gets: where an artifact goes, how to preview it, when to publish and which link to give |
| `scripts/build-site.ts` | Builds the site: `bun packages/artifact-share/scripts/build-site.ts <output>` copies each `artifacts/<name>/` and writes an index page listing each by title (its `<title>`, or a Markdown file's first heading) and the date of its last commit. An artifact with no `index.html` gets one rendered from its `index.md`, else its first Markdown file, with the same stylesheet, titled by the first heading and linking to the `.md` file, which stays beside it. Raw HTML in the Markdown is shown as text (`noHtmlBlocks` and `noHtmlSpans`), not passed through. The renderer, `Bun.markdown.html` (also used for the title), is the script's one Bun-specific API; Bun marks it unstable, so move the workflow's Bun pin (`oven-sh/setup-bun` `bun-version`) and the tool's (`mise.toml`, which builds the `office` executable that runs the script in the container) together, and rebuild a site to check after a bump. It needs only Bun, and an office whose own site publishes more can call it with a subfolder of that site as `<output>` |
| `scripts/style.css` | The plain stylesheet of the index and of rendered Markdown pages; an office's own `artifacts/style.css` replaces it |
| `template/` | Copied once into the office: `artifacts/AGENTS.md` (what agents may put there), `artifacts/README.md` and `.github/workflows/publish-artifacts.yml`. The office owns these copies |

The workflow builds on a push to `main` that changes `artifacts/`, this package's scripts or settings, or the workflow itself, and can be run by hand.
