import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderBlocks } from "../scripts/blocks.ts";
import { safeLinks } from "../scripts/links.ts";
import { contrast, parseTheme, syntaxRoles, toneCount, variables } from "../scripts/theme.ts";

const themes = join(import.meta.dir, "../scripts/themes");

function render(markdown: string): string {
  return safeLinks(Bun.markdown.html(markdown, { noHtmlBlocks: true, noHtmlSpans: true }));
}

describe("safeLinks", () => {
  test("keeps web, mail, relative and fragment addresses", () => {
    const html = render("[a](https://example.com/?a=1&b=2) [b](http://example.com) [c](mailto:a@example.com) [d](./notes.md) [e](#part) [f](../other/) ![g](chart.png)");

    for (const address of ['href="https://example.com/?a=1&amp;b=2"', 'href="http://example.com"', 'href="mailto:a@example.com"', 'href="./notes.md"', 'href="#part"', 'href="../other/"', 'src="chart.png"']) {
      expect(html).toContain(address);
    }
  });

  test("drops addresses that could run script, however they are written", () => {
    const html = render(
      "[a](javascript:alert(1)) [b](JaVaScRiPt:x) [c](&#106;avascript:x) [d](javascript&colon;x) [e](vbscript:x) [f](data:text/html,x) ![g](data:image/png;base64,AA) [h](unknown:x)\n\n[i][r]\n\n[r]: javascript:ref",
    );

    expect(html).not.toMatch(/\s(href|src)="/);
    expect(html).toContain(">a</a>");
    expect(html).toContain('alt="g"');
  });
});

describe("renderBlocks", () => {
  const page = (markdown: string) => safeLinks(renderBlocks(Bun.markdown.html(markdown, { noHtmlBlocks: true, noHtmlSpans: true })));

  test("keeps markup and script in a diagram's text from reaching the page", () => {
    const html = page(
      [
        "```mermaid",
        "flowchart LR",
        `  A["<script>alert(1)</script><img src=x onerror=alert(2)><a href='javascript:x'>l</a>"] --> B("<svg onload=alert(3)>")`,
        "  B --> C[\"`**md** [l](javascript:alert(4))`\"]",
        '  click A "javascript:alert(5)"',
        '  click B href "data:text/html,x"',
        '  click C "https://example.com/?a=1&b=2"',
        "```",
        "```mermaid",
        "classDiagram",
        '  class D["</text><script>x</script>"]',
        '  click D href "JaVa&#115;cript:alert(6)"',
        "```",
      ].join("\n"),
    );

    expect(html).not.toMatch(/<(?:script|img|foreignObject|iframe|object|embed)\b/i);
    expect(html).not.toMatch(/<[^>]*\son\w+=/i);
    expect(html).toContain("&lt;svg onload=alert(3)&gt;");
    expect(html).not.toMatch(/href="\s*(?:javascript|data|vbscript):/i);
    expect(html.match(/<svg\b/g)).toHaveLength(2);
    expect(html).toContain('href="https://example.com/?a=1&amp;b=2"');
  });

  test("fails on a diagram that doesn't parse, naming the block, line and column", () => {
    expect(() => page("```mermaid\nflowchart LR\n  A --> B\n```\n\n```mermaid\nflowchart TD\n  A -->\n```")).toThrow(/^mermaid block 2, line 2, column \d+: /);
  });

  test("marks a diff's lines, telling file headers from changed lines that look like them", () => {
    const html = page(["```diff", "diff --git a/x b/x", "--- a/x", "+++ b/x", "@@ -1,2 +1,2 @@", " same", "-<old>", "+new", "--- removed", "+++ added", "```"].join("\n"));
    const lines = [...html.matchAll(/<span(?: class="(\w+)")?>([^\n]*)\n<\/span>/g)].map(([, kind, text]) => [kind ?? "", text]);

    expect(lines).toEqual([
      ["file", "diff --git a/x b/x"],
      ["file", "--- a/x"],
      ["file", "+++ b/x"],
      ["hunk", "@@ -1,2 +1,2 @@"],
      ["", " same"],
      ["delete", "-&lt;old&gt;"],
      ["add", "+new"],
      ["delete", "--- removed"],
      ["add", "+++ added"],
    ]);
  });

  test("highlights a known language and leaves other blocks' code as it was, every block focusable and named", () => {
    const unknown = "```nosuchlanguage\n<b> & x\n```\n\n```\nplain <b>\n```\n\n    indented <b>\n\nInline `const x = 1`";

    expect(page(unknown).replaceAll(/<pre [^>]*>/g, "<pre>")).toBe(render(unknown));
    expect(page(unknown).match(/<pre [^>]*>/g)).toEqual([
      '<pre tabindex="0" role="group" aria-label="nosuchlanguage code">',
      '<pre tabindex="0" role="group" aria-label="Code">',
      '<pre tabindex="0" role="group" aria-label="Code">',
    ]);
    const highlighted = page('```ts\nconst x = "<b>";\n```');

    expect(highlighted).toStartWith('<pre tabindex="0" role="group" aria-label="ts code"><code class="language-ts">');
    expect(highlighted).toContain("var(--syntax-keyword)");
    expect(highlighted).toContain("&lt;b&gt;");
    expect(highlighted).not.toContain("<b>");
  });
});

describe("share-artifact's diagram references", () => {
  const references = join(import.meta.dir, "../skills/share-artifact/references");
  const files = readdirSync(references).filter((file) => file.endsWith(".md"));

  // Agents copy these examples into artifacts, so a Pele move that left them stale would fail builds.
  test.each(files)("every example in %s renders with the vendored Pele", (file) => {
    const markdown = readFileSync(join(references, file), "utf8");
    const blocks = markdown.match(/^```mermaid$/gm)?.length ?? 0;

    expect(blocks).toBeGreaterThan(0);
    expect(renderBlocks(Bun.markdown.html(markdown)).match(/<figure class="diagram"/g)).toHaveLength(blocks);
  });
});

describe("themes", () => {
  const files = readdirSync(themes).filter((file) => file.endsWith(".json"));

  test.each(files)("%s keeps text readable in light and dark", (file) => {
    const theme = parseTheme(JSON.parse(readFileSync(join(themes, file), "utf8")), file.slice(0, -".json".length));

    for (const [palette, dark] of [[theme.light, false], [theme.dark, true]] as const) {
      const colours = variables(palette, dark);

      for (const text of [colours.ink, colours.muted, colours.accent]) {
        for (const background of [colours.paper, colours.surface]) expect(contrast(text, background)).toBeGreaterThanOrEqual(4.5);
      }

      for (const role of syntaxRoles) expect(contrast(colours[`syntax-${role}`], colours.code)).toBeGreaterThanOrEqual(4.5);

      for (let index = 0; index < toneCount; index += 1) expect(contrast(colours[`series-${index}`], colours.paper)).toBeGreaterThanOrEqual(4.5);

      for (const kind of ["add", "delete"]) expect(contrast(colours[`diff-${kind}`], colours[`diff-${kind}-bg`])).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("rejects a theme file with a problem, naming it", () => {
    const palette = { neutral: "#ffffff", ink: "#000000", primary: "#0000ff", success: "#00ff00", warning: "#ffff00", error: "#ff0000", info: "#00ffff" };

    expect(() => parseTheme({ id: "other", name: "X", light: { palette }, dark: { palette } }, "mine")).toThrow('its id is "other", but the file name gives "mine"');
    expect(() => parseTheme({ id: "mine", name: "X", light: { palette: { ...palette, ink: "black" } }, dark: { palette } }, "mine")).toThrow("light.palette.ink must be a colour");
    expect(() => parseTheme({ id: "mine", name: "X", light: { palette }, dark: { palette: { ...palette, info: undefined } } }, "mine")).toThrow("dark.palette.info is missing");
    expect(() => parseTheme({ id: "mine", name: "X", light: { seeds: palette }, dark: { palette } }, "mine")).toThrow("light gives seeds");
    expect(() => parseTheme({ id: "mine", name: "X", light: { palette }, dark: { palette, overrides: { "syntax-keyword": "var(--pink)" } } }, "mine")).toThrow("dark.overrides.syntax-keyword must be a colour");
  });
});
