import { existsSync } from "node:fs";
import { join } from "node:path";

import { cloneTarget } from "../../features/opencode/delivery.ts";
import { cloneFolder, entry as entryAt } from "../../features/opencode/ownership.ts";
import { executorEnvFile, type Office } from "../../office.ts";
import type { Stage } from "../../report/index.ts";
import type { Context, LoadedPlugin, Report, RootAnswer } from "./context.ts";

// OpenCode's list responses, with only the fields the check reads.
type Listing<Item> = { data: Item[] };

type McpServer = { name: string; status: { status: string; error?: string } };

/**
 * What the OpenCode server loads at the office root: agents, plugins and the office-executor MCP.
 * Returns the root's skills and plugins once the server listed them.
 */
export async function rootSession(office: Office, report: Report, run: Context, { auth, opencode, hasToken }: { auth: { authorization: string }; opencode: string; hasToken: boolean }, stage?: Stage): Promise<RootAnswer | undefined> {
  const base = office.opencode.directory;
  const headers = { ...auth, "x-opencode-directory": base };
  let root: RootAnswer | undefined;

  stage?.detail("root: agents, skills, plugins and MCP");

  try {
    const agents = await settle(() => getJson<Listing<{ id: string }>>(`${opencode}/api/agent`, headers), (answer) => answer.data.length > 0);

    report(agents.data.length > 0, "root: agents", agents.data.map((agent) => agent.id).join(", "));

    // Which skills load is the runtime's and its plugins' business; the root's list feeds the outside section.
    const skills = (await getJson<Listing<{ id: string; path: string }>>(`${opencode}/api/skill`, headers)).data;

    // The root's plugins, which every folder of the office loads: each package's, the office package's
    // included. A folder still loading lists none of them yet.
    // Declared clones count once they are linked; a running server only loads a link it saw appear.
    const linkedClones = office.plugins.filter((plugin) => {
      const link = entryAt(office, plugin.name);

      return link?.office === true && link.target === cloneTarget(plugin.name) && existsSync(join(office.dir, cloneFolder, plugin.name, ".git"));
    });

    const plugins = [...run.loaded.plugins.keys(), ...linkedClones.map((plugin) => plugin.name)];
    const folder = `${base}/.opencode/plugins/`;

    // Each plugin OpenCode loaded from the root's .opencode/plugins/, by folder name.
    const byName = (answer: Listing<LoadedPlugin>) =>
      new Map(answer.data.flatMap(({ source, state }) => (source.type === "local" && source.path?.startsWith(folder) ? [[source.path.slice(folder.length), state] as const] : [])));

    const pluginAnswer = await settle(() => getJson<Listing<LoadedPlugin>>(`${opencode}/api/plugin`, headers), (answer) => plugins.every((name) => byName(answer).has(name)));
    const states = byName(pluginAnswer);

    // What loads from outside is the same in every folder, so the root's answer stands for all.
    root = { skills, plugins: pluginAnswer.data };

    const pluginProblems = plugins.flatMap((name) => {
      const state = states.get(name);

      return state === undefined ? [`${name} not loaded`] : state.status === "active" ? [] : [`${name} failed: ${state.error ?? "no error given"}`];
    });

    const unloaded = plugins.filter((name) => !states.has(name));
    const hint = unloaded.length === 0 ? "" : `; if office sync just linked or moved ${unloaded.join(", ")}, restart OpenCode: a running server keeps loading a plugin from where it first found it`;

    report(pluginProblems.length === 0, "root: plugins", pluginProblems.length === 0 ? `${plugins.join(", ")} active` : pluginProblems.join("; ") + hint);

    const mcp = await settle(
      () => getJson<Listing<McpServer>>(`${opencode}/api/mcp`, headers),
      (answer) => !hasToken || answer.data.some((entry) => entry.name === "office-executor" && entry.status.status === "connected"),
    );

    const executor = mcp.data.find((entry) => entry.name === "office-executor");
    const status = executor?.status.status ?? "missing";

    report(
      status === "connected" || !hasToken,
      "root: office-executor MCP",
      hasToken ? `${status}${executor?.status.error === undefined ? "" : ` ${executor.status.error}`}` : `no token yet: office setup saves one in ${executorEnvFile(office)}`,
    );
  } catch (error) {
    report(false, "root: OpenCode", String(error));
  }

  return root;
}

export async function getJson<Result>(url: string, headers: Record<string, string> = {}): Promise<Result> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });

  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);

  return JSON.parse(await response.text());
}

// Right after `office up`, OpenCode refuses connections, then lists no agents until the folder
// has loaded. Poll until `ready` holds or a minute passes, and return the last answer.
export async function settle<Result>(read: () => Promise<Result>, ready: (value: Result) => boolean): Promise<Result> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 30; attempt++) {
    if (attempt > 0) await Bun.sleep(2_000);

    try {
      const value = await read();

      if (ready(value) || attempt === 29) return value;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError;
}
