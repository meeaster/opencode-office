// A stand-in Executor for the package's tests: apps with versions and sources, a catalog, account
// links and connections, and the log of every request, so a test can count writes.
import { mkdirSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";

import type { ExecutorAccess, OpenCodeLink } from "@office/sdk";
import { client } from "../../../src/executor.ts";

type File = { path: string; content: string; encoding?: "base64" };

export type FakeApp = {
  id: string;
  slug: string;
  copiedFrom?: { name: string } | null;
  activeVersion: string | null;
  requirements?: { accounts: Record<string, { scope: string; provider?: string }> };
};

export const opencode = { url: "http://opencode:4096", directory: "/workspace/proof", mode: "container" } as const;

/** Links the test's cache to the repository's node_modules, which hold the TypeScript deploy type-checks with. */
export function typecheckCache(dir: string, version = "1.0.0"): void {
  const cache = join(dir, "cache/office", `apps-${version}`);

  mkdirSync(cache, { recursive: true });
  symlinkSync(resolve(import.meta.dir, "../../../node_modules"), join(cache, "node_modules"));
}

export function fakeExecutor() {
  const base = "/api/organizations/proof";
  const apps: FakeApp[] = [];
  const sources = new Map<string, File[]>();
  const catalog = [{ id: "github", package: "@executor.sh/github" }];
  const accountLinks = new Map<string, { requirement: string; account: { id: string; label: string; provider?: string } }[]>();
  const requests: string[] = [];
  const linked: string[] = [];
  let versions = 0;

  const deployed = (app: FakeApp, files: File[]) => {
    app.activeVersion = `v${++versions}`;
    sources.set(`${app.id}@${app.activeVersion}`, files);
  };

  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      // SAFETY: the stand-in serves only the client under test, which sends Executor's request bodies.
      const body = (request.method === "GET" ? {} : await request.json()) as { name?: string; entry?: string; files?: File[] };

      requests.push(`${request.method} ${path}`);

      if (path === "/api/context") return Response.json({ organization: "proof" });

      if (path === `${base}/framework/release`) return Response.json({ version: "1.0.0" });

      if (path === `${base}/catalog`) return Response.json(catalog.filter(item => item.id.includes(url.searchParams.get("search") ?? "")));

      if (path === `${base}/apps` && request.method === "GET") return Response.json(apps);

      if (path === `${base}/apps` && request.method === "POST") {
        const app: FakeApp = { id: `app_${apps.length + 1}`, slug: String(body.name).toLowerCase(), activeVersion: null };

        apps.push(app);

        return Response.json(app);
      }

      if (path === `${base}/apps/install`) {
        const item = catalog.find(entry => entry.id === body.entry);
        const app: FakeApp = { id: `app_${apps.length + 1}`, slug: String(body.name), copiedFrom: { name: item?.package ?? "?" }, activeVersion: null };

        apps.push(app);
        deployed(app, [{ path: "package.json", content: '{"dependencies":{"apps":"1.0.0"}}' }, { path: "index.ts", content: "export default {};\n" }]);

        return Response.json(app);
      }

      const match = /^\/api\/organizations\/proof\/apps\/([^/]+)\/(.+)$/.exec(path);
      const app = apps.find(entry => entry.id === match?.[1]);

      if (match === null || app === undefined) return new Response(`unexpected ${request.method} ${path}`, { status: 404 });

      const [, , rest] = match;

      if (rest === "deploy") {
        deployed(app, body.files ?? []);

        return Response.json({ app });
      }

      if (rest === "source") return Response.json({ files: sources.get(`${app.id}@${url.searchParams.get("version") ?? app.activeVersion}`) ?? [] });

      if (rest === "accounts/app") return Response.json(accountLinks.get(app.id) ?? []);

      if (rest.startsWith("accounts/app/") && rest.endsWith("/connections")) return Response.json({ id: "conn_1", url: "https://executor.example/connect/conn_1" });

      return new Response(`unexpected ${request.method} ${path}`, { status: 404 });
    },
  });

  const access: ExecutorAccess = {
    request: client({ url: server.url.origin, token: "fixture" }),
    opencode,
    async linkOpenCode(slug): Promise<OpenCodeLink> {
      linked.push(slug);

      return { outcome: "unchanged", account: "acct_1" };
    },
  };

  /** The requests that change Executor, which a no-write run makes none of. */
  const writes = () => requests.filter(line => !line.startsWith("GET "));

  return { url: server.url.origin, access, apps, sources, accountLinks, requests, writes, linked, stop: () => server.stop(true) };
}
