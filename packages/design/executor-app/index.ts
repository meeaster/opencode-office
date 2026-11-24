// Doop's MCP tools through Executor, with one Doop account linked to the app for everyone: every
// session designs as the person who connected it.
import { defineApp, toolAnnotations, withApprovals } from "apps";
import { mcpRouter } from "apps/mcp";
import { always } from "apps/operations/approval";

import { doop, endpoint } from "./doop.js";

const requirements = { app: { accounts: { doop } } };

export default defineApp(requirements, async (ctx) => {
  const account = ctx.app.accounts.doop;
  const tools = await mcpRouter({ ...endpoint(account), account, cache: ctx.cache, signal: ctx.signal });

  // Doop marks the tools that delete or overwrite work; ask before those. The router keeps Doop's own
  // server instructions, which Executor offers agents as a skill.
  return { tools: withApprovals(tools, (tool) => (toolAnnotations(tool)?.destructiveHint === true ? always() : undefined)) };
});
