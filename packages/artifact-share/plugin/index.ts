// Gives every session the package's share-artifact skill. A package reaches OpenCode only through
// its plugin, so the skill is registered here instead of being linked into .opencode/skills/.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { officeRootOf } from "@office/sdk/applied-settings";

type Skill = { id: string; name: string; description: string; path: string; content: string };

type Context = {
  skill: { transform(callback: (editor: { add(skill: Skill): void }) => void): Promise<{ dispose(): Promise<void> }> };
};

const office = officeRootOf(dirname(fileURLToPath(import.meta.url)));
const file = join(office, ".office/packages/artifact-share/skills/share-artifact/SKILL.md");

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
