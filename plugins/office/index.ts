// Gives each session in the office the office's guidance for its folder: what is below it and how
// to work there. The text comes from instructions.ts, which `office instructions [folder]` also
// runs. It is attached as a session instruction entry, refreshed on each prompt, so it follows
// office.yaml and reaches every provider (claude-agent included) through OpenCode's instructions.
//
// This plugin belongs to the `office` tool: `office sync` replaces this copy with the tool's.
import { officeInstructions } from "./instructions.ts";

type Context = {
  location: { directory: string };
  session: {
    hook(kind: "prompt", handler: (event: { sessionID: string }) => Promise<void>): Promise<{ dispose(): Promise<void> }>;
    instructions: { entry: { put(input: { sessionID: string; key: string; value: string }): Promise<void> } };
  };
};

export default {
  id: "office",
  async setup(ctx: Context) {
    // The text last attached to each session, so an unchanged text isn't announced again.
    const attached = new Map<string, string>();

    // One instance per session folder, so the guidance is scoped to that folder.
    await ctx.session.hook("prompt", async ({ sessionID }) => {
      const text = officeInstructions(ctx.location.directory);

      if (text === "" || attached.get(sessionID) === text) return;

      await ctx.session.instructions.entry.put({ sessionID, key: "office", value: text });
      attached.set(sessionID, text);
    });
  },
};
