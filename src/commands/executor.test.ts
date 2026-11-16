import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOffice } from "../office.ts";
import { bootstrapExecutor, executorKeys, keyOrganization } from "./executor.ts";

const state = mkdtempSync(join(tmpdir(), "office-executor-"));
const tokenFile = join(state, "opencode-executor.env");

writeFileSync(join(state, "office.yaml"), `name: proof\nstate: .\n`);

const office = loadOffice(state);
const requests: string[] = [];
let status = 200;

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);

    if (request.headers.get("authorization") !== "Bearer fake-instance-token") return new Response(null, { status: 401 });

    return Response.json({ organization: "fake-organization" }, { status });
  },
});

const previousPort = process.env.EXECUTOR_PORT;

process.env.EXECUTOR_PORT = String(server.port);

afterAll(() => {
  if (previousPort === undefined) delete process.env.EXECUTOR_PORT;
  else process.env.EXECUTOR_PORT = previousPort;

  server.stop(true);
});

test("healthy setup rerun reuses its local token without owner credentials or auth mutations", async () => {
  writeFileSync(tokenFile, "EXECUTOR_TOKEN=fake-instance-token\n", { mode: 0o600 });
  requests.length = 0;
  status = 200;
  await bootstrapExecutor(office);
  expect(requests).toEqual(["GET /api/context"]);
  expect(readFileSync(tokenFile, "utf8")).toBe("EXECUTOR_TOKEN=fake-instance-token\n");
});

test("an auth denial allows recovery but a service failure must not trigger replacement", async () => {
  status = 403;
  expect(await keyOrganization(executorKeys(office)[0])).toBeUndefined();

  status = 503;
  requests.length = 0;
  await expect(bootstrapExecutor(office)).rejects.toThrow("not creating a replacement token");
  expect(requests).toEqual(["GET /api/context"]);
});
