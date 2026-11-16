// Lists the office's knowledge articles in each session: every Markdown file under knowledge/
// with the description from its front matter. The folder is read on each prompt, so an article
// added mid-session shows up on the next one. Read-only: it adds no tools.
//
// This plugin belongs to the `office` tool: `office sync` replaces this copy with the tool's.
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

type Context = {
  session: {
    hook(kind: "prompt", handler: (event: { sessionID: string }) => Promise<void>): Promise<{ dispose(): Promise<void> }>;
    instructions: { entry: { put(input: { sessionID: string; key: string; value: string }): Promise<void> } };
  };
};

// This file is <office>/.opencode/plugins/knowledge/index.ts.
const office = fileURLToPath(new URL("../../../", import.meta.url));
const knowledge = join(office, "knowledge");

function description(markdown: string): string | undefined {
  const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1];
  const line = frontMatter?.split(/\r?\n/).find((entry) => entry.startsWith("description:"));

  return line?.slice("description:".length).trim().replace(/^(["'])(.*)\1$/, "$2");
}

function listing(): string {
  const articles = readdirSync(knowledge, { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".md") && path !== "README.md")
    .sort()
    .map((path) => {
      const about = description(readFileSync(join(knowledge, path), "utf8"));
      const location = relative(office, join(knowledge, path));

      return about === undefined ? `- \`${location}\`` : `- \`${location}\`: ${about}`;
    });

  return [
    "# Knowledge",
    "",
    "The office's knowledge articles, with paths relative to the office root. Read an article when its description matches the task.",
    "",
    ...(articles.length > 0 ? articles : ["No articles yet."]),
  ].join("\n");
}

export default {
  id: "knowledge",
  async setup(ctx: Context) {
    mkdirSync(knowledge, { recursive: true });

    // The text last attached to each session, so an unchanged list isn't announced again.
    const attached = new Map<string, string>();

    await ctx.session.hook("prompt", async ({ sessionID }) => {
      const text = listing();

      if (attached.get(sessionID) === text) return;

      await ctx.session.instructions.entry.put({ sessionID, key: "knowledge", value: text });
      attached.set(sessionID, text);
    });
  },
};
