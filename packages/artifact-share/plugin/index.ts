// Gives every session the package's share-artifact skill. A package reaches OpenCode only through
// its plugin, so the skill is registered here instead of being linked into .opencode/skills/.
//
// It imports only Node's built-ins, so it runs with nothing installed.
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Skill = { id: string; name: string; description: string; path: string; content: string };

type Context = {
  skill: { transform(callback: (editor: { add(skill: Skill): void }) => void): Promise<{ dispose(): Promise<void> }> };
};

// OpenCode loads the plugin through the link `.opencode/plugins/artifact-share`; the real folder
// is the one beside the package's skills/.
const sourceDir = dirname(realpathSync(dirname(fileURLToPath(import.meta.url))));
const packageDir = sourceDir.replace(/\/\.office\/generations\/g-[a-f0-9-]+\/packages\/([^/]+)$/, "/.office/packages/$1");
const file = join(packageDir, "skills/share-artifact/SKILL.md");

/** The skill as OpenCode registers it: the description from its front matter and the body after it. */
function shareArtifact(): Skill {
  const text = readFileSync(file, "utf8");
  const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);

  if (frontMatter === null) throw new Error(`${file} has no front matter`);

  const line = frontMatter[1].split(/\r?\n/).find((entry) => entry.startsWith("description:"));

  if (line === undefined) throw new Error(`${file} has no description`);

  return {
    id: "share-artifact",
    name: "share-artifact",
    description: line.slice("description:".length).trim().replace(/^(["'])(.*)\1$/, "$2"),
    // Its references/ are read relative to this path.
    path: file,
    content: text.slice(frontMatter[0].length),
  };
}

export default {
  id: "artifact-share",
  async setup(ctx: Context) {
    // Read on each load of the skills, so an updated package's text arrives without a restart.
    await ctx.skill.transform((editor) => editor.add(shareArtifact()));
  },
};
