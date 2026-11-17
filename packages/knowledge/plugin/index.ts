// Discovers maintained articles and registers this package's authoring skill. Legacy free-form
// articles stay discoverable until the office explicitly migrates them. No knowledge is written.
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

type Skill = { id: string; name: string; description: string; path: string; content: string };

type Context = {
  skill: { transform(callback: (editor: { add(skill: Skill): void }) => void): Promise<{ dispose(): Promise<void> }> };
  session: {
    hook(kind: "prompt", handler: (event: { sessionID: string }) => Promise<void>): Promise<{ dispose(): Promise<void> }>;
    instructions: { entry: { put(input: { sessionID: string; key: string; value: string }): Promise<void> } };
  };
};

const packageDir = dirname(realpathSync(dirname(fileURLToPath(import.meta.url))));

/**
 * The office this plugin belongs to: the nearest folder above it holding office.yaml. OpenCode
 * loads it through the link `.opencode/plugins/knowledge`, and the runtime may report either that
 * path or the package's own `.office/packages/knowledge/plugin/`; both are inside the office.
 */
function findOffice(): string {
  for (let dir = packageDir; ; dir = dirname(dir)) {
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
  const articles: string[] = [];
  const legacy: string[] = [];
  const paths = existsSync(knowledge) ? readdirSync(knowledge, { recursive: true, encoding: "utf8" }).sort() : [];

  for (const path of paths) {
    const parts = path.split(sep);

    if (!path.endsWith(".md") || ["README.md", "AGENTS.md", "origins.md"].includes(basename(path))) continue;

    if (parts.some((part) => part.startsWith(".")) || ["references", "sources", "evidence"].includes(parts[0])) continue;

    const about = description(readFileSync(join(knowledge, path), "utf8"));
    const location = relative(office, join(knowledge, path));
    const line = about === undefined ? `- \`${location}\`` : `- \`${location}\`: ${about}`;

    if (parts[0] === "articles") articles.push(line);
    else legacy.push(line);
  }

  return [
    "# Knowledge",
    "",
    "Paths are relative to the office root. Before looking up or changing knowledge, read `knowledge/AGENTS.md` if present. Proactively read articles whose descriptions match the task.",
    "",
    "Suggest a concrete durable addition or update only when it would save future research, preferably in an existing article. Write or capture only when asked or explicitly assigned. A suspected stale claim may justify a suggestion, not an automatic refresh. Re-check only when asked. There is no automatic curation or ongoing maintenance.",
    "",
    "Load `knowledge-base` before an assigned change. 'Save this' preserves a source or evidence; 'write this up' synthesizes maintained articles.",
    "",
    ...(articles.length > 0 ? articles : ["No articles yet."]),
    ...(legacy.length > 0 ? ["", "## Legacy articles", "", "These remain readable. Conversion to articles/ with provenance requires an explicit migration; sync does not move or rewrite them.", "", ...legacy] : []),
  ].join("\n");
}

export default {
  id: "knowledge",
  async setup(ctx: Context) {
    const office = findOffice();
    const knowledge = join(office, "knowledge");

    await ctx.skill.transform((editor) => {
      const path = join(packageDir, "skills/knowledge-base/SKILL.md");
      const text = readFileSync(path, "utf8");
      const frontMatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(text);
      const about = description(text);

      if (frontMatter === null || about === undefined) throw new Error(`${path} needs front matter with a description`);

      editor.add({ id: "knowledge-base", name: "knowledge-base", description: about, path, content: text.slice(frontMatter[0].length) });
    });

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
