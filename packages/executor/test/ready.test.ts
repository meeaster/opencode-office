// Waiting for Executor before `up` deploys: a starting Executor is waited for, a refusal is not.
import { afterEach, expect, test } from "bun:test";

import { client } from "../../../src/features/executor/executor.ts";
import { ready } from "../ready.ts";
import { opencode } from "./fake-executor.ts";

let server: ReturnType<typeof Bun.serve> | undefined;

afterEach(() => server?.stop(true));

/** An Executor answering /api/context with each status of `statuses` in turn, then 200; returns how many requests it got. */
function executor(statuses: number[]) {
  const seen = { count: 0 };

  server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch() {
      const status = statuses[seen.count++] ?? 200;

      return status === 200 ? Response.json({ organization: "proof" }) : new Response("not now", { status });
    },
  });

  const access = { request: client({ url: server.url.origin, token: "fixture" }), opencode, linkOpenCode: () => Promise.reject(new Error("unused")) };

  return { access, seen };
}

test("a starting Executor that answers 503 is waited for", async () => {
  const { access, seen } = executor([503, 503]);

  await ready(access, { pause: 1 });
  expect(seen.count).toBe(3);
});

test("a refused token fails at once, without retrying", async () => {
  const { access, seen } = executor([401]);

  await expect(ready(access, { pause: 1 })).rejects.toThrow("GET /api/context: HTTP 401");
  expect(seen.count).toBe(1);
});
