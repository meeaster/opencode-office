// A package's Executor access (`ctx.executor`): absent without a token, scoped to the office's
// Executor, and never handing out or repeating the token or the OpenCode password.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { executorAccess } from "./executor.ts";
import { loadOffice } from "./office.ts";

const token = "tok_fixture_secret";
const password = "pw_fixture_secret";

type Seen = { method: string; path: string; authorization: string | null; body: string };

let dir: string;
let seen: Seen[];
let server: ReturnType<typeof Bun.serve>;
/** Where /moved and the connection submit redirect to, when set. */
let redirectTo: string | undefined;
let links: Record<string, { requirement: string; account: { id: string; label: string } }[]>;

const apps = [
  { id: "app_a", slug: "assistant", requirements: { accounts: { opencode: { scope: "app" } } } },
  { id: "app_b", slug: "builder", requirements: { accounts: { opencode: { scope: "app" } } } },
  { id: "app_c", slug: "plain", requirements: null },
];

const link = (id: string, host = "opencode:4096") => [{ requirement: "opencode", account: { id, label: `OpenCode (proof office at ${host})` } }];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-executor-"));
  seen = [];
  links = {};
  redirectTo = undefined;

  server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const { pathname } = new URL(request.url);
      const body = await request.text();
      const base = "/api/organizations/org_1";

      seen.push({ method: request.method, path: pathname, authorization: request.headers.get("authorization"), body });

      if (pathname === "/api/context") return Response.json({ organization: "org_1" });

      if (pathname === `${base}/apps`) return Response.json(apps);

      if (redirectTo !== undefined && (pathname === "/moved" || pathname.endsWith("/submit"))) return Response.redirect(`${redirectTo}${pathname}`, 307);

      if (pathname === "/echo") return new Response(`denied for ${request.headers.get("authorization")}`, { status: 401 });

      const linked = /^\/api\/organizations\/org_1\/apps\/(\w+)\/accounts\/app$/.exec(pathname);

      if (linked) return Response.json(links[linked[1]] ?? []);

      const put = /^\/api\/organizations\/org_1\/apps\/(\w+)\/accounts\/app\/opencode\/(\w+)$/.exec(pathname);

      if (put && request.method === "PUT") {
        links[put[1]] = link(put[2]);

        return new Response("");
      }

      if (pathname.endsWith("/accounts/app/opencode/connections")) return Response.json({ id: "conn_1" });

      if (pathname === `${base}/connections/conn_1/submit`) {
        if (JSON.parse(body).fields.password !== password) return new Response(`bad form ${body}`, { status: 400 });

        return Response.json({ id: "acct_new" });
      }

      return new Response("unexpected", { status: 404 });
    },
  });

  process.env.OFFICE_EXECUTOR_URL = server.url.origin;
  writeFileSync(join(dir, "office.yaml"), "name: proof\nstate: ./custom-state\n");
});

afterEach(() => {
  server.stop(true);
  delete process.env.OFFICE_EXECUTOR_URL;
  rmSync(dir, { recursive: true, force: true });
});

/** What a request that should fail rejected with. */
const failure = (pending: Promise<unknown> | undefined) => pending?.then(() => undefined, (caught: Error & { status?: number }) => caught);

function withState(files: Record<string, string>) {
  mkdirSync(join(dir, "custom-state"), { recursive: true });

  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, "custom-state", name), text);

  return loadOffice(dir);
}

test("absent when the runtime has no Executor token", () => {
  expect(executorAccess(withState({}))).toBeUndefined();
});

test("authenticates with the token from a custom state folder and takes only paths on the office's Executor", async () => {
  const executor = executorAccess(withState({ "office-executor.env": `EXECUTOR_TOKEN=${token}\n` }));

  expect(executor).toBeDefined();
  expect(JSON.stringify(executor)).not.toContain(token);
  expect(await executor?.request("GET", "/api/context")).toEqual({ organization: "org_1" });
  expect(seen[0].authorization).toBe(`Bearer ${token}`);

  for (const path of ["http://example.com/api/context", "//example.com/api/context", "@example.com/api/context", "api/context"]) {
    await expect(executor?.request("GET", path)).rejects.toThrow("path");
  }

  expect(seen).toHaveLength(1);
});

test("a failed request names the method, path and status, never the token, and carries the status", async () => {
  const executor = executorAccess(withState({ "office-executor.env": `EXECUTOR_TOKEN=${token}\n` }));
  const error = await failure(executor?.request("GET", "/echo"));

  expect(error?.message).toContain("GET /echo: HTTP 401");
  expect(error?.message).not.toContain(token);
  expect(error?.status).toBe(401);
});

test("a redirect is refused, so neither the token nor the OpenCode password reaches its target", async () => {
  const elsewhere: string[] = [];
  const target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => {
    elsewhere.push(request.url);

    return Response.json({ id: "acct_stolen" });
  } });

  redirectTo = target.url.origin;

  try {
    const executor = executorAccess(withState({ "office-executor.env": `EXECUTOR_TOKEN=${token}\n`, "secrets.env": `OPENCODE_PASSWORD=${password}\n` }));
    const error = await failure(executor?.request("GET", "/moved"));

    expect(error?.message).toContain("GET /moved: HTTP 307");
    expect(error?.message).not.toContain(target.url.origin);
    expect(error?.status).toBe(307);
    // The submit carrying the password is redirected too, and fails with its status alone.
    expect(await executor?.linkOpenCode("assistant").catch((caught: Error) => caught.message)).toBe("connecting assistant's OpenCode account failed: HTTP 307");
    expect(elsewhere).toEqual([]);
  } finally {
    target.stop(true);
  }
});

test("a blank token counts as none", () => {
  expect(executorAccess(withState({ "office-executor.env": "EXECUTOR_TOKEN=  \n" }))).toBeUndefined();
});

test("linking reuses another app's account for the host, connects one only when none exists, then leaves it", async () => {
  const office = withState({ "office-executor.env": `EXECUTOR_TOKEN=${token}\n`, "secrets.env": `OPENCODE_PASSWORD=${password}\n` });
  const executor = executorAccess(office);

  expect(await executor?.linkOpenCode("plain")).toEqual({ outcome: "not-required" });

  // An account for another host doesn't count.
  links.app_b = link("acct_old", "host.docker.internal:4096");
  expect(await executor?.linkOpenCode("assistant")).toEqual({ outcome: "connected", account: "acct_new" });
  expect(seen.find(each => each.path.endsWith("/submit"))?.body).toContain('"label":"OpenCode (proof office at opencode:4096)"');
  links.app_a = link("acct_new");

  expect(await executor?.linkOpenCode("builder")).toEqual({ outcome: "linked", account: "acct_new" });
  seen = [];
  expect(await executor?.linkOpenCode("builder")).toEqual({ outcome: "unchanged", account: "acct_new" });
  expect(seen.every(each => each.method === "GET")).toBe(true);
  await expect(executor?.linkOpenCode("missing")).rejects.toThrow("no Executor app missing");
});

test("a failed connection doesn't repeat the form carrying the password", async () => {
  const executor = executorAccess(withState({ "office-executor.env": `EXECUTOR_TOKEN=${token}\n`, "secrets.env": "OPENCODE_PASSWORD=wrong\n" }));
  const error = await executor?.linkOpenCode("assistant").catch((caught: Error) => caught.message);

  expect(error).toBe("connecting assistant's OpenCode account failed: HTTP 400");
});

test("a missing password names the variable, not the state folder", async () => {
  const executor = executorAccess(withState({ "office-executor.env": `EXECUTOR_TOKEN=${token}\n` }));
  const error = await executor?.linkOpenCode("assistant").catch((caught: Error) => caught.message);

  expect(error).toContain("OPENCODE_PASSWORD");
  expect(error).not.toContain(join(dir, "custom-state"));
});

test("a check's access only reads", async () => {
  const executor = executorAccess(withState({ "office-executor.env": `EXECUTOR_TOKEN=${token}\n` }), { readOnly: true });

  expect(await executor?.request("get", "/api/context")).toEqual({ organization: "org_1" });
  await expect(executor?.request("POST", "/api/organizations/org_1/apps", {})).rejects.toThrow("only reports");
  await expect(executor?.linkOpenCode("assistant")).rejects.toThrow("only reports");
  expect(seen.map(each => each.method)).toEqual(["GET"]);
});
