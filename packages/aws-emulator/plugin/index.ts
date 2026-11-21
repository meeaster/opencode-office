// Registers the package's floci skill in every session, with where this office's Floci answers.
//
// It imports only Node's built-ins, so it runs with nothing installed.
import { readFileSync, realpathSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Skill = { id: string; name: string; description: string; path: string; content: string };

type Context = {
  skill: {
    transform(callback: (editor: { add(skill: Skill): void }) => void): Promise<{ dispose(): Promise<void> }>;
    reload(): Promise<void>;
  };
};

type Settings = { port: number; uiPort: number; storage: string };

// OpenCode loads the plugin through the link `.opencode/plugins/aws-emulator`; the real folder is
// the package's, beside its skills/ and .settings.json.
const sourceDir = dirname(realpathSync(dirname(fileURLToPath(import.meta.url))));
const packageDir = sourceDir.replace(/\/\.office\/generations\/g-[a-f0-9-]+\/packages\/([^/]+)$/, "/.office/packages/$1");

const skillFile = join(packageDir, "skills/floci/SKILL.md");

/**
 * The package's settings as `office sync` last wrote them, defaults applied. office.yaml may give
 * a port as text, which reaches the compose file the same way.
 */
function readSettings(): Settings {
  const read: { port: number | string; ui_port: number | string; storage: string } = JSON.parse(readFileSync(join(packageDir, ".settings.json"), "utf8"));

  return { port: Number(read.port), uiPort: Number(read.ui_port), storage: String(read.storage) };
}

/**
 * The AWS endpoint, the same from the host and from the office's container: localhost.floci.io
 * resolves to loopback (the published port) in public DNS, and to the floci service on the
 * compose network, where Floci listens on the same port.
 */
function endpoint(settings: Settings): string {
  return `http://localhost.floci.io:${settings.port}`;
}

/**
 * The console: from the office's `opencode` container, which sets OFFICE_CONTAINER=1, the floci-ui
 * service on the compose network; on the host, its loopback port under a *.localhost name, which
 * browsers resolve themselves.
 */
function consoleAddress(settings: Settings, container: boolean): string {
  return container ? "http://floci-ui:4500" : `http://floci.localhost:${settings.uiPort}`;
}

/** The skill as OpenCode registers it, with this office's addresses. */
function flociSkill(settings: Settings, container: boolean): Skill {
  const text = readFileSync(skillFile, "utf8");
  const frontMatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);

  if (frontMatter === null) throw new Error(`${skillFile} has no front matter`);

  const line = frontMatter[1].split(/\r?\n/).find((entry) => entry.startsWith("description:"));

  if (line === undefined) throw new Error(`${skillFile} has no description`);

  const kept = settings.storage === "memory" ? "State lives in memory: a restart of Floci starts empty." : `State is kept across restarts (storage mode ${settings.storage}).`;

  return {
    id: "floci",
    name: "floci",
    description: line.slice("description:".length).trim().replace(/^(["'])(.*)\1$/, "$2"),
    path: skillFile,
    content: `${text.slice(frontMatter[0].length)}\n## This office's Floci\n\n- Endpoint: ${endpoint(settings)}\n- Console: ${consoleAddress(settings, container)}${container ? `, which the user opens on their machine as http://floci.localhost:${settings.uiPort}` : ""}\n- ${kept}\n`,
  };
}

export default {
  id: "aws-emulator",
  async setup(ctx: Context) {
    await ctx.skill.transform((editor) => editor.add(flociSkill(readSettings(), process.env.OFFICE_CONTAINER === "1")));

    // Watch the directory so sync replacing the settings file doesn't detach the watcher.
    const watcher = watch(sourceDir === packageDir ? packageDir : dirname(dirname(packageDir)), (_event, file) => {
      if (file === "current" || file === ".settings.json") void ctx.skill.reload().catch(console.error);
    });

    return () => watcher.close();
  },
};
