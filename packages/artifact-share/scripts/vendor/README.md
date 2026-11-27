# Vendored libraries

Third-party libraries the site build uses, committed here so an office needs nothing but Bun: no install step, no `node_modules`. Written by `pnpm run vendor-artifact-share` (`bin/vendor-artifact-share.ts` in opencode-office) from the repository's pinned devDependencies; don't edit them by hand. Each folder's `*.d.ts` is written by hand and declares only what the build uses.

| Folder | Package | Version | Licence | npm integrity | How |
|---|---|---|---|---|---|
| `pele/` | [pele](https://www.npmjs.com/package/pele) | 1.13.0 | MIT (`pele/LICENSE`) | `sha512-Ie8UKY9x00MsuR3jO6AzUwzK2Z6MIV3Tf4EDdITiuk8Uaz8K7g0R082WqsqNaSU8DdgkrRvZThzhit83mi/uiw==` | `dist/pele.js` copied as published |
| `highlights/` | [@pierre/highlights](https://www.npmjs.com/package/@pierre/highlights) | 0.5.1 | apache-2.0 (`highlights/LICENSE.md`, `highlights/NOTICE.md`) | `sha512-c2WF6sgwgKdxXU6FpWDLWUYHRca/cJy+3QJkWAqYqEAFxqlPf8eSH0ehHcFFjKBmT+9KBl9H7q6z7HMRU7+m6g==` | `dist/default.js` bundled by `Bun.build` into one module, its WebAssembly inlined as base64 |

The share-artifact skill's diagram references (`skills/share-artifact/references/`) are written by the same command: Mermaid's documentation examples from Pele's test corpus, `tests/corpus/<type>-docs.json` in [obsidianmd/pele](https://github.com/obsidianmd/pele) at tag `1.13.0`, commit `3a2f075ee0c3d914f0fad3545fc0f193693975ac`, each file checked against its blob hash there. An example is kept only when it renders as a page's mermaid block does and sets no colour or theme. Mermaid's documentation and Pele are both MIT licensed; `references/LICENSE` holds both notices.
