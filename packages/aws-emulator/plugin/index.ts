// Registers the package's floci skill in every session, with where this office's Floci answers.
//
// The office bundles it with the applied settings reader into the one index.js an office holds,
// so it runs with nothing installed.
import { readFileSync, watch } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { type AppliedSettings, officeRootOf, watchAppliedSettings } from "@office/sdk/applied-settings";

type Skill = { id: string; name: string; description: string; path: string; content: string };

type Context = {
  skill: {
    transform(callback: (editor: { add(skill: Skill): void }) => void): Promise<{ dispose(): Promise<void> }>;
    reload(): Promise<void>;
  };
};

type Settings = { port: number; uiPort: number; storage: string };

const office = officeRootOf(dirname(fileURLToPath(import.meta.url)));
const skillFile = join(office, ".office/packages/aws-emulator/skills/floci/SKILL.md");

/** The package's applied settings, defaults included. */
function settingsOf(read: AppliedSettings): Settings {
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
    const reload = () => void ctx.skill.reload().catch(console.error);

    // The settings `office sync` last applied in the office holding the package. Only a change to
    // this package's reloads the skill, not another package's.
    const watcher = watchAppliedSettings(office, "aws-emulator", (next) => {
      applied = next;
      reload();
    }, console.error);

    let applied = watcher.settings;

    const generations = watch(join(office, ".office"), (_event, file) => {
      if (file === "current") reload();
    });

    // Without applied settings there is no address to give yet: the skill is registered once a
    // sync applies them.
    await ctx.skill.transform((editor) => {
      if (applied !== undefined) editor.add(flociSkill(settingsOf(applied), process.env.OFFICE_CONTAINER === "1"));
    });

    return () => {
      watcher.close();
      generations.close();
    };
  },
};
