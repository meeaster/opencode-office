// What every office needs from OpenCode, for every session at the root or in a desk:
//
// - the office's guidance for the session's folder, from instructions.ts, which `office
//   instructions [folder]` also runs. It is attached as a session instruction entry, refreshed on
//   each prompt, so it follows office.yaml and reaches every provider (claude-agent included);
// - every skill in this package's skills/ directory;
// - the `office-executor` MCP server, the office's Executor;
// - none of the skills in the folders the office's `ignore_claude_synced_skills` and `ignore_skill_folders` settings name.
//
// The office package is built into the `office` tool, which bundles this plugin with what it
// imports into the one index.js an office holds; `office sync` restores that copy.
import { existsSync, readdirSync, readFileSync, realpathSync, watch } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expandFolder, inFolders, packageSkills, readIgnoredFolders } from "./ignored-skills.ts";
import { findOffice, officeInstructions } from "./instructions.ts";

type Skill = { id: string; name: string; description: string; path: string; content: string };

type Registration = { dispose(): Promise<void> };

type SkillEditor = { add(skill: Skill): void; list(): readonly { id: string; path: string }[]; remove(id: string): void };

type RemoteServer = { type: "remote"; url: string; oauth: false; headers: Record<string, string> };

type Context = {
  location: { directory: string };
  session: {
    hook(kind: "prompt", handler: (event: { sessionID: string }) => Promise<void>): Promise<Registration>;
    instructions: { entry: { put(input: { sessionID: string; key: string; value: string }): Promise<void> } };
  };
  skill: {
    transform(callback: (editor: SkillEditor) => void): Promise<Registration>;
    list(): Promise<{ data: readonly { id: string; path: string }[] }>;
    reload(): Promise<void>;
  };
  mcp: { transform(callback: (editor: { set(name: string, config: RemoteServer): void }) => void): Promise<Registration> };
};

// OpenCode loads the plugin through the link `.opencode/plugins/office`; the real folder is the
// one beside the package's skills/ and .settings.json.
const packageDir = dirname(realpathSync(dirname(fileURLToPath(import.meta.url))));
const skillsDir = join(packageDir, "skills");

/** A skill as OpenCode registers it: the description from its front matter and the body after it. */
function packageSkill(id: string): Skill {
  const skillFile = join(skillsDir, id, "SKILL.md");
  const text = readFileSync(skillFile, "utf8");
  const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);

  if (frontMatter === null) throw new Error(`${skillFile} has no front matter`);

  const line = frontMatter[1].split(/\r?\n/).find((entry) => entry.startsWith("description:"));

  if (line === undefined) throw new Error(`${skillFile} has no description`);

  return { id, name: id, description: line.slice("description:".length).trim().replace(/^(["'])(.*)\1$/, "$2"), path: skillFile, content: text.slice(frontMatter[0].length) };
}

/**
 * The office's Executor address or key: in the container, OFFICE_EXECUTOR_URL (http://executor:4400)
 * and OFFICE_EXECUTOR_TOKEN (the office's key). A host server has neither, so `office up` writes
 * them, in either mode, to the gitignored `.opencode/office-executor.url` and
 * `.opencode/office-executor.token`, with Executor's published loopback address.
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

    // Which loaded skills the office's skill-folder settings hide: those whose file is in
    // one of its folders, except an ID one of the office's packages has, which the outside skill
    // replaced. Read on each use, so the next `office sync`'s setting and a package added since apply.
    const hidden = (skills: readonly { id: string; path: string }[]): string[] => {
      if (office === undefined) return [];

      const folders = readIgnoredFolders(packageDir).map((folder) => expandFolder(folder, homedir(), office));

      if (folders.length === 0) return [];

      const provided = packageSkills(office);

      return skills.filter((skill) => !provided.has(skill.id) && inFolders(folders, skill.path)).map((skill) => skill.id);
    };

    // OpenCode applies skill transforms in the order they were registered, on every load of the
    // skills, and reads the global and compatibility skill folders in plugins of its own that
    // register after this one. So the removal is registered again, last, whenever a skill it should
    // have removed is still listed: once after startup, and again should a later registration ever
    // follow it. From then on it runs on each load, which OpenCode starts when a folder changes.
    let removal: Registration | undefined;
    let stopped = false;

    const removeIgnored = async (): Promise<void> => {
      if (stopped || hidden((await ctx.skill.list()).data).length === 0) return;

      const earlier = removal;

      removal = await ctx.skill.transform((editor) => {
        for (const id of hidden(editor.list())) editor.remove(id);
      });
      await earlier?.dispose();
    };

    // One check after each load of the skills, once the load has finished.
    let check: ReturnType<typeof setTimeout> | undefined;

    const checkAfterLoad = (): void => {
      if (stopped || office === undefined) return;

      clearTimeout(check);
      check = setTimeout(() => void removeIgnored().catch((error: unknown) => console.error("office plugin: skills in ignored folders may still be listed:", error)), 0);
    };

    // Read on each load of the skills, so a restored copy's text arrives without a restart.
    await ctx.skill.transform((editor) => {
      for (const id of readdirSync(skillsDir)) editor.add(packageSkill(id));

      checkAfterLoad();
    });

    if (office === undefined) return;

    // A prompt never starts with one still listed.
    await ctx.session.hook("prompt", removeIgnored);

    // The setting as the next `office sync` writes it applies at once, a folder taken out of it
    // included. The directory is watched, since sync replaces the file.
    const watcher = watch(packageDir, (_event, file) => {
      if (file === ".settings.json") void ctx.skill.reload().catch(console.error);
    });

    // Read on each load of the MCP servers. Without an address there is nothing to connect to
    // yet; `office check` says what is missing.
    await ctx.mcp.transform((editor) => {
      const url = executorValue(office, "OFFICE_EXECUTOR_URL", "office-executor.url");
      const token = executorValue(office, "OFFICE_EXECUTOR_TOKEN", "office-executor.token") ?? "";

      // Browser elicitation turns approvals into links for the user.
      if (url !== undefined) editor.set("office-executor", { type: "remote", url: `${url}/mcp?elicitation_mode=browser`, oauth: false, headers: { Authorization: `Bearer ${token}` } });
    });

    return () => {
      stopped = true;
      clearTimeout(check);
      watcher.close();
    };
  },
};
