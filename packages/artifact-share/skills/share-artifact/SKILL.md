---
name: share-artifact
description: Share a page, report or document as a published artifact on the office's GitHub Pages site, which may be public. Use only when the user asks to share, publish or update an artifact.
---

# Sharing an artifact

An artifact is one folder in the office root's `artifacts/`, published to a GitHub Pages site with an index page. From a desk, write to the root's `artifacts/`, never to a folder of the desk.

1. **Folder.** `artifacts/<name>/`, with `<name>` in lowercase words and dashes naming what it explains (`q3-latency-findings`, not `report-2`). To update an artifact, change its existing folder; its link stays the same.
2. **Page.** Write a self-contained `index.html`: styles and scripts inline, a `<title>` (the index lists it by that), nothing loaded from other sites. Images and other files go beside it, linked by relative paths. A Markdown file (`index.md`) also works: the site renders it to an HTML page titled by its first heading, with the `.md` file beside it. Raw HTML in it shows as text, so anything needing markup or scripts is an `index.html`.
3. **Preview.** Build the site into a scratch folder and open its `index.html`, checking the index entry and the page:

   ```sh
   bun packages/artifact-share/scripts/build-site.ts <scratch>/site
   ```

   Run it from the office root. Where `bun` isn't installed, as in the office's container, `BUN_BE_BUN=1 office packages/artifact-share/scripts/build-site.ts <scratch>/site` runs it with the `office` executable.
4. **Publish.** Commit the folder. A push to `main` publishes it through the `publish-artifacts` workflow; push only when the user asks to publish.
5. **Link.** Give the user `<url>/<name>/`, with `url` from `packages/artifact-share/.settings.json`. It works once the workflow has deployed the push.

The site may be public: on a personal GitHub account it is, even when the repository is private. Share only what the user chose to share.
