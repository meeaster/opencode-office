// Lists the office's knowledge articles in each session: every Markdown file under knowledge/
// with the description from its front matter. The folder is read on each prompt, so an article
// added mid-session shows up on the next one. Read-only: it adds no tools.
//
// It imports only Node's built-ins, so it runs with nothing installed.
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

type Context = {
  session: {
    hook(kind: "prompt", handler: (event: { sessionID: string }) => Promise<void>): Promise<{ dispose(): Promise<void> }>;
    instructions: { entry: { put(input: { sessionID: string; key: string; value: string }): Promise<void> } };
  };
};

/**
 * The office this plugin belongs to: the nearest folder above it holding office.yaml. OpenCode
 * loads it through the link `.opencode/plugins/knowledge`, and the runtime may report either that
 * path or the package's own `.office/packages/knowledge/plugin/`; both are inside the office.
 */
function findOffice(): string {
  for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "office.yaml"))) return dir;

    if (dirname(dir) === dir) throw new Error(`the knowledge plugin at ${fileURLToPath(import.meta.url)} is in no office: no office.yaml above it`);
  }
}

function description(markdown: string): string | undefined {
  const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1];
  const line = frontMatter?.split(/\r?\n/).find((entry) => entry.startsWith("description:"));

  return line?.slice("description:".length).trim().replace(/^(["'])(.*)\1$/, "$2");
}

function listing(office: string, knowledge: string): string {
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
    const office = findOffice();
    const knowledge = join(office, "knowledge");

    mkdirSync(knowledge, { recursive: true });

    // The text last attached to each session, so an unchanged list isn't announced again.
    const attached = new Map<string, string>();

    await ctx.session.hook("prompt", async ({ sessionID }) => {
      const text = listing(office, knowledge);

      if (attached.get(sessionID) === text) return;

      await ctx.session.instructions.entry.put({ sessionID, key: "knowledge", value: text });
      attached.set(sessionID, text);
    });
  },
};
