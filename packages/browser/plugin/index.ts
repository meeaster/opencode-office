// Gives every session the office's browser tools as MCP servers, each only where its command is
// installed, and registers the package's browser-automation skill. (OpenCode ships a skill named
// `browser` itself, for its in-app browser.)
//
// - agent-browser drives a headless Chromium of its own. The package declares it as a mise tool,
//   so `office sync` writes it into the office's .mise/conf.d/browser.toml and it is on the PATH of
//   the office's container (mise's shims) and of a host whose mise installs it.
// - Browse drives the user's own Chrome through its relay and extension. Its installer puts the
//   binary in ~/.local/bin (or $XDG_BIN_HOME, or $OPENCODE_BROWSER_HOME/bin), and that is the only
//   place this looks: xdg-utils ships an unrelated `browse` on the PATH.
//
// A missing command registers nothing, and nothing here fails a session. It imports only Node's
// built-ins, so it runs with nothing installed.
import { accessSync, constants, readFileSync, realpathSync, watch } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Skill = { id: string; name: string; description: string; path: string; content: string };

type LocalServer = { type: "local"; command: string[] };

type Context = {
  skill: {
    transform(callback: (editor: { add(skill: Skill): void }) => void): Promise<{ dispose(): Promise<void> }>;
    reload(): Promise<void>;
  };
  mcp: {
    transform(callback: (editor: { set(name: string, config: LocalServer): void }) => void): Promise<{ dispose(): Promise<void> }>;
    reload(): Promise<void>;
  };
};

type Settings = { agentBrowserTools: string; browse: boolean };

// OpenCode loads the plugin through the link `.opencode/plugins/browser`; the real folder is the
// package's, beside its skills/ and .settings.json.
const packageDir = dirname(realpathSync(dirname(fileURLToPath(import.meta.url))));

const skillFile = join(packageDir, "skills/browser-automation/SKILL.md");

const defaults: Settings = { agentBrowserTools: "core", browse: true };

/**
 * The settings `office sync` last wrote, which it checked against package.yaml; the package's
 * defaults when the file is missing or unreadable. office.yaml may give either as text.
 */
function readSettings(): Settings {
  try {
    const read: { agent_browser_tools?: string | number | boolean; browse?: string | number | boolean } = JSON.parse(readFileSync(join(packageDir, ".settings.json"), "utf8"));

    return {
      agentBrowserTools: String(read.agent_browser_tools ?? defaults.agentBrowserTools).replaceAll(/\s+/g, ""),
      browse: String(read.browse ?? defaults.browse) !== "false",
    };
  } catch {
    return defaults;
  }
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);

    return true;
  } catch {
    return false;
  }
}

/** The first `agent-browser` on this server's PATH: mise's shim in the container. */
function findAgentBrowser(): string | undefined {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter((dir) => dir !== "")
    .map((dir) => join(dir, "agent-browser"))
    .find(executable);
}

/** Browse's binary, where its installer puts it. */
function findBrowse(): string | undefined {
  const dirs = [
    ...(process.env.OPENCODE_BROWSER_HOME ? [join(process.env.OPENCODE_BROWSER_HOME, "bin")] : []),
    ...(process.env.XDG_BIN_HOME ? [process.env.XDG_BIN_HOME] : []),
    join(homedir(), ".local/bin"),
  ];

  return dirs.map((dir) => join(dir, "browse")).find(executable);
}

/** Each server this session gets, by name, with its command; and why each other one is absent. */
type Servers = { present: Map<string, string[]>; absent: string[] };

function servers(settings: Settings): Servers {
  const present = new Map<string, string[]>();
  const absent: string[] = [];
  const agentBrowser = findAgentBrowser();
  const browse = findBrowse();

  if (settings.agentBrowserTools === "") absent.push("`agent-browser`: turned off (the package's `agent_browser_tools` setting is empty)");
  else if (agentBrowser === undefined) absent.push("`agent-browser`: the command isn't on this server's PATH (the office's `.mise/conf.d/browser.toml` declares it; `mise install` in the office installs it)");
  else present.set("agent-browser", [agentBrowser, "mcp", "--tools", settings.agentBrowserTools]);

  if (!settings.browse) absent.push("`browse`: turned off (the package's `browse` setting is false)");
  else if (browse === undefined) absent.push("`browse`: Browse isn't installed for this server's user (no `~/.local/bin/browse`)");
  else present.set("browse", [browse, "mcp"]);

  return { present, absent };
}

/** The skill as OpenCode registers it, with which servers this session has. */
function browserSkill(settings: Settings): Skill {
  const text = readFileSync(skillFile, "utf8");
  const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);

  if (frontMatter === null) throw new Error(`${skillFile} has no front matter`);

  const line = frontMatter[1].split(/\r?\n/).find((entry) => entry.startsWith("description:"));

  if (line === undefined) throw new Error(`${skillFile} has no description`);

  const { present, absent } = servers(settings);

  const available = [...[...present].map(([name, command]) => `- \`${name}\`: registered, running \`${command.join(" ")}\``), ...absent.map((reason) => `- ${reason}`)];

  return {
    id: "browser-automation",
    name: "browser-automation",
    description: line.slice("description:".length).trim().replace(/^(["'])(.*)\1$/, "$2"),
    path: skillFile,
    content: `${text.slice(frontMatter[0].length)}\n## This session's servers\n\n${available.join("\n")}\n`,
  };
}

export default {
  id: "browser",
  async setup(ctx: Context) {
    await ctx.skill.transform((editor) => {
      try {
        editor.add(browserSkill(readSettings()));
      } catch (error) {
        console.error("browser plugin: the browser-automation skill isn't registered:", error);
      }
    });

    // Looked up on each load of the MCP servers, so a tool installed since is found on the next.
    await ctx.mcp.transform((editor) => {
      try {
        for (const [name, command] of servers(readSettings()).present) editor.set(name, { type: "local", command });
      } catch (error) {
        console.error("browser plugin: no browser MCP servers registered:", error);
      }
    });

    // Watch the directory so sync replacing the settings file doesn't detach the watcher.
    const watcher = watch(packageDir, (_event, file) => {
      if (file === ".settings.json") {
        void ctx.skill.reload().catch(console.error);
        void ctx.mcp.reload().catch(console.error);
      }
    });

    return () => watcher.close();
  },
};
