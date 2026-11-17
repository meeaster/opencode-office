// Builds the artifacts site: copies each artifacts/<name>/ of the office into <output>/<name>/,
// renders a Markdown-only artifact to <output>/<name>/index.html beside its Markdown file, and
// writes <output>/index.html showing each as a card, newest first, with its title, description
// and the date of its last commit. The index and rendered pages share the package's themes and
// any of the office's own in artifacts/themes/. It needs only Bun:
//
//   bun packages/artifact-share/scripts/build-site.ts <output>
//
// An office whose own site publishes more can build into a subfolder of it, such as
// <site>/artifacts. Files already in <output> are overwritten, never removed.
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { renderBlocks } from "./blocks.ts";
import { safeLinks } from "./links.ts";
import { coverTones, parseTheme, themeCss, type Theme } from "./theme.ts";

/**
 * An artifact to publish. `markdown` names the Markdown file rendered as its index.html, when it
 * has none of its own. `title` and `description` are escaped HTML text.
 */
type Artifact = { name: string; markdown: string | undefined; title: string; description: string | undefined; date: string | undefined };

const output = process.argv[2];

if (output === undefined) {
  console.error("usage: bun packages/artifact-share/scripts/build-site.ts <output folder>");
  process.exit(2);
}

// This script lives in <office>/packages/artifact-share/scripts/.
const office = resolve(import.meta.dir, "../../..");
const artifacts = join(office, "artifacts");

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function escape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

/** Escaped text made safe inside a double-quoted attribute too. */
function attribute(text: string): string {
  return text.replaceAll('"', "&quot;");
}

/** Inline Markdown as escaped text: rendered, then the tags dropped. */
function plain(markdown: string): string {
  return Bun.markdown.html(markdown, { noHtmlBlocks: true, noHtmlSpans: true }).replaceAll(/<[^>]*>/g, "").trim();
}

/** The date of the last commit that touched the artifact, or undefined outside Git or before its first commit. */
function lastCommitDate(name: string): string | undefined {
  try {
    return execFileSync("git", ["log", "-1", "--format=%cs", "--", `artifacts/${name}`], { cwd: office, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The first paragraph of a Markdown file, cut at a word near 180 characters, for the card. */
function firstParagraph(markdown: string): string | undefined {
  const paragraph = markdown
    .replace(/^---\r?\n[\s\S]*?\r?\n---/, "")
    .split(/\r?\n\s*\r?\n/)
    .map((block) => block.trim())
    .find((block) => /^[\p{L}\p{N}*_`[]/u.test(block));

  if (paragraph === undefined) return undefined;

  const line = paragraph.replaceAll(/\s+/g, " ");

  return plain(line.length <= 180 ? line : `${line.slice(0, line.lastIndexOf(" ", 180))}…`);
}

/**
 * The artifact's page, title and description: its index.html with the page's <title> and
 * description meta tag, else its index.md, else its first Markdown file, with the first heading
 * and first paragraph, rendered to index.html.
 */
function viewable(name: string): Artifact | undefined {
  const dir = join(artifacts, name);
  const date = lastCommitDate(name);

  if (existsSync(join(dir, "index.html"))) {
    const html = readFileSync(join(dir, "index.html"), "utf8");
    const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim();
    const description = /<meta\s[^>]*name=["']description["'][^>]*>/i.exec(html)?.[0].match(/content=(["'])([\s\S]*?)\1/i)?.[2]?.trim();

    // A <title> and a content attribute hold text with entities already escaped, but may hold a raw "<".
    return {
      name,
      markdown: undefined,
      title: title === undefined || title === "" ? escape(name) : title.replaceAll("<", "&lt;"),
      description: description === undefined || description === "" ? undefined : description.replaceAll("<", "&lt;"),
      date,
    };
  }

  const markdown = readdirSync(dir).filter((file) => file.endsWith(".md")).sort();
  const page = markdown.includes("index.md") ? "index.md" : markdown[0];

  if (page === undefined) return undefined;

  const source = readFileSync(join(dir, page), "utf8");
  const heading = /^#\s+(.+?)\s*#*\s*$/m.exec(source)?.[1];

  return { name, markdown: page, title: heading === undefined ? escape(name) : plain(heading), description: firstParagraph(source), date };
}

/**
 * What the package's settings give the pages; the defaults apply before `office sync` writes them,
 * and to settings a file written by an older version of the package lacks.
 */
function siteSettings() {
  const path = resolve(import.meta.dir, "../.settings.json");

  if (!existsSync(path)) return { url: undefined, title: "Artifacts", theme: "paper" };

  const settings: unknown = JSON.parse(readFileSync(path, "utf8"));
  const values = new Map<string, unknown>(typeof settings === "object" && settings !== null ? Object.entries(settings) : []);

  const field = (key: string) => {
    const value = values.get(key);

    if (value !== undefined && typeof value !== "string") fail(`packages/artifact-share/.settings.json: ${key} must be a string; run office sync to rewrite it`);

    return value;
  };

  const url = field("url");

  return { url: url?.replace(/\/+$/, ""), title: field("title") ?? "Artifacts", theme: field("theme") ?? "paper" };
}

/** The themes in a folder, each file `<id>.json`; `label` names the folder in errors. */
function readThemes(dir: string, label: string): Theme[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      try {
        return parseTheme(JSON.parse(readFileSync(join(dir, file), "utf8")), file.slice(0, -".json".length));
      } catch (error) {
        return fail(`${label}/${file}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

const site = siteSettings();
const siteTitle = escape(site.title);

// The office's own themes replace the package's of the same id.
const themes = new Map<string, Theme>();

for (const theme of [...readThemes(join(import.meta.dir, "themes"), "packages/artifact-share/scripts/themes"), ...readThemes(join(artifacts, "themes"), "artifacts/themes")]) {
  themes.set(theme.id, theme);
}

const themeList = [...themes.values()].sort((a, b) => a.name.localeCompare(b.name));
const defaultTheme = themes.get(site.theme) ?? fail(`packages/artifact-share/.settings.json: theme ${JSON.stringify(site.theme)} isn't one of the site's themes: ${themeList.map((theme) => theme.id).join(", ")}`);

function day(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function time(date: string | undefined): string {
  return date === undefined ? "" : `<time datetime="${date}">${day(date)}</time>`;
}

/**
 * The head every generated page shares: link-preview tags and, before the stylesheets, a snippet
 * that applies the reader's saved theme and scheme before the first paint, so the page never
 * flashes the default. `root` is the site's root relative to the page.
 */
function head(root: string, title: string, description: string | undefined, path: string, type: string): string {
  const ids = JSON.stringify(themeList.map((theme) => theme.id));

  const meta = [
    description === undefined ? "" : `<meta name="description" content="${attribute(description)}">`,
    `<meta property="og:type" content="${type}">`,
    `<meta property="og:site_name" content="${attribute(siteTitle)}">`,
    `<meta property="og:title" content="${attribute(title)}">`,
    description === undefined ? "" : `<meta property="og:description" content="${attribute(description)}">`,
    site.url === undefined ? "" : `<meta property="og:url" content="${attribute(escape(`${site.url}/${path}`))}">`,
  ].filter((tag) => tag !== "");

  return `    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${title}</title>
    ${meta.join("\n    ")}
    <script>try{var r=document.documentElement,t=localStorage.getItem("artifact-share:theme"),s=localStorage.getItem("artifact-share:scheme");if(${ids}.indexOf(t)>=0)r.dataset.theme=t;if(s==="light"||s==="dark")r.dataset.scheme=s}catch(e){}</script>
    <link rel="stylesheet" href="${root}themes.css">
    <link rel="stylesheet" href="${root}style.css">
    <script src="${root}site.js" defer></script>`;
}

/**
 * The theme picker and the light, dark or system switch. Hidden until the site's script shows
 * them, so a reader without JavaScript gets the default theme in their system's scheme.
 */
function appearance(): string {
  const options = themeList.map(
    (theme) =>
      `<li role="option" id="theme-${theme.id}" data-id="${theme.id}" aria-selected="false"><span class="chip" data-theme="${theme.id}" aria-hidden="true">Aa<i></i><i></i><i></i></span><span class="name">${escape(theme.name)}</span></li>`,
  );

  return `<div class="appearance" hidden>
        <div class="picker">
          <button type="button" class="picker-button" aria-haspopup="listbox" aria-expanded="false" aria-controls="themes"><span class="picker-label">Theme</span> <span class="picker-name">${escape(defaultTheme.name)}</span></button>
          <ul id="themes" role="listbox" aria-label="Theme" tabindex="-1" hidden>
            ${options.join("\n            ")}
          </ul>
        </div>
        <fieldset class="scheme">
          <legend>Colour scheme</legend>
          <label><input type="radio" name="scheme" value="light">Light</label>
          <label><input type="radio" name="scheme" value="dark">Dark</label>
          <label><input type="radio" name="scheme" value="system" checked>System</label>
        </fieldset>
      </div>`;
}

/**
 * A Markdown artifact as a page with the site's stylesheet and a link to its source. Bun's
 * renderer is the script's one Bun-specific API, marked unstable by Bun, so the workflow's Bun
 * pin and the tool's move together. Raw HTML in the source is shown as text, not passed through,
 * code blocks become diagrams, diffs and highlighted code, and links that could run script,
 * diagrams' included, are dropped.
 */
function renderMarkdown(artifact: Artifact, markdown: string): string {
  let blocks;

  try {
    blocks = renderBlocks(Bun.markdown.html(readFileSync(join(artifacts, artifact.name, markdown), "utf8"), { noHtmlBlocks: true, noHtmlSpans: true, headings: { ids: true } }));
  } catch (error) {
    return fail(`artifacts/${artifact.name}/${markdown}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const body = safeLinks(blocks);
  const date = time(artifact.date);

  return `<!doctype html>
<html lang="en" data-theme="${defaultTheme.id}">
  <head>
${head("../", artifact.title, artifact.description, `${encodeURIComponent(artifact.name)}/`, "article")}
  </head>
  <body class="page">
    <nav class="bar">
      <a class="back" href="../">${siteTitle}</a>
      ${appearance()}
    </nav>
    <main>
      <article>
${body}
      </article>
    </main>
    <footer class="source">${date === "" ? "" : `Updated ${date} · `}<a href="${encodeURIComponent(markdown)}">Markdown source</a></footer>
  </body>
</html>
`;
}

const linkIcon = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>`;

// The whole card opens the artifact through its heading's link, stretched over the card in CSS,
// so the copy button can sit beside it rather than inside a link.
function card(artifact: Artifact): string {
  const name = encodeURIComponent(artifact.name);
  const [tone, blend] = coverTones(artifact.name);
  const description = artifact.description === undefined ? "" : `\n            <p>${artifact.description}</p>`;
  const address = site.url === undefined ? `${name}/` : `${site.url}/${name}/`;

  return `        <li data-name="${escape(artifact.name)}" data-date="${artifact.date ?? ""}">
          <article class="card" style="--cover: var(--tone-${tone}); --cover-blend: var(--tone-${blend}); --cover-on: var(--on-tone-${tone})">
            <span class="cover" aria-hidden="true">${escape(artifact.name.charAt(0).toUpperCase())}</span>
            <h2><a href="${name}/index.html">${artifact.title}</a></h2>${description}
            <footer class="meta">
              <span class="kind">${artifact.markdown === undefined ? "Page" : "Document"}</span>${time(artifact.date)}
              <button type="button" class="copy" data-url="${attribute(escape(address))}" aria-label="Copy link to ${attribute(artifact.title)}" title="Copy link" hidden>${linkIcon}</button>
            </footer>
          </article>
        </li>`;
}

const found: Artifact[] = [];

for (const entry of existsSync(artifacts) ? readdirSync(artifacts, { withFileTypes: true }) : []) {
  // artifacts/themes/ holds the office's own themes, not an artifact.
  if (!entry.isDirectory() || entry.name.startsWith(".") || entry.name === "themes") continue;

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

const newest = found[0];
const count = `${found.length} artifact${found.length === 1 ? "" : "s"}`;
const summary = `${count}${newest?.date === undefined ? "" : ` · updated ${time(newest.date)}`}`;

const tools = `<div class="tools" hidden>
      <label class="search"><span>Search</span><input type="search" placeholder="Search artifacts" autocomplete="off" aria-keyshortcuts="/"><kbd aria-hidden="true">/</kbd></label>
      <label class="sort"><span>Sort</span><select>
        <option value="newest">Newest</option>
        <option value="oldest">Oldest</option>
        <option value="title">Title A–Z</option>
      </select></label>
    </div>
    <p class="status" role="status"></p>`;

const index = `<!doctype html>
<html lang="en" data-theme="${defaultTheme.id}">
  <head>
${head("", siteTitle, newest === undefined ? undefined : `${count}, the newest ${newest.title}`, "", "website")}
  </head>
  <body class="index">
    <header class="masthead">
      <div class="heading">
        <h1>${siteTitle}</h1>
        <p class="summary">${found.length === 0 ? "Nothing has been shared yet." : summary}</p>
      </div>
      ${appearance()}
    </header>
${found.length === 0 ? "" : `    <main>\n      ${tools}\n      <ul class="shelf">\n${found.map(card).join("\n")}\n      </ul>\n      <p class="empty" hidden>No artifacts match your search.</p>\n    </main>`}
  </body>
</html>
`;

mkdirSync(output, { recursive: true });

writeFileSync(join(output, "index.html"), index);

writeFileSync(
  join(output, "themes.css"),
  `/* The site's themes, generated by build-site.ts: each sets the colour variables on elements with its data-theme. */
:root {
  color-scheme: light dark;
}

:root[data-scheme="light"] {
  color-scheme: light;
}

:root[data-scheme="dark"] {
  color-scheme: dark;
}

${themeList.map(themeCss).join("\n")}`,
);

copyFileSync(join(import.meta.dir, "site.js"), join(output, "site.js"));

// The office's own artifacts/style.css replaces the package's.
copyFileSync(existsSync(join(artifacts, "style.css")) ? join(artifacts, "style.css") : join(import.meta.dir, "style.css"), join(output, "style.css"));

console.log(`built ${found.length} artifact${found.length === 1 ? "" : "s"} into ${output}`);

for (const artifact of found) console.log(`  ${site.url === undefined ? "" : `${site.url}/`}${artifact.name}/`);
