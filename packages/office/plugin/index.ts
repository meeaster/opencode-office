// What every office needs from OpenCode, for every session at the root or in a desk:
//
// - the office's guidance for the session's folder, from instructions.ts, which `office
//   instructions [folder]` also runs. It is attached as a session instruction entry, refreshed on
//   each prompt, so it follows office.yaml and reaches every provider (claude-agent included);
// - the `office` skill, from the package's skills/office/;
// - the `office-executor` MCP server, the office's Executor.
//
// The office package is built into the `office` tool, which bundles this plugin with what it
// imports into the one index.js an office holds; `office sync` restores that copy.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { findOffice, officeInstructions } from "./instructions.ts";

type Skill = { id: string; name: string; description: string; path: string; content: string };

type RemoteServer = { type: "remote"; url: string; oauth: false; headers: Record<string, string> };

type Context = {
  location: { directory: string };
  session: {
    hook(kind: "prompt", handler: (event: { sessionID: string }) => Promise<void>): Promise<{ dispose(): Promise<void> }>;
    instructions: { entry: { put(input: { sessionID: string; key: string; value: string }): Promise<void> } };
  };
  skill: { transform(callback: (editor: { add(skill: Skill): void }) => void): Promise<{ dispose(): Promise<void> }> };
  mcp: { transform(callback: (editor: { set(name: string, config: RemoteServer): void }) => void): Promise<{ dispose(): Promise<void> }> };
};

// OpenCode loads the plugin through the link `.opencode/plugins/office`; the real folder is the
// one beside the package's skills/.
const skillFile = join(dirname(realpathSync(dirname(fileURLToPath(import.meta.url)))), "skills/office/SKILL.md");

/** The skill as OpenCode registers it: the description from its front matter and the body after it. */
function officeSkill(): Skill {
  const text = readFileSync(skillFile, "utf8");
  const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);

  if (frontMatter === null) throw new Error(`${skillFile} has no front matter`);

  const line = frontMatter[1].split(/\r?\n/).find((entry) => entry.startsWith("description:"));

  if (line === undefined) throw new Error(`${skillFile} has no description`);

  return { id: "office", name: "office", description: line.slice("description:".length).trim().replace(/^(["'])(.*)\1$/, "$2"), path: skillFile, content: text.slice(frontMatter[0].length) };
}

/**
 * The office's Executor address or key: in the container, OFFICE_EXECUTOR_URL (http://executor:4400)
 * and OFFICE_EXECUTOR_TOKEN (the office's key). A host server has neither, so in host mode
 * `office up` writes them to the gitignored `.opencode/office-executor.url` and
 * `.opencode/office-executor.token` instead.
 */
function executorValue(office: string, variable: string, file: string): string | undefined {
  const fromEnvironment = process.env[variable];

  if (fromEnvironment !== undefined && fromEnvironment !== "") return fromEnvironment;

  const path = join(office, ".opencode", file);

  return existsSync(path) ? readFileSync(path, "utf8").trim() || undefined : undefined;
}

export default {
  id: "office",
  async setup(ctx: Context) {
    const office = findOffice(ctx.location.directory);

    // The text last attached to each session, so an unchanged text isn't announced again.
    const attached = new Map<string, string>();

    // One instance per session folder, so the guidance is scoped to that folder.
    await ctx.session.hook("prompt", async ({ sessionID }) => {
      const text = officeInstructions(ctx.location.directory);

      if (text === "" || attached.get(sessionID) === text) return;

      await ctx.session.instructions.entry.put({ sessionID, key: "office", value: text });
      attached.set(sessionID, text);
    });

    // Read on each load of the skills, so a restored copy's text arrives without a restart.
    await ctx.skill.transform((editor) => editor.add(officeSkill()));

    if (office === undefined) return;

    // Read on each load of the MCP servers. Without an address there is nothing to connect to
    // yet; `office check` says what is missing.
    await ctx.mcp.transform((editor) => {
      const url = executorValue(office, "OFFICE_EXECUTOR_URL", "office-executor.url");
      const token = executorValue(office, "OFFICE_EXECUTOR_TOKEN", "office-executor.token") ?? "";

      // Browser elicitation turns approvals into links for the user.
      if (url !== undefined) editor.set("office-executor", { type: "remote", url: `${url}/mcp?elicitation_mode=browser`, oauth: false, headers: { Authorization: `Bearer ${token}` } });
    });
  },
};
