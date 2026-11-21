import { expect, test } from "bun:test";

import { compactSessionTool } from "../plugin/compact-session.ts";

test("compact_session queues a compaction of the session that calls it, as a direct tool", async () => {
  const requests: unknown[] = [];
  const tool = compactSessionTool(async (input) => requests.push(input));

  expect(tool.options).toEqual({ codemode: false });
  expect(await tool.execute({}, { sessionID: "ses_caller" })).toEqual({ content: expect.stringContaining("queued") });
  expect(requests).toEqual([{ sessionID: "ses_caller", delivery: "queue" }]);
});
