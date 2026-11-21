// The `compact_session` tool: compacts the session that calls it. A direct tool, not a Code Mode
// one, since it acts on the calling session. The compaction is queued, so it runs once the
// current reply ends rather than in the middle of it.

type Compact = (input: { sessionID: string; delivery: "queue" }) => Promise<unknown>;

export function compactSessionTool(compact: Compact) {
  return {
    name: "compact_session",
    description: "Compact this session: replace the conversation so far with a summary, freeing context. Use it when the user asks to compact the session. It runs once your current reply ends, so keep that reply short.",
    input: { type: "object", properties: {}, additionalProperties: false },
    options: { codemode: false },
    execute: async (_input: unknown, context: { sessionID: string }) => {
      await compact({ sessionID: context.sessionID, delivery: "queue" });

      return { content: "Compaction queued: this session is summarized once the current reply ends." };
    },
  };
}
