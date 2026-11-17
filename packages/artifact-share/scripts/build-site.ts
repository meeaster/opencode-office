// Builds the artifacts site: copies each artifacts/<name>/ of the office into <output>/<name>/,
// renders a Markdown-only artifact to <output>/<name>/index.html beside its Markdown file, and
// writes <output>/index.html listing them, newest first, with a title and the date of their last
// commit. It needs only Bun:
//
//   bun packages/artifact-share/scripts/build-site.ts <output>
//
// An office whose own site publishes more can build into a subfolder of it, such as
// <site>/artifacts. Files already in <output> are overwritten, never removed.
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** An artifact to publish: `markdown` names the Markdown file rendered as its index.html, when it has none of its own. */
type Artifact = { name: string; markdown: string | undefined; title: string; date: string | undefined };

const output = process.argv[2];

if (output === undefined) {
  console.error("usage: bun packages/artifact-share/scripts/build-site.ts <output folder>");
  process.exit(2);
}

// This script lives in <office>/packages/artifact-share/scripts/.
const office = resolve(import.meta.dir, "../../..");
const artifacts = join(office, "artifacts");

function escape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** The date of the last commit that touched the artifact, or undefined outside Git or before its first commit. */
function lastCommitDate(name: string): string | undefined {
  try {
    return execFileSync("git", ["log", "-1", "--format=%cs", "--", `artifacts/${name}`], { cwd: office, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * The artifact's page and title: its index.html with the page's <title>, else its index.md, else
 * its first Markdown file, with the first heading, rendered to index.html.
 */
function viewable(name: string): Artifact | undefined {
  const dir = join(artifacts, name);
  const date = lastCommitDate(name);

  if (existsSync(join(dir, "index.html"))) {
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(readFileSync(join(dir, "index.html"), "utf8"))?.[1]?.trim();

    // A <title> holds text with entities already escaped, but may hold a raw "<".
    return { name, markdown: undefined, title: title === undefined || title === "" ? escape(name) : title.replaceAll("<", "&lt;"), date };
  }

  const markdown = readdirSync(dir).filter((file) => file.endsWith(".md")).sort();
  const page = markdown.includes("index.md") ? "index.md" : markdown[0];

  if (page === undefined) return undefined;

  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(readFileSync(join(dir, page), "utf8"))?.[1];

  // The heading as text: its inline Markdown rendered, then the tags dropped, leaving escaped text.
  const title = heading === undefined ? escape(name) : Bun.markdown.html(heading, { noHtmlSpans: true }).replaceAll(/<[^>]*>/g, "").trim();

  return { name, markdown: page, title, date };
}

/**
 * A Markdown artifact as a page with the site's stylesheet and a link to its source. Bun's
 * renderer is the script's one Bun-specific API, marked unstable by Bun, so the workflow's Bun
 * pin and the tool's move together. Raw HTML in the source is shown as text, not passed through.
 */
function renderMarkdown(artifact: Artifact, markdown: string): string {
  const body = Bun.markdown.html(readFileSync(join(artifacts, artifact.name, markdown), "utf8"), { noHtmlBlocks: true, noHtmlSpans: true, headings: { ids: true } });

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${artifact.title}</title>
    <link rel="stylesheet" href="../style.css">
  </head>
  <body>
${body}
    <p class="source"><a href="${encodeURIComponent(markdown)}">Markdown source</a></p>
  </body>
</html>
`;
}

/** The Pages address from the package's settings, for the summary; undefined before `office sync` writes them. */
function siteUrl(): string | undefined {
  const path = resolve(import.meta.dir, "../.settings.json");

  if (!existsSync(path)) return undefined;

  // office sync writes the file only for settings that match package.yaml, where url is required.
  const settings: { url: string } = JSON.parse(readFileSync(path, "utf8"));

  return settings.url.replace(/\/+$/, "");
}

const found: Artifact[] = [];

for (const entry of existsSync(artifacts) ? readdirSync(artifacts, { withFileTypes: true }) : []) {
  if (!entry.isDirectory() || entry.name.startsWith(".")) continue;

  const artifact = viewable(entry.name);

  if (artifact === undefined) {
    console.error(`skipped artifacts/${entry.name}/: it has no index.html or Markdown file`);

    continue;
  }

  cpSync(join(artifacts, entry.name), join(output, entry.name), { recursive: true });

  if (artifact.markdown !== undefined) writeFileSync(join(output, entry.name, "index.html"), renderMarkdown(artifact, artifact.markdown));

  found.push(artifact);
}

// Newest first; undated (uncommitted) ones last; then by name.
found.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.name.localeCompare(b.name));

const items = found.map((artifact) => {
  const date = artifact.date === undefined ? "" : ` <time datetime="${artifact.date}">${artifact.date}</time>`;

  return `      <li><a href="${encodeURIComponent(artifact.name)}/index.html">${artifact.title}</a>${date}</li>`;
});

const index = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Artifacts</title>
    <link rel="stylesheet" href="style.css">
  </head>
  <body>
    <h1>Artifacts</h1>
${found.length === 0 ? "    <p>Nothing has been shared yet.</p>" : `    <ul class="artifacts">\n${items.join("\n")}\n    </ul>`}
  </body>
</html>
`;

mkdirSync(output, { recursive: true });

writeFileSync(join(output, "index.html"), index);

// The office's own artifacts/style.css replaces the package's.
copyFileSync(existsSync(join(artifacts, "style.css")) ? join(artifacts, "style.css") : join(import.meta.dir, "style.css"), join(output, "style.css"));

const url = siteUrl();

console.log(`built ${found.length} artifact${found.length === 1 ? "" : "s"} into ${output}`);

for (const artifact of found) console.log(`  ${url === undefined ? "" : `${url}/`}${artifact.name}/`);
