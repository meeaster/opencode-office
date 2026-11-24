// Gives every session the office's browser tools as MCP servers, each only where its command is
// installed, and registers the package's browser-automation skill. (OpenCode ships a skill named
// `browser` itself, for its in-app browser.)
//
// - agent-browser drives a headless Chromium of its own. The package declares it as a mise tool,
//   so `office sync` writes it into the office's machine.packages.toml, which mise reads through
//   a link in its global conf.d, and it is on the PATH of the office's container (mise's shims) and
//   of a host whose mise installs it. It launches AGENT_BROWSER_EXECUTABLE_PATH when that is set:
//   the container's Chromium, or Google Chrome from apt on a host that opted in (system_chrome),
//   which the office's environment file sets and the server has from its start.
// - Browse drives the user's own Chrome through its relay and extension. It is host-mode only, as the
//   office declares (`.office.json`, which `office sync` writes from office.yaml's `opencode`): in a
//   container-mode office it is never registered, even for a host session opened in the office.
//   The package's install script puts the binary in ~/.local/bin, as Browse's installer does (or
//   $XDG_BIN_HOME, or $OPENCODE_BROWSER_HOME/bin), and those are the only places this looks:
//   xdg-utils ships an unrelated `browse` on the PATH.
//
// A missing command registers nothing, and nothing here fails a session. The office bundles it
// with the applied settings reader into the one index.js an office holds, so it runs with nothing
// installed.
import { accessSync, constants, readFileSync, realpathSync, watch } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { officeRootOf, readAppliedSettings, watchAppliedSettings } from "@office/sdk/applied-settings";

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

type Settings = { agentBrowserTools: string; browse: boolean; systemChrome: boolean };

/** Where the office runs OpenCode, as it declares; undefined before `office sync` writes it. */
type Mode = "host" | "container" | undefined;

// OpenCode loads the plugin through the link `.opencode/plugins/browser`; the real folder is the
// package's, beside its skills/ and .office.json.
const sourceDir = dirname(realpathSync(dirname(fileURLToPath(import.meta.url))));
const packageDir = sourceDir.replace(/\/\.office\/generations\/g-[a-f0-9-]+\/packages\/([^/]+)$/, "/.office/packages/$1");
const packageName = basename(packageDir);

const skillFile = join(packageDir, "skills/browser-automation/SKILL.md");

const defaults: Settings = { agentBrowserTools: "core", browse: true, systemChrome: false };

/**
 * The settings `office sync` last applied in the office that holds the package, which it checked
 * against the package's schema; the package's defaults when they can't be read. office.yaml may
 * give either as text.
 */
function readSettings(): Settings {
  try {
    const read = readAppliedSettings(officeRootOf(packageDir), packageName);

    return {
      agentBrowserTools: String(read.agent_browser_tools ?? defaults.agentBrowserTools).replaceAll(/\s+/g, ""),
      browse: String(read.browse ?? defaults.browse) !== "false",
      systemChrome: String(read.system_chrome ?? defaults.systemChrome) === "true",
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

/** The office's mode from the package's `.office.json`, which `office sync` writes. */
function readMode(): Mode {
  try {
    const read: { opencode?: string } = JSON.parse(readFileSync(join(packageDir, ".office.json"), "utf8"));

    return read.opencode === "host" || read.opencode === "container" ? read.opencode : undefined;
  } catch {
    return undefined;
  }
}

/** Each server this session gets, by name, with its command; why each other one is absent; and notes on what they drive. */
type Servers = { present: Map<string, string[]>; absent: string[]; notes: string[] };

/** Which browser agent-browser launches from this server, and whether the server predates the office's choice. */
function launchNotes(settings: Settings, mode: Mode): string[] {
  const path = process.env.AGENT_BROWSER_EXECUTABLE_PATH;

  if (path !== undefined && path !== "") return [`\`agent-browser\` launches \`${path}\` (AGENT_BROWSER_EXECUTABLE_PATH)${executable(path) ? "" : ", which isn't an executable file on this machine, so launches fail"}, with a temporary profile of its own`];

  if (settings.systemChrome && mode === "host") {
    return ["`agent-browser` launches its own Chrome for Testing: the package's `system_chrome` is on, but this OpenCode server's environment has no AGENT_BROWSER_EXECUTABLE_PATH. The office's environment file sets it where the setup applies (`office check` says), and the server gets it when it restarts, which office setup offers"];
  }

  return [];
}

function servers(settings: Settings, mode: Mode): Servers {
  const present = new Map<string, string[]>();
  const absent: string[] = [];
  const agentBrowser = findAgentBrowser();
  const browse = findBrowse();

  if (settings.agentBrowserTools === "") absent.push("`agent-browser`: turned off (the package's `agent_browser_tools` setting is empty)");
  else if (agentBrowser === undefined) absent.push("`agent-browser`: the command isn't on this server's PATH (the office's `machine.packages.toml` declares it, through a link in mise's global conf.d; `office up` installs it)");
  else present.set("agent-browser", [agentBrowser, "mcp", "--tools", settings.agentBrowserTools]);

  if (mode === "container") {
    absent.push(
      "`browse`: not in this office. Browse, the user's own Chrome, is host-mode only, and this office runs OpenCode in its container (`opencode: container`), even when a host session opens it. Use `agent-browser`, or OpenCode's in-app browser (`tools.browser.*`) when the desktop app is attached",
    );
  } else if (mode === undefined) absent.push("`browse`: the office's mode is unknown until `office sync` writes the package's `.office.json`");
  else if (!settings.browse) absent.push("`browse`: turned off (the package's `browse` setting is false)");
  else if (browse === undefined) {
    absent.push("`browse`: not installed yet. `office up` installs it once (or `mise install`, or `mise run browser:install`); it updates itself after that, and the user pairs Chrome once with `~/.local/bin/browse pair`");
  } else present.set("browse", [browse, "mcp"]);

  return { present, absent, notes: present.has("agent-browser") ? launchNotes(settings, mode) : [] };
}

/** The skill as OpenCode registers it, with which servers this session has. */
function browserSkill(settings: Settings): Skill {
  const text = readFileSync(skillFile, "utf8");
  const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);

  if (frontMatter === null) throw new Error(`${skillFile} has no front matter`);

  const line = frontMatter[1].split(/\r?\n/).find((entry) => entry.startsWith("description:"));

  if (line === undefined) throw new Error(`${skillFile} has no description`);

  const { present, absent, notes } = servers(settings, readMode());

  const available = [...[...present].map(([name, command]) => `- \`${name}\`: registered, running \`${command.join(" ")}\``), ...absent.map((reason) => `- ${reason}`), ...notes.map((note) => `- ${note}`)];

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
        for (const [name, command] of servers(readSettings(), readMode()).present) editor.set(name, { type: "local", command });
      } catch (error) {
        console.error("browser plugin: no browser MCP servers registered:", error);
      }
    });

    const reload = () => {
      void ctx.skill.reload().catch(console.error);
      void ctx.mcp.reload().catch(console.error);
    };

    // A new package set (`current`) can bring new skill text or a new mode; a local package's mode
    // is rewritten in its own folder, which reloads only when the mode changes. Either is watched
    // as a directory, so a replaced file doesn't detach the watcher.
    let mode = readMode();

    const modeWatcher = watch(sourceDir === packageDir ? packageDir : dirname(dirname(packageDir)), (_event, file) => {
      if (file !== "current" && file !== ".office.json") return;

      const next = readMode();

      if (file === ".office.json" && next === mode) return;
      mode = next;
      reload();
    });

    // Only a change to this package's settings reloads, not another package's. Until a sync
    // applies them, the session has the defaults.
    let settingsWatcher: { close(): void } | undefined;

    try {
      settingsWatcher = watchAppliedSettings(officeRootOf(packageDir), packageName, reload, console.error);
    } catch (error) {
      console.error("browser plugin: its settings aren't watched:", error);
    }

    return () => {
      modeWatcher.close();
      settingsWatcher?.close();
    };
  },
};
