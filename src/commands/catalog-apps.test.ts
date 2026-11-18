import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOffice } from "../office.ts";
import { client } from "./apps.ts";
import { adoptCatalog, catalogPlan, installMissing } from "./catalog-apps.ts";

test("catalog provisioning is install-only; a matching name alone cannot adopt a local or remote app", async () => {
  const app = { id: "app_existing", slug: "github", copiedFrom: { name: "@executor.sh/github" } };
  const posts: string[] = [];

  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      if (request.method === "POST") {
        posts.push(new URL(request.url).pathname);

        return Response.json(app);
      }

      return Response.json([{ id: "github", package: "@executor.sh/github" }]);
    },
  });

  const call = client({ url: server.url.origin, token: "fixture" });
  const base = "/api/organizations/proof";
  const apps: (typeof app)[] = [];

  try {
    for (let run = 0; run < 2; run++) {
      await installMissing(call, base, await catalogPlan(call, base, ["github"], apps, []), apps);
    }

    expect(posts).toEqual([`${base}/apps/install`]);
    await expect(catalogPlan(call, base, ["github"], [{ ...app, copiedFrom: null }], [])).rejects.toThrow("is not from");
    await expect(catalogPlan(call, base, ["github"], apps, [{ slug: "github", dir: "/desk", adopted: false }])).rejects.toThrow("local app folder");
    await expect(catalogPlan(call, base, ["git"], apps, [])).rejects.toThrow("no exact entry");
  } finally {
    await server.stop(true);
  }
});

test("adoption refuses paths outside the app and never leaves a deployable partial copy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "office-adopt-"));

  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      const { pathname } = new URL(request.url);

      if (pathname === "/api/context") return Response.json({ organization: "proof" });

      if (pathname.endsWith("/apps")) return Response.json([{ id: "app_test", slug: "github", copiedFrom: { name: "@executor.sh/github" } }]);

      if (pathname.endsWith("/catalog")) return Response.json([{ id: "github", package: "@executor.sh/github" }]);

      return Response.json({ files: ["package.json", "index.ts", "../escape"].map(path => ({ path, content: "" })) });
    },
  });

  try {
    writeFileSync(join(dir, "office.yaml"), "name: proof\nexecutor: { catalog_apps: [github] }\n");
    const call = client({ url: server.url.origin, token: "fixture" });
    await expect(adoptCatalog(loadOffice(dir), "github", call, [])).rejects.toThrow("invalid app source path");
    expect(existsSync(join(dir, "executor-apps/github"))).toBe(false);
  } finally {
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
