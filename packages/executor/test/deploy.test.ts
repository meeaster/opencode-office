// Deploy against a stand-in Executor: compare first, type-check only what changed, write nothing
// when a type-check fails, keep identities, and generate the same bytes the core CLI sent.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { adoptCatalog, catalogPlan, installMissing } from "../catalog.ts";
import { deploy, officeModule, packageModule, type Reporting } from "../deploy.ts";
import { type AppFolder, appFolders } from "../inventory.ts";
import { fakeExecutor, opencode, typecheckCache } from "./fake-executor.ts";

let dir: string;
let executor: ReturnType<typeof fakeExecutor>;
let cache: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-executor-deploy-"));
  executor = fakeExecutor();
  cache = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = join(dir, "cache");
  typecheckCache(dir);
});

afterEach(async () => {
  await executor.stop();

  if (cache === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = cache;
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A root app `slug` that type-checks unless `broken`. */
function rootApp(slug: string, { broken = false, apps = "1.0.0" } = {}): void {
  write(join(dir, `executor-apps/${slug}/package.json`), `{"dependencies":{"apps":"${apps}"}}`);
  write(join(dir, `executor-apps/${slug}/index.ts`), broken ? "export const broken: number = 'text';\n" : "export default {};\n");
  write(join(dir, `executor-apps/${slug}/office.ts`), "// replaced on upload\n");
}

/** A package `demo`'s app in `packages/demo/executor-app`, with settings, as office attaches them. */
function contributed(settings: Record<string, string | boolean> = { color: "blue" }): AppFolder {
  const app = join(dir, "packages/demo/executor-app");

  write(join(app, "package.json"), '{ "dependencies": { "apps": "0.0.1" }, "executor": { "title": "Widget Dashboard" } }\n');
  write(join(app, "index.ts"), 'import { settings } from "./package.js";\nexport const color: string = settings.color;\n');
  write(join(app, "package.ts"), 'export const settings = { color: "red" };\nexport const opencode = "container";\n');

  return { slug: "widget", dir: app, where: "packages/demo/executor-app", adopted: false, contributor: { name: "demo", settings } };
}

function run(folders: AppFolder[] = appFolders(dir, [], []), catalog: string[] = []) {
  const lines: string[] = [];
  const reporting: Reporting = { line: text => lines.push(text), progress: () => {}, verbose: false };

  return { lines, done: deploy(executor.access, folders, catalog, reporting) };
}

test("a repeat deploy keeps the active version, checks no type and still checks the account link; changed files deploy again", async () => {
  rootApp("demo");
  write(join(dir, "executor-apps/demo/ui/public/pixel.bin"), Buffer.from([255, 0]));
  write(join(dir, "executor-apps/demo/ui/public/message.txt"), "café");
  expect(await run().done).toBe("1 deployed, 0 unchanged");
  executor.apps[0].requirements = { accounts: { opencode: { scope: "app" } } };

  // office.ts differs on disk, but the upload generates it, so the app is unchanged.
  write(join(dir, "executor-apps/demo/office.ts"), "// different on disk, identical on upload\n");
  const second = run();

  expect(await second.done).toBe("0 deployed, 1 unchanged");
  expect(second.lines).toContain("unchanged executor-apps/demo → demo (app_1) version v1");
  expect(executor.linked).toEqual(["demo"]);

  write(join(dir, "executor-apps/demo/ui/public/pixel.bin"), Buffer.from([255, 1]));
  expect(await run().done).toBe("1 deployed, 0 unchanged");
  rmSync(join(dir, "executor-apps/demo/ui/public/message.txt"));
  expect(await run().done).toBe("1 deployed, 0 unchanged");
  expect(executor.apps.map(app => [app.id, app.activeVersion])).toEqual([["app_1", "v3"]]);
});

test("unchanged apps are not type-checked: a source that wouldn't type-check is left alone while it is what runs", async () => {
  rootApp("demo");
  await run().done;
  const deployedVersion = executor.apps[0].activeVersion;

  // Make the running source broken too, then make the disk match it: compare says unchanged.
  rootApp("demo", { broken: true });
  executor.sources.set(`app_1@${deployedVersion}`, executor.sources.get(`app_1@${deployedVersion}`)!.map(file => file.path === "index.ts" ? { ...file, content: "export const broken: number = 'text';\n" } : file));
  const before = executor.writes().length;

  expect(await run().done).toBe("0 deployed, 1 unchanged");
  expect(executor.writes().length).toBe(before);
});

test("when changed apps fail their type-check, the command names every one and writes nothing: no manifest edit, install, create or deploy", async () => {
  rootApp("good", { apps: "0.9.0" });
  rootApp("bad", { broken: true });
  rootApp("worse", { broken: true });
  const manifest = readFileSync(join(dir, "executor-apps/good/package.json"), "utf8");
  const error = await run(appFolders(dir, ["github"], []), ["github"]).done.catch((caught: Error) => caught.message);

  expect(error).toMatch(/^executor-apps\/(bad|worse), executor-apps\/(bad|worse) don't type-check against apps@1\.0\.0; nothing was deployed$/);
  expect(error).toContain("bad");
  expect(error).toContain("worse");
  expect(executor.writes()).toEqual([]);
  expect(readFileSync(join(dir, "executor-apps/good/package.json"), "utf8")).toBe(manifest);
  expect(executor.linked).toEqual([]);
});

test("a contributed app deploys under its namespace with its generated package.ts and the served framework, leaving the package's files alone, and asks for its own account", async () => {
  const folder = contributed();
  const disk = readFileSync(join(folder.dir, "package.json"), "utf8");

  expect(await run([folder]).done).toBe("1 deployed, 0 unchanged");
  const files = executor.sources.get("app_1@v1")!;

  expect(executor.apps[0].slug).toBe("widget");
  expect(files.find(file => file.path === "package.ts")?.content).toBe(packageModule(opencode, folder.contributor!));
  expect(files.find(file => file.path === "package.json")?.content).toBe('{ "dependencies": { "apps": "1.0.0" }, "executor": { "title": "Widget Dashboard" } }\n');
  expect(readFileSync(join(folder.dir, "package.json"), "utf8")).toBe(disk);

  executor.apps[0].requirements = { accounts: { doop: { scope: "app", provider: "doop-key" }, opencode: { scope: "app" } } };
  const again = run([folder]);

  expect(await again.done).toBe("0 deployed, 1 unchanged");
  expect(again.lines).toContain("widget: connect its doop account. Open https://executor.example/connect/conn_1 (the link expires in thirty minutes; office apps deploy makes a new one)");
  expect(executor.writes().filter(line => line === "POST /api/organizations/proof/apps")).toHaveLength(1);

  // A settings change is a changed upload: the same app gets a new version.
  expect(await run([contributed({ color: "green" })]).done).toBe("1 deployed, 0 unchanged");
  expect(executor.apps.map(app => [app.id, app.activeVersion])).toEqual([["app_1", "v2"]]);
});

test("generated modules are byte for byte what the core CLI sent", () => {
  expect(officeModule(opencode)).toBe(`// Generated by \`office apps deploy\` for container mode (office.yaml's \`opencode:\`).
export const origin = "http://opencode:4096";

/** The provider's credential host: Executor sends the password only to this host and port. */
export const host = "opencode:4096";

/** Session folders are under this one. */
export const officeDirectory = "/workspace/proof";
`);
  expect(packageModule({ ...opencode, mode: "host" }, { name: "design", settings: { port: 41441, executor_app: true } })).toBe(`// Generated by \`office apps deploy\` from the design package's settings in office.yaml.
export const settings = {
  "port": 41441,
  "executor_app": true
};

/** Where the office's OpenCode server runs: "host" or "container". */
export const opencode = "host";
`);
});

test("deploy edits only dependencies.apps, then leaves an already-correct pin byte for byte", async () => {
  rootApp("demo");
  const path = join(dir, "executor-apps/demo/package.json");
  const manifest = '{\r\n  "devDependencies": {"apps": "keep"},\r\n  "extra": [{"dependencies": {"apps": "keep here too"}}],\r\n  "dependencies": {"\\u0061pps" : "0.9.0" }\r\n}\r\n';
  const expected = manifest.replace("0.9.0", "1.0.0");

  write(path, manifest);
  const { lines, done } = run();

  await done;
  expect(lines).toContain("updated executor-apps/demo/package.json: apps 0.9.0 → 1.0.0");
  expect(readFileSync(path, "utf8")).toBe(expected);
  expect(executor.sources.get("app_1@v1")?.find(file => file.path === "package.json")?.content).toBe(expected);

  const escaped = expected.replace("1.0.0", "\\u0031.0.0");

  write(path, escaped);
  const again = run();

  await again.done;
  expect(again.lines.some(line => line.startsWith("updated "))).toBe(false);
  expect(readFileSync(path, "utf8")).toBe(escaped);
  expect(executor.sources.get("app_1@v2")?.find(file => file.path === "package.json")?.content).toBe(escaped);
});

test("a missing dependencies.apps stops the batch before any manifest edit or Executor write", async () => {
  rootApp("good", { apps: "0.9.0" });
  rootApp("missing");
  write(join(dir, "executor-apps/missing/package.json"), '{"devDependencies":{"apps":"1.0.0"}}');

  await expect(run().done).rejects.toThrow("executor-apps/missing/package.json must declare dependencies.apps as a version string");
  expect(executor.writes()).toEqual([]);
  expect(readFileSync(join(dir, "executor-apps/good/package.json"), "utf8")).toBe('{"dependencies":{"apps":"0.9.0"}}');
});

test.each(["my_app", "search", "test--app", "a".repeat(64)])("refuses %s before Executor can create a differently named app", (slug) => {
  rootApp(slug);
  expect(() => run()).toThrow(`executor-apps/${slug}: ${slug} is not an Executor slug`);
  expect(executor.requests).toEqual([]);
});

test("catalog apps install once, keep the adopted app's identity, and an unadopted source can't take an installed catalog app's slug", async () => {
  await run([], ["github"]).done;
  await run([], ["github"]).done;
  expect(executor.writes()).toEqual(["POST /api/organizations/proof/apps/install"]);

  // Adopted: its source is copied with the marker and deploys onto the installed app.
  expect(await adoptCatalog(dir, ["github"], "github", executor.access, appFolders(dir, ["github"], []))).toBe("adopted github (app_1) into executor-apps/github; commit its source and use office apps deploy after editing");
  expect(readFileSync(join(dir, "executor-apps/github/.office-catalog"), "utf8")).toBe("github\n");
  await expect(adoptCatalog(dir, ["github"], "github", executor.access, [])).rejects.toThrow("already exists; adoption will not overwrite it");
  expect(await run(appFolders(dir, ["github"], []), ["github"]).done).toBe("0 deployed, 1 unchanged");
  expect(executor.apps.map(app => app.id)).toEqual(["app_1"]);

  // Unadopted, with the catalog app unlisted: rejected before any write.
  rmSync(join(dir, "executor-apps/github/.office-catalog"));
  const before = executor.writes().length;

  await expect(run(appFolders(dir, [], []), []).done).rejects.toThrow("github: local app would overwrite an installed catalog app; adopt it or rename the local folder");
  // Listed as well: the catalog plan refuses the local folder.
  await expect(run(appFolders(dir, ["github"], []), ["github"]).done).rejects.toThrow("catalog app github conflicts with a local app folder; rename one of them");
  expect(executor.writes().length).toBe(before);
});

test("on a fresh Executor, an adopted folder deploys onto the catalog app installed in the same run instead of creating another", async () => {
  write(join(dir, "executor-apps/github/package.json"), '{"dependencies":{"apps":"1.0.0"}}');
  write(join(dir, "executor-apps/github/index.ts"), "export default { edited: true };\n");
  write(join(dir, "executor-apps/github/.office-catalog"), "github\n");

  expect(await run(appFolders(dir, ["github"], []), ["github"]).done).toBe("1 deployed, 0 unchanged");
  expect(executor.writes()).toEqual(["POST /api/organizations/proof/apps/install", "POST /api/organizations/proof/apps/app_1/deploy"]);
  expect(executor.apps.map(app => [app.id, app.activeVersion])).toEqual([["app_1", "v2"]]);
});

test("the catalog plan refuses an app of another origin and an inexact ID; adoption refuses paths outside the app and leaves no partial copy", async () => {
  const base = "/api/organizations/proof";
  const github = { id: "app_9", slug: "github", activeVersion: null };

  await expect(catalogPlan(executor.access, base, ["github"], [{ ...github, copiedFrom: null }], [])).rejects.toThrow("is not from");
  await expect(catalogPlan(executor.access, base, ["git"], [], [])).rejects.toThrow("no exact entry");
  await expect(adoptCatalog(dir, [], "github", executor.access, [])).rejects.toThrow("list github in the executor package's catalog_apps setting");

  const apps: never[] = [];

  await installMissing(executor.access, base, await catalogPlan(executor.access, base, ["github"], apps, []), apps);
  executor.sources.set("app_1@v1", [{ path: "package.json", content: "{}" }, { path: "index.ts", content: "" }, { path: "../escape", content: "" }]);
  await expect(adoptCatalog(dir, ["github"], "github", executor.access, [])).rejects.toThrow("invalid app source path");
  expect(() => readFileSync(join(dir, "executor-apps/github/package.json"))).toThrow();
});

test("check reports only problems: none when deployed, a missing catalog app or undeployed app as one failure, nothing without Executor", async () => {
  const { default: definition } = await import("../office.ts");
  const host = { timers: { set: () => [], clear: () => [], status: () => [] } };
  const check = (catalog: string[], withExecutor = true) => definition.check!({ office: { dir, name: "proof", mode: "container", launcher: "office" }, entries: () => [], settings: { catalog_apps: catalog }, host, executor: withExecutor ? executor.access : undefined });

  rootApp("demo");
  expect(await check([], false)).toEqual([]);
  expect(await check(["github"])).toEqual([{ level: "failed", message: "Executor serves apps@1.0.0: catalog app github is missing; demo isn't deployed; run office apps deploy" }]);
  await run(appFolders(dir, ["github"], []), ["github"]).done;
  expect(await check(["github"])).toEqual([]);
  expect(executor.writes().filter(line => line.startsWith("POST")).length).toBe(3);
});
