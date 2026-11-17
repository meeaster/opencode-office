// Regenerates the third-party libraries the artifact-share package carries in
// packages/artifact-share/scripts/vendor/, from this repository's exactly pinned devDependencies,
// so an office builds its site with nothing but Bun. To move one, change its pin in package.json,
// run `pnpm install`, then `pnpm run vendor-artifact-share`, and rebuild a site to check. Moving
// Pele also rewrites the share-artifact skill's diagram references and its table of types, from
// Pele's GitHub repository at the matching tag, so the command needs the network.
//
// Pele ships as one dependency-free module and is copied as published. @pierre/highlights ships
// as modules with its WebAssembly base64-encoded in one of them, so it is bundled into one file.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import * as v from "valibot";
import { parse } from "yaml";

const root = resolve(import.meta.dir, "..");
const vendor = join(root, "packages/artifact-share/scripts/vendor");
const lockfile = v.parse(v.object({ packages: v.record(v.string(), v.object({ resolution: v.object({ integrity: v.string() }) })) }), parse(readFileSync(join(root, "pnpm-lock.yaml"), "utf8")));

/** The installed version of a package and its npm integrity, as pnpm locked it. */
function pinned(name: string) {
  const { version, license } = v.parse(v.object({ version: v.string(), license: v.string() }), JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")));
  const integrity = lockfile.packages[`${name}@${version}`]?.resolution.integrity;

  if (integrity === undefined) throw new Error(`pnpm-lock.yaml has no ${name}@${version}; run pnpm install`);

  return { name, version, license, integrity };
}

// Declarations (*.d.ts) are written by hand beside each library and kept.
for (const library of ["pele", "highlights"]) {
  for (const file of ["LICENSE", "LICENSE.md", "NOTICE.md", `${library}.js`]) rmSync(join(vendor, library, file), { force: true });

  mkdirSync(join(vendor, library), { recursive: true });
}

const pele = pinned("pele");
const peleDir = join(root, "node_modules/pele");

copyFileSync(join(peleDir, "dist/pele.js"), join(vendor, "pele/pele.js"));

copyFileSync(join(peleDir, "LICENSE"), join(vendor, "pele/LICENSE"));

const highlights = pinned("@pierre/highlights");
const highlightsDir = join(root, "node_modules/@pierre/highlights");

const bundle = await Bun.build({
  entrypoints: [join(highlightsDir, "dist/default.js")],
  target: "bun",
  format: "esm",
  banner: `// ${highlights.name} ${highlights.version}, bundled by src/vendor-artifact-share.ts in opencode-office; don't edit.`,
});

if (!bundle.success || bundle.outputs.length !== 1) throw new AggregateError(bundle.logs, "bundling @pierre/highlights failed");

writeFileSync(join(vendor, "highlights/highlights.js"), await bundle.outputs[0]!.text());

copyFileSync(join(highlightsDir, "LICENSE.md"), join(vendor, "highlights/LICENSE.md"));

copyFileSync(join(highlightsDir, "NOTICE.md"), join(vendor, "highlights/NOTICE.md"));

// The share-artifact skill's diagram references: Mermaid's documentation examples from Pele's test
// corpus (tests/corpus/<type>-docs.json) at the release tag of the vendored version, so moving Pele
// refreshes them too. An example is kept only when it renders as a page's mermaid block does and
// sets no colour or theme, which would ignore the reader's theme. The npm package has no corpus.
const peleRepo = "obsidianmd/pele";

// Mermaid's licence, which covers its documentation; the release Pele targets.
const mermaidLicense = "https://raw.githubusercontent.com/mermaid-js/mermaid/21f72f07ea22c0af48a3149c550654e80d8e40cb/LICENSE";

// Info only shows the renderer's version; nothing an artifact would draw.
const skippedTypes = ["info"];
const setsColour = /themeVariables|\btheme\s*:|["']theme["']|\b(?:fill|stroke|color)\s*:|rgba?\(|#[0-9a-f]{3,8}\b(?!;)/i;
const skill = join(root, "packages/artifact-share/skills/share-artifact");
const references = join(skill, "references");

async function download(url: string): Promise<string> {
  const response = await fetch(url);

  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);

  return response.text();
}

const { sha: peleCommit } = v.parse(v.object({ sha: v.string() }), JSON.parse(await download(`https://api.github.com/repos/${peleRepo}/commits/refs/tags/${pele.version}`)));
const corpusFiles = v.parse(v.array(v.object({ name: v.string(), sha: v.string() })), JSON.parse(await download(`https://api.github.com/repos/${peleRepo}/contents/tests/corpus?ref=${peleCommit}`)));

// Imported once the vendored Pele and highlighter above are in place.
const { renderBlocks } = await import("../packages/artifact-share/scripts/blocks.ts");

/** The block as a page's Markdown holds it, if it renders there. */
function renderable(source: string): string | undefined {
  if (source.includes("```")) throw new Error(`a corpus example holds a code fence:\n${source}`);

  const block = `\`\`\`mermaid\n${source.trimEnd()}\n\`\`\`\n`;

  try {
    renderBlocks(Bun.markdown.html(block));
  } catch {
    return undefined;
  }

  return block;
}

/** A diagram's first line's keyword, after any front matter and comments. */
function keyword(source: string): string {
  const line = source.replace(/^---\n[\s\S]*?\n---\n/, "").split("\n").find((text) => text.trim() !== "" && !text.trim().startsWith("%%"));

  return line?.trim().split(/\s+/)[0] ?? "";
}

rmSync(references, { recursive: true, force: true });

mkdirSync(references);

const types: { type: string; keywords: string[]; examples: number }[] = [];

for (const file of corpusFiles.toSorted((a, b) => a.name.localeCompare(b.name))) {
  const type = file.name.match(/^(.+)-docs\.json$/)?.[1];

  if (type === undefined || skippedTypes.includes(type)) continue;

  const text = await download(`https://raw.githubusercontent.com/${peleRepo}/${peleCommit}/tests/corpus/${file.name}`);
  const blob = new Bun.CryptoHasher("sha1").update(`blob ${Buffer.byteLength(text)}\0${text}`).digest("hex");

  if (blob !== file.sha) throw new Error(`tests/corpus/${file.name} doesn't match its blob ${file.sha} at ${peleCommit}`);

  const sources = [...new Set(v.parse(v.array(v.string()), JSON.parse(text)))].filter((source) => !setsColour.test(source));
  const blocks = sources.flatMap((source) => renderable(source) ?? []);

  if (blocks.length === 0) continue;

  types.push({ type, keywords: [...new Set(sources.map(keyword))], examples: blocks.length });

  writeFileSync(
    join(references, `${type}.md`),
    `# ${type}\n\nMermaid's documentation examples, from Pele ${pele.version}'s test corpus; each renders on the site. Written by \`pnpm run vendor-artifact-share\` in opencode-office; don't edit.\n\n${blocks.join("\n")}`,
  );
}

writeFileSync(
  join(references, "LICENSE"),
  `The examples in this folder are Mermaid's documentation examples, as collected in Pele's test corpus.

Mermaid (https://github.com/mermaid-js/mermaid):

${(await download(mermaidLicense)).trimEnd()}

Pele (https://github.com/${peleRepo}):

${readFileSync(join(peleDir, "LICENSE"), "utf8").trimEnd()}
`,
);

const skillFile = join(skill, "SKILL.md");

const table = [
  "| First line | Examples |",
  "|---|---|",
  ...types.map(({ type, keywords }) => `| ${keywords.map((word) => `\`${word}\``).join(", ")} | [references/${type}.md](references/${type}.md) |`),
].join("\n");

const [before, rest] = readFileSync(skillFile, "utf8").split("<!-- diagram types -->\n");
const after = rest?.split("<!-- end of diagram types -->")[1];

if (before === undefined || after === undefined) throw new Error(`${skillFile} has no <!-- diagram types --> ... <!-- end of diagram types --> section`);

writeFileSync(skillFile, `${before}<!-- diagram types -->\n${table}\n<!-- end of diagram types -->${after}`);

writeFileSync(
  join(vendor, "README.md"),
  `# Vendored libraries

Third-party libraries the site build uses, committed here so an office needs nothing but Bun: no install step, no \`node_modules\`. Written by \`pnpm run vendor-artifact-share\` (\`src/vendor-artifact-share.ts\` in opencode-office) from the repository's pinned devDependencies; don't edit them by hand. Each folder's \`*.d.ts\` is written by hand and declares only what the build uses.

| Folder | Package | Version | Licence | npm integrity | How |
|---|---|---|---|---|---|
| \`pele/\` | [${pele.name}](https://www.npmjs.com/package/${pele.name}) | ${pele.version} | ${pele.license} (\`pele/LICENSE\`) | \`${pele.integrity}\` | \`dist/pele.js\` copied as published |
| \`highlights/\` | [${highlights.name}](https://www.npmjs.com/package/${highlights.name}) | ${highlights.version} | ${highlights.license} (\`highlights/LICENSE.md\`, \`highlights/NOTICE.md\`) | \`${highlights.integrity}\` | \`dist/default.js\` bundled by \`Bun.build\` into one module, its WebAssembly inlined as base64 |

The share-artifact skill's diagram references (\`skills/share-artifact/references/\`) are written by the same command: Mermaid's documentation examples from Pele's test corpus, \`tests/corpus/<type>-docs.json\` in [${peleRepo}](https://github.com/${peleRepo}) at tag \`${pele.version}\`, commit \`${peleCommit}\`, each file checked against its blob hash there. An example is kept only when it renders as a page's mermaid block does and sets no colour or theme. Mermaid's documentation and Pele are both MIT licensed; \`references/LICENSE\` holds both notices.
`,
);

const examples = types.reduce((sum, { examples: count }) => sum + count, 0);

console.log(`vendored ${pele.name} ${pele.version} and ${highlights.name} ${highlights.version} into ${vendor}`);

console.log(`wrote ${examples} diagram examples of ${types.length} types from ${peleRepo} ${peleCommit} into ${references}`);
