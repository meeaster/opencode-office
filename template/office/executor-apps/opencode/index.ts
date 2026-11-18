import {
  defineApp,
  mutation,
  type MutationContext,
  NonRetryableError,
  query,
  type QueryContext,
  router,
  workflow,
  type WorkflowContext,
  type WorkflowStepContext,
} from "apps";
import { always } from "apps/operations/approval";

import { type Client, officeDirectory, opencode, Result, SessionRef, sessionResult, Start, startSession } from "./opencode.js";

// One shared account, so schedules and workflows can run without a caller.
const requirements = { app: { accounts: { opencode } } };

// OpenCode's mark, as its web UI serves it at /favicon.svg; the dark tile suits both themes.
const icon = {
  src: "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI1MTIiIGhlaWdodD0iNTEyIiB2aWV3Qm94PSIwIDAgNTEyIDUxMiIgZmlsbD0ibm9uZSI+PHJlY3Qgd2lkdGg9IjUxMiIgaGVpZ2h0PSI1MTIiIGZpbGw9IiMxMzEwMTAiLz48cGF0aCBkPSJNMzIwIDIyNFYzNTJIMTkyVjIyNEgzMjBaIiBmaWxsPSIjNUE1ODU4Ii8+PHBhdGggZmlsbC1ydWxlPSJldmVub2RkIiBjbGlwLXJ1bGU9ImV2ZW5vZGQiIGQ9Ik0zODQgNDE2SDEyOFY5NkgzODRWNDE2Wk0zMjAgMTYwSDE5MlYzNTJIMzIwVjE2MFoiIGZpbGw9IndoaXRlIi8+PC9zdmc+",
  mimeType: "image/svg+xml",
};

function client(
  ctx:
    | QueryContext<typeof requirements, "app">
    | MutationContext<typeof requirements, "app">
    | WorkflowStepContext<typeof requirements, "app">,
): Client {
  return { fetch: ctx.fetch, signal: ctx.signal, password: ctx.app.accounts.opencode.fields.password };
}

const start = mutation(
  {
    description:
      "Start an OpenCode session in a folder with a prompt, using the folder's default agent and Opus (claude-agent/opus, medium) unless an agent or model is named. Returns immediately; read the reply with status, or use the run workflow to wait for it.",
    input: Start,
    output: SessionRef,
    // A session can edit files and run commands in the office.
    approval: always(),
  },
  async (ctx: MutationContext<typeof requirements, "app">, input) => startSession(client(ctx), input),
);

const status = query(
  {
    description: "Read whether an OpenCode session is still running and, once it has finished, its final reply text.",
    input: SessionRef,
    output: Result,
  },
  async (ctx: QueryContext<typeof requirements, "app">, { sessionID }) => sessionResult(client(ctx), sessionID),
);

const pollInterval = "15 seconds";
const maxPolls = 240; // One hour at the poll interval.

const run = workflow(
  {
    description:
      "Start an OpenCode session with a prompt and wait for it to finish, returning its final reply. A session waiting on a permission prompt never finishes, so runs need an agent whose permissions do not ask.",
    input: Start,
    output: Result,
  },
  async ({ step }: WorkflowContext<typeof requirements, "app">, input) => {
    // Starting twice would run the prompt twice, so this step never retries.
    const { sessionID } = await step.do("start", { retries: { limit: 0, delay: "1 second" } }, async (ctx) =>
      startSession(client(ctx), input),
    );

    for (let poll = 1; poll <= maxPolls; poll += 1) {
      await step.sleep(`wait ${poll}`, pollInterval);

      const result = await step.do(`check ${poll}`, async (ctx) => sessionResult(client(ctx), sessionID));

      if (!result.running) return result;
    }

    throw new NonRetryableError(`OpenCode session ${sessionID} was still running after one hour`);
  },
);

export default defineApp(
  { ...requirements, icons: [icon] },
  {
    tools: router(
      { start, status },
      {
        title: "OpenCode",
        description: "Start and follow sessions on the office's OpenCode server.",
        instructions: `Sessions run with full access to the office. Pass an absolute folder under ${officeDirectory} (the office root as the server sees it), such as a desk's. Prefer the run workflow when the reply is needed; use start and status for long sessions you check on later.`,
      },
    ),
    workflows: { run },
  },
);
