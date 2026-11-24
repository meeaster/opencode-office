// The public handle: another package adds an app with `ctx.add(apps, { app, tools })`.
import { Registry, type RegistryEntry } from "@office/sdk";

export type Tool = { name: string; readOnly: boolean };

export type App = { app: string; tools: Tool[] };

function tool(entry: RegistryEntry["field"]): Tool {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new Error("an app's tool must be { name, readOnly }");
  const { name, readOnly } = entry;

  if (typeof name !== "string" || typeof readOnly !== "boolean") throw new Error("an app's tool must be { name, readOnly }");

  return { name, readOnly };
}

export const apps = Registry.define<App>({
  id: "mock-executor.apps",
  key: entry => entry.app,
  parse({ app, tools }) {
    if (typeof app !== "string" || !Array.isArray(tools)) throw new Error("an app must be { app, tools }");

    return { app, tools: tools.map(tool) };
  },
});
