import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as v from "valibot";

import { loadOffice } from "../office.ts";
import { contextReport, parseModel, probeTitle, removeStrayProbes } from "./context.ts";
import { toolPath } from "../tool.ts";

const auth = `Basic ${Buffer.from("opencode:fixture").toString("base64")}`;

type Session = { id: string; title: string; directory: string; model?: { id: string; providerID: string; variant?: string } };

/** What the command sends to create a session, checked as the real server would. */
const createBody = v.object({ title: v.string(), location: v.object({ directory: v.string() }), model: v.object({ id: v.string(), providerID: v.string(), variant: v.optional(v.string()) }) });

/** A fake OpenCode server: sessions, one answer per prompt chosen by `answer`, and a log of every request. */
function fakeServer(answer: (session: Session, baseline: boolean) => object, existing: Session[] = []) {
  const sessions = new Map(existing.map((session) => [session.id, session]));
  const requests: string[] = [];
  const answers = new Map<string, object>();
  let next = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      if (request.headers.get("authorization") !== auth) return new Response(null, { status: 403 });

      const url = new URL(request.url);
      const parts = url.pathname.split("/").filter(Boolean);

      requests.push(`${request.method} ${url.pathname}`);

      if (request.method === "GET" && url.pathname === "/api/session") {
        const search = url.searchParams.get("search") ?? "";
        const words = search.split(" ");

        // Fuzzy, like the real server: any title sharing a word matches.
        return Response.json({ data: [...sessions.values()].filter((session) => words.some((word) => session.title.includes(word))), cursor: {} });
      }

      if (request.method === "POST" && url.pathname === "/api/session") {
        const body = v.parse(createBody, await request.json());
        const id = `ses_${++next}`;

        sessions.set(id, { id, title: body.title, directory: body.location.directory, model: body.model });

        return Response.json({ data: { id, title: body.title } });
      }

      const id = parts.find((part) => part.startsWith("ses_")) ?? "";
      const session = sessions.get(id);

      if (session === undefined) return new Response(null, { status: 404 });

      if (request.method === "DELETE" && parts.length === 3) {
        sessions.delete(id);

        return new Response(null, { status: 204 });
      }

      if (request.method === "POST" && parts[3] === "prompt") {
        const answered = answer(session, session.directory.includes("office-context-"));

        if ("httpStatus" in answered) return new Response("provider unavailable", { status: Number(answered.httpStatus) });

        answers.set(id, answered);

        return Response.json({ data: {} });
      }

      if (request.method === "POST" && parts.at(-1) === "wait") return new Response(null, { status: 204 });

      if (request.method === "GET" && parts[3] === "message") {
        return Response.json({ data: [{ type: "user", time: { created: 1 } }, { type: "assistant", time: { created: 2 }, ...answers.get(id) }] });
      }

      if (request.method === "GET" && parts.at(-1) === "entries") return Response.json({ data: [{ key: "office", value: "x".repeat(1234) }, { key: "knowledge", value: "yy" }] });

      return new Response(null, { status: 404 });
    },
  });

  return { server, sessions, requests };
}

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

function officeAt(server: { url: URL }, extra = "") {
  const dir = mkdtempSync(join(tmpdir(), "office-ctx-test-"));

  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "office.yaml"), `name: proof\nstate: .\nopencode: { mode: host, url: "${server.url.origin}" }\n${extra}`);
  writeFileSync(join(dir, "secrets.env"), "OPENCODE_PASSWORD=fixture\n");
  mkdirSync(join(dir, "repos/notes"), { recursive: true });

  return loadOffice(dir);
}

function tokens(input: number, read: number, write: number) {
  return { finish: "stop", tokens: { input, output: 1, reasoning: 0, cache: { read, write } } };
}

test("parses OpenCode's provider/model#variant notation", () => {
  expect(parseModel("openai/gpt-6-luna#low")).toEqual({ providerID: "openai", id: "gpt-6-luna", variant: "low" });
  expect(parseModel("claude-agent/haiku")).toEqual({ providerID: "claude-agent", id: "haiku" });
  expect(parseModel("openrouter/vendor/model#high")).toEqual({ providerID: "openrouter", id: "vendor/model", variant: "high" });

  for (const bad of ["haiku", "openai/", "/haiku", "openai/gpt#", "openai/gpt#a#b", "openai/gpt 6"]) expect(() => parseModel(bad)).toThrow("provider/model");
});

test("office.yaml does not accept context models", () => {
  const { server } = fakeServer(() => ({}));

  cleanups.push(() => server.stop(true));

  expect(() => officeAt(server, "context:\n  models: [provider/model]\n")).toThrow("context");
});

test("counts input and cache tokens, reports the folder's entries and deletes every probe session", async () => {
  const { server, sessions, requests } = fakeServer((session, baseline) => session.model?.providerID === "claude-agent"
    ? (baseline ? tokens(2, 6139, 7800) : tokens(2, 6139, 12308))
    : (baseline ? tokens(7175, 0, 0) : tokens(9000, 1158, 0)));

  cleanups.push(() => server.stop(true));

  const office = officeAt(server);
  const report = await contextReport(office, join(office.dir, "repos/notes"), ["openai/gpt-6-luna#low", "claude-agent/haiku#low"]);

  expect(report.failed).toBe(false);
  expect(report.text).toContain("openai/gpt-6-luna#low   baseline   7,175  folder  10,158  office adds  +2,983");
  expect(report.text).toContain("claude-agent/haiku#low  baseline  13,941  folder  18,449  office adds  +4,508");
  expect(report.text).toContain("office       1,234");
  expect(report.text).toContain("knowledge        2");
  expect(sessions.size).toBe(0);
  // Entries are read once, from the first folder probe.
  expect(requests.filter((line) => line.endsWith("/entries"))).toHaveLength(1);
  expect(requests.filter((line) => line.startsWith("POST /api/session/") && line.endsWith("/prompt"))).toHaveLength(4);
});

test("a failed request reports the provider's message, still deletes the session and measures the other models", async () => {
  const { server, sessions } = fakeServer((session) => session.model?.providerID === "broke"
    ? { finish: "error", error: { type: "api", message: "Insufficient balance", status: 402 } }
    : tokens(100, 0, 0));

  cleanups.push(() => server.stop(true));

  const office = officeAt(server);
  const report = await contextReport(office, office.dir, ["broke/model", "fine/model"]);

  expect(report.failed).toBe(true);
  expect(report.text).toContain("broke/model  failed: Insufficient balance (HTTP 402)");
  expect(report.text).toContain("fine/model   baseline     100  folder     100  office adds      +0");
  expect(sessions.size).toBe(0);
});

test("a prompt the server refuses still deletes the session", async () => {
  const { server, sessions } = fakeServer(() => ({ httpStatus: 503 }));

  cleanups.push(() => server.stop(true));

  const office = officeAt(server);
  const report = await contextReport(office, office.dir, ["down/model"]);

  expect(report.failed).toBe(true);
  expect(report.text).toContain("down/model  failed: the prompt answered HTTP 503: provider unavailable");
  expect(sessions.size).toBe(0);
});

test("removes only leftover sessions titled exactly as probes", async () => {
  const { server, sessions } = fakeServer(() => tokens(1, 0, 0), [
    { id: "ses_left1", title: probeTitle, directory: "/tmp/a" },
    { id: "ses_left2", title: probeTitle, directory: "/tmp/b" },
    { id: "ses_mine", title: `${probeTitle} notes`, directory: "/tmp/c" },
    { id: "ses_other", title: "office context", directory: "/tmp/d" },
  ]);

  cleanups.push(() => server.stop(true));

  expect(await removeStrayProbes(officeAt(server))).toBe(2);
  expect([...sessions.keys()].sort()).toEqual(["ses_mine", "ses_other"]);
});

test("context requires --model, rejects a folder argument and measures the working directory", async () => {
  const measured: string[] = [];

  const { server, requests } = fakeServer((session, baseline) => {
    if (!baseline) measured.push(`${session.model?.id} in ${session.directory}`);

    return tokens(1, 0, 0);
  });

  cleanups.push(() => server.stop(true));

  const office = officeAt(server);
  const cwd = join(office.dir, "repos/notes");
  const command = [process.execPath, toolPath("src/cli.ts"), "--office", office.dir, "context"];

  for (const args of [[], [office.dir, "--model", "provider/one"]]) {
    const invalid = Bun.spawnSync([...command, ...args], { cwd });

    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr.toString()).toContain("usage: office context --model");
  }

  expect(requests).toHaveLength(0);

  const run = Bun.spawn([...command, "--model", "provider/one", "--model", "provider/two"], { cwd, stdout: "pipe" });

  expect(await run.exited).toBe(0);
  expect(measured).toEqual([`one in ${cwd}`, `two in ${cwd}`]);
});

test("refuses in container mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "office-ctx-test-"));

  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "office.yaml"), "name: proof\nstate: .\n");

  await expect(contextReport(loadOffice(dir), dir, ["openai/gpt-6-luna#low"])).rejects.toThrow("host-mode");
});
