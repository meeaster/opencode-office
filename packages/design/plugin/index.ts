// Connects every session to the office's Doop as the `doop` MCP server, and registers the package's
// doop skill. When the office turns on `executor_app`, sessions reach Doop through the package's
// doop Executor app instead, and this plugin registers no MCP server, so the tools aren't offered
// twice.
//
// Without the app, sessions authenticate with a Doop agent key, which acts as the account that minted it on every
// request. OAuth can't work from the office's container: Doop names its BETTER_AUTH_URL, the
// browser's localhost address, as the authorization server, which the container can't reach. The
// key lives in the office's `.opencode/doop/agent-key`, which the package's template keeps out of
// git; the office folder is the one place both a container session and a host session can read.
//
// It imports only Node's built-ins, so it runs with nothing installed.
import { existsSync, readFileSync, realpathSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Skill = { id: string; name: string; description: string; path: string; content: string };

type RemoteServer = { type: "remote"; url: string; oauth: false; headers: Record<string, string> };

type Context = {
  location: { directory: string };
  skill: {
    transform(callback: (editor: { add(skill: Skill): void }) => void): Promise<{ dispose(): Promise<void> }>;
    reload(): Promise<void>;
  };
  mcp: {
    transform(callback: (editor: { set(name: string, config: RemoteServer): void }) => void): Promise<{ dispose(): Promise<void> }>;
    reload(): Promise<void>;
  };
};

type Settings = { port: number; url: string; executorApp: boolean; oauth: boolean };

// OpenCode loads the plugin through the link `.opencode/plugins/design`; the real folder is the
// package's, beside its skills/ and .settings.json.
const sourceDir = dirname(realpathSync(dirname(fileURLToPath(import.meta.url))));
const packageDir = sourceDir.replace(/\/\.office\/generations\/g-[a-f0-9-]+\/packages\/([^/]+)$/, "/.office/packages/$1");

const skillFile = join(packageDir, "skills/doop/SKILL.md");

/**
 * The package's settings as `office sync` last wrote them, defaults applied. office.yaml may give
 * the port as text, which reaches the compose file the same way.
 */
function readSettings(): Settings {
  const read: { port: number | string; url: string; executor_app?: boolean | string; oauth?: boolean | string } = JSON.parse(readFileSync(join(packageDir, ".settings.json"), "utf8"));

  return { port: Number(read.port), url: read.url, executorApp: String(read.executor_app) === "true", oauth: String(read.oauth) === "true" };
}

/**
 * The address the user's browser opens, and Doop advertises, by the rule the package's compose file
 * and Executor app follow: the url setting; else http://doop.localhost:<port> when sessions sign in
 * to Doop through the Executor app, a name the browser and Executor's container both reach; else
 * http://localhost:<port>.
 */
function browserAddress(settings: Settings): string {
  if (settings.url !== "") return settings.url.replace(/\/+$/, "");

  return settings.executorApp && settings.oauth ? `http://doop.localhost:${settings.port}` : `http://localhost:${settings.port}`;
}

/**
 * The address this OpenCode server reaches Doop at: by its service name on the compose network
 * from the office's `opencode` container, which sets OFFICE_CONTAINER=1, else the loopback port
 * on the host. Doop listens on the published port inside its container too.
 */
function serverAddress(settings: Settings): string {
  return process.env.OFFICE_CONTAINER === "1" ? `http://doop:${settings.port}` : `http://localhost:${settings.port}`;
}

/** The nearest folder at or above `directory` with an office.yaml. */
function findOffice(directory: string): string | undefined {
  for (let dir = directory; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "office.yaml"))) return dir;

    if (dirname(dir) === dir) return undefined;
  }
}

const executorConnection =
  "Sessions reach it through Executor: the `doop` app's tools, found with office-executor's search, as described under \"Through Executor\". There is no `doop` MCP server.";

const keyFileConnection = "Sessions reach it as the `doop` MCP server, with the agent key file, as described under \"With the agent key file\".";

/** The skill as OpenCode registers it, with where this office's Doop opens. */
function doopSkill(settings: Settings): Skill {
  const text = readFileSync(skillFile, "utf8");
  const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);

  if (frontMatter === null) throw new Error(`${skillFile} has no front matter`);

  const line = frontMatter[1].split(/\r?\n/).find((entry) => entry.startsWith("description:"));

  if (line === undefined) throw new Error(`${skillFile} has no description`);

  return {
    id: "doop",
    name: "doop",
    description: line.slice("description:".length).trim().replace(/^(["'])(.*)\1$/, "$2"),
    path: skillFile,
    content: `${text.slice(frontMatter[0].length)}\n## This office's Doop\n\nThe user opens it at ${browserAddress(settings)}. ${settings.executorApp ? executorConnection : keyFileConnection}\n`,
  };
}

export default {
  id: "design",
  async setup(ctx: Context) {
    const office = findOffice(ctx.location.directory);

    await ctx.skill.transform((editor) => editor.add(doopSkill(readSettings())));

    // Watch the directory so sync replacing the settings file doesn't detach the watcher.
    const settingsWatcher = watch(sourceDir === packageDir ? packageDir : dirname(dirname(packageDir)), (_event, file) => {
      if (file === "current" || file === ".settings.json") {
        void ctx.skill.reload().catch(console.error);
        void ctx.mcp.reload().catch(console.error);
      }
    });

    if (office === undefined) return () => settingsWatcher.close();

    const keyDir = join(office, ".opencode/doop");
    const keyFile = join(keyDir, "agent-key");

    // Read on each load of the MCP servers. Without a key there is nothing to connect with yet; the
    // skill tells the agent how the user creates one.
    await ctx.mcp.transform((editor) => {
      const settings = readSettings();
      const key = !settings.executorApp && existsSync(keyFile) ? readFileSync(keyFile, "utf8").trim() : "";

      if (key !== "") editor.set("doop", { type: "remote", url: `${serverAddress(settings)}/mcp`, oauth: false, headers: { Authorization: `Bearer ${key}` } });
    });

    // OpenCode doesn't load its MCP servers again by itself when the key is saved, replaced or
    // deleted, so sessions would wait for a restart. The folder comes from the package's template.
    if (!existsSync(keyDir)) return () => settingsWatcher.close();

    const watcher = watch(keyDir, (_event, file) => {
      if (file === "agent-key") void ctx.mcp.reload().catch(console.error);
    });

    return () => {
      settingsWatcher.close();
      watcher.close();
    };
  },
};
