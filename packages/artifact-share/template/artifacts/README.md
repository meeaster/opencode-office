# Artifacts

Pages this office shares. Each folder is one artifact: an `index.html`, or a Markdown file the site renders to a page, with the images and other files it uses beside it. The `publish-artifacts` workflow builds them into a GitHub Pages site with an index page whenever a change here reaches `main`; it can also be run by hand from the Actions tab.

The site may be public: on a personal GitHub account it is, even when this repository is private. You decide what goes here.

- Ask an agent to share something and it adds a folder here; it pushes only when you ask.
- Remove a folder, or change it, and push, to unpublish or update it.
- Put a `style.css` here to replace the index page's plain stylesheet.
- Preview locally with `bun packages/artifact-share/scripts/build-site.ts <folder>`, then open `<folder>/index.html`.

This file, `AGENTS.md` beside it and the workflow came from the `artifact-share` package once; they are the office's to change, and `office sync` never overwrites them.
