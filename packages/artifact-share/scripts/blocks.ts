// Fenced code blocks of a rendered Markdown page, turned at build time into static HTML coloured
// by the theme's variables: a mermaid block into a diagram drawn by Pele, a diff block into added
// and removed lines, and a block in a language @pierre/highlights knows into highlighted code.
// Other blocks keep their code as Bun's renderer wrote it.
import { codeToHtml, isSupportedLanguage, type Theme } from "./vendor/highlights/highlights.js";
import { PeleError, render } from "./vendor/pele/pele.js";

/**
 * The highlighter's token kinds grouped onto the theme's syntax roles as OpenCode groups them;
 * each colour names the variable --syntax-<role>. A kind without an entry takes its parent's
 * (keyword.control takes keyword's), and one without either takes --syntax-foreground.
 */
const codeTheme: Theme = {
  name: "artifact-share",
  appearance: "light",
  cssVariables: { prefix: "--syntax-" },
  style: {
    syntax: {
      attribute: "property",
      boolean: "constant",
      comment: "comment",
      constant: "constant",
      constructor: "type",
      enum: "type",
      function: "primitive",
      hint: "comment",
      keyword: "keyword",
      "keyword.operator": "operator",
      label: "constant",
      link_text: "property",
      link_uri: "keyword",
      namespace: "constant",
      number: "constant",
      operator: "operator",
      preproc: "keyword",
      property: "variable",
      punctuation: "punctuation",
      "punctuation.special": "keyword",
      selector: "keyword",
      "selector.class": "property",
      "selector.id": "primitive",
      "selector.pseudo": "operator",
      string: "string",
      "string.escape": "constant",
      "string.special": "constant",
      tag: "keyword",
      "tag.component.jsx": "type",
      "text.literal": "string",
      title: { color: "keyword", font_weight: 700 },
      type: "type",
      variable: "variable",
      "variable.special": "constant",
      variant: "constant",
    },
  },
};

/**
 * Pele's diagrams lay out to fit the page's text column, 44rem less its padding. Pele turns a
 * left-to-right diagram too wide for it top to bottom only when the width is below its
 * directionBreakpoint, so that is set just above.
 */
const columnWidth = 640;

/** Code as Bun's renderer escaped it, back to text. */
function unescape(html: string): string {
  return html.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&quot;", '"').replaceAll("&amp;", "&");
}

function escape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * A diagram. Pele escapes label text, drops HTML tags in labels, and links only the schemes
 * given; the page's link filter then checks its links like any other. Without accTitle a diagram
 * is labelled by its type. The figure scrolls when the diagram can't shrink to the column.
 */
function diagram(source: string, index: number): string {
  let rendered;

  try {
    rendered = render(source, { idPrefix: `diagram-${index}-`, maxWidth: columnWidth, directionBreakpoint: columnWidth + 1, linkSchemes: ["http", "https", "mailto"], images: false });
  } catch (error) {
    if (error instanceof PeleError) throw new Error(`mermaid block ${index}, line ${error.line}, column ${error.column}: ${error.message}`, { cause: error });

    throw error;
  }

  const svg = /^<svg\b[^>]*\saria-labelledby=/.test(rendered.svg) ? rendered.svg : rendered.svg.replace(/^<svg\b/, `<svg aria-label="${rendered.type} diagram"`);

  return `<figure class="diagram" style="--width: ${rendered.width}px" tabindex="0">${svg}</figure>`;
}

/**
 * A diff with each line marked: file headers before a hunk, hunk headers, added, removed and
 * unchanged lines. Lines like "--- x" are file headers only outside a hunk, where they can't be
 * removed lines.
 */
function diff(text: string): string {
  let inHunk = false;

  const lines = text.replace(/\n$/, "").split("\n").map((line) => {
    if (line.startsWith("diff ")) inHunk = false;

    let kind = "";

    if (line.startsWith("@@")) {
      inHunk = true;
      kind = "hunk";
    } else if (!inHunk && /^(?:diff |index |--- |\+\+\+ )/.test(line)) {
      kind = "file";
    } else if (line.startsWith("+")) {
      kind = "add";
    } else if (line.startsWith("-")) {
      kind = "delete";
    }

    return `<span${kind === "" ? "" : ` class="${kind}"`}>${escape(line)}\n</span>`;
  });

  return lines.join("");
}

/**
 * A code block's opening tag. A long line scrolls the block sideways, so it takes keyboard focus,
 * as a diagram does, and a name to announce on focus.
 */
function pre(name: string, className = ""): string {
  return `<pre${className === "" ? "" : ` class="${className}"`} tabindex="0" role="group" aria-label="${name}">`;
}

/**
 * The page's code blocks as diagrams, diffs and highlighted code, each focusable. Bun writes each
 * as <pre><code>, with class="language-x" when fenced with a language, and the code
 * entity-escaped. Throws an error naming the block when a diagram doesn't parse.
 */
export function renderBlocks(html: string): string {
  let diagrams = 0;

  return html.replaceAll(/<pre><code(?: class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g, (_, escapedLanguage: string | undefined, code: string) => {
    if (escapedLanguage === undefined) return `${pre("Code")}<code>${code}</code></pre>`;

    const language = unescape(escapedLanguage).toLowerCase();
    const open = `<code class="language-${escapedLanguage}">`;

    if (language === "mermaid") {
      diagrams += 1;

      return diagram(unescape(code), diagrams);
    }

    if (language === "diff" || language === "patch") return `${pre("Diff", "diff")}${open}${diff(unescape(code))}</code></pre>`;

    const name = `${escapedLanguage} code`;

    if (!isSupportedLanguage(language)) return `${pre(name)}${open}${code}</code></pre>`;

    // The highlighter's own <pre> carries inline colours for its theme; the page's styles them instead.
    const highlighted = new TextDecoder().decode(codeToHtml(unescape(code), { lang: language, theme: codeTheme })).replace(/^<pre[^>]*><code>/, "").replace(/<\/code><\/pre>$/, "");

    return `${pre(name)}${open}${highlighted}</code></pre>`;
  });
}
