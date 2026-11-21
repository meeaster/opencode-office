import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as v from "valibot";

const upload = v.object({ files: v.array(v.object({ path: v.string(), content: v.string(), encoding: v.optional(v.literal("base64")) })) });

test("apps deploy keeps the active version on a repeat run and still checks its account", async () => {
  const dir = mkdtempSync(join(tmpdir(), "office-deploy-"));
  const folder = join(dir, "executor-apps/demo");
  const cache = join(dir, "cache/office/apps-1.0.0");
  const appPath = "/api/organizations/proof/apps/app_demo";
  let created = false;
  let files: v.InferOutput<typeof upload>["files"] = [];
  let versions = 0;
  let accountChecks = 0;

  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const app = { id: "app_demo", slug: "demo", activeVersion: versions ? `v${versions}` : null, requirements: { accounts: { opencode: { scope: "app" } } } };

      if (url.pathname === "/api/context") return Response.json({ organization: "proof" });

      if (url.pathname.endsWith("/framework/release")) return Response.json({ version: "1.0.0" });

      if (url.pathname.endsWith("/apps")) {
        if (request.method === "GET") return Response.json(created ? [app] : []);
        created = true;

        return Response.json(app);
      }

      if (created && url.pathname === `${appPath}/deploy` && request.method === "POST") {
        files = v.parse(upload, await request.json()).files;

        return Response.json({ app: { ...app, activeVersion: `v${++versions}` } });
      }

      if (app.activeVersion && url.pathname === `${appPath}/source` && url.searchParams.get("version") === app.activeVersion) {
        return Response.json({ files: files.toReversed().map(file => {
          if (file.path.endsWith(".bin") && file.content === "/wA=") return { path: file.path, object: "5d983463ed9b1bcb008a040949025e83abf576d1", size: 2 };

          if (file.path.endsWith(".txt")) return { path: file.path, content: Buffer.from(file.content, "base64").toString() };

          return file;
        }) });
      }

      if (url.pathname === `${appPath}/accounts/app`) {
        accountChecks++;

        return Response.json([{ requirement: "opencode", account: { label: "OpenCode (proof office at opencode:4096)" } }]);
      }

      return new Response("unexpected request", { status: 404 });
    },
  });

  async function run() {
    const cli = Bun.spawn([process.execPath, resolve(import.meta.dir, "../cli.ts"), "apps", "deploy"], {
      cwd: dir,
      env: { ...process.env, XDG_CACHE_HOME: join(dir, "cache"), OFFICE_EXECUTOR_URL: server.url.origin, EXECUTOR_TOKEN: "fixture" },
      stdout: "pipe", stderr: "pipe",
    });

    const [stdout, stderr, code] = await Promise.all([cli.stdout.text(), cli.stderr.text(), cli.exited]);

    expect(code, stdout + stderr).toBe(0);

    return stdout + stderr;
  }

  try {
    mkdirSync(cache, { recursive: true });
    symlinkSync(resolve(import.meta.dir, "../../node_modules"), join(cache, "node_modules"));
    mkdirSync(join(folder, "ui/public"), { recursive: true });
    writeFileSync(join(dir, "office.yaml"), "name: proof\n");
    writeFileSync(join(folder, "package.json"), '{"dependencies":{"apps":"1.0.0"}}');
    writeFileSync(join(folder, "index.ts"), "export default {};\n");
    writeFileSync(join(folder, "office.ts"), "// replaced on upload\n");
    writeFileSync(join(folder, "ui/public/pixel.bin"), Buffer.from([255, 0]));
    writeFileSync(join(folder, "ui/public/message.txt"), "café");

    await run();
    expect(versions).toBe(1);
    writeFileSync(join(folder, "office.ts"), "// different on disk, identical on upload\n");
    expect(await run()).toContain("unchanged executor-apps/demo");
    expect(versions).toBe(1);
    expect(accountChecks).toBe(2);

    writeFileSync(join(folder, "ui/public/pixel.bin"), Buffer.from([255, 1]));
    await run();
    expect(versions).toBe(2);
    rmSync(join(folder, "ui/public/message.txt"));
    await run();
    expect(versions).toBe(3);
  } finally {
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
