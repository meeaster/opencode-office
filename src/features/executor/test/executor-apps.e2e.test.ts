// The executor package in the compiled office, against a stand-in Executor: an office-local package
// contributing an app through its adapter, the inventory rejected before any request, the package's
// `apps` commands with their arguments as typed, `up` that writes and type-checks nothing when
// nothing changed, the session's app list, and an office that doesn't select executor.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fakeExecutor } from "../../../../packages/executor/test/fake-executor.ts";
import { definitionFixture, type DefinitionFixture } from "../../../../test/support/package-definition.fixture.ts";
import { rig } from "../../../../test/support/office-up.fixture.ts";
import { toolPath } from "../../../tool.ts";

const { exe, write, fixture } = definitionFixture({ second: false });

let executor: ReturnType<typeof fakeExecutor>;

beforeAll(() => { executor = fakeExecutor(); });

afterAll(() => executor.stop());

/** The office's CLI, run while this process serves the stand-in Executor. */
async function cli(f: DefinitionFixture, status: number, ...args: string[]) {
  const env = { ...f.env, OFFICE_EXECUTOR_URL: executor.url, EXECUTOR_TOKEN: "fixture", XDG_CACHE_HOME: join(f.home, "cache") };
  const child = Bun.spawn([exe, "--office", f.dir, ...args], { cwd: f.dir, env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([child.stdout.text(), child.stderr.text(), child.exited]);

  expect(code, stdout + stderr).toBe(status);

  return { stdout, stderr, both: stdout + stderr };
}

/** Package `widgets` (namespace `widget`): its adapter contributes `directory` while `app` is on. */
function widgets(f: DefinitionFixture) {
  const dir = join(f.dir, "packages/widgets");

  write(join(dir, "package.json"), JSON.stringify({ name: "@office/widgets", private: true, exports: {}, office: { definition: "./office.ts", integrations: { "@office/executor": "./executor.ts" } } }));
  write(join(dir, "office.ts"), `import { Package } from "@office/sdk";
export default Package.define({
  namespace: "widget",
  settings: { type: "object", additionalProperties: false, properties: { app: { type: "boolean", default: false }, directory: { type: "string", default: "executor-app" } } },
  setup(ctx) { if (ctx.settings.app && !ctx.providers.selected("executor")) throw new Error("app needs package executor, which office.yaml doesn't select"); },
});
`);
  write(join(dir, "executor.ts"), `import { apps } from "@office/executor/apps";
import { Package } from "@office/sdk";
import type definition from "./office.ts";
export default Package.integration<typeof definition>()({ setup(ctx) { if (ctx.settings.app) apps.add(ctx, { directory: ctx.settings.directory }); } });
`);
  write(join(dir, "executor-app/package.json"), '{ "description": "Widgets for the office.", "dependencies": { "apps": "0.0.1" } }\n');
  write(join(dir, "executor-app/package.ts"), "export const settings = { app: false, directory: \"executor-app\" };\nexport const opencode = \"container\";\n");
  write(join(dir, "executor-app/index.ts"), 'import { settings } from "./package.js";\nexport const on: boolean = settings.app;\n');
}

/** The type-check cache, with the repository's TypeScript in place of an install. */
function cache(f: DefinitionFixture) {
  const path = join(f.home, "cache/office/apps-1.0.0");

  mkdirSync(path, { recursive: true });
  symlinkSync(toolPath("node_modules"), join(path, "node_modules"));
}

function select(f: DefinitionFixture, entries: string) {
  const config = join(f.dir, "office.yaml");

  writeFileSync(config, readFileSync(config, "utf8").replace(/^packages:\n[\s\S]*$/m, `packages:\n${entries}state: ./state\n`));
}

test("an office-local package's app deploys under its namespace; the inventory is refused before any request; the commands take their words as typed; sessions list every app", async () => {
  const f = fixture("contributed");

  rmSync(join(f.dir, "executor-apps/opencode"), { recursive: true });
  widgets(f);
  cache(f);
  select(f, "  - name: executor\n  - name: widgets\n    settings: { app: true }\n");
  await cli(f, 0, "sync", "--packages");

  // --verbose reaches the package's command, which then shows its progress on standard error.
  const first = await cli(f, 0, "apps", "deploy", "--verbose");

  expect(first.stdout).toContain("created widget (app_1)");
  expect(first.stdout).toContain("deployed packages/widgets/executor-app → widget (app_1) version v1");
  expect(first.stdout).toContain("1 deployed, 0 unchanged");
  expect(first.stderr).toContain("type-checking packages/widgets/executor-app");
  expect(executor.sources.get("app_1@v1")?.find(file => file.path === "package.ts")?.content).toContain('"app": true');
  expect((await cli(f, 0, "apps", "deploy")).stdout).toContain("unchanged packages/widgets/executor-app → widget (app_1) version v1");

  // Refused from files alone: no request reaches Executor.
  const requests = executor.requests.length;

  write(join(f.dir, "executor-apps/widget/package.json"), "{}\n");
  expect((await cli(f, 1, "apps", "deploy")).both).toContain("packages/widgets/executor-app and executor-apps/widget both deploy the Executor app widget; rename one of them");
  rmSync(join(f.dir, "executor-apps/widget"), { recursive: true });
  write(join(f.dir, "packages/elsewhere/package.json"), "{}\n");
  select(f, "  - name: executor\n  - name: widgets\n    settings: { app: true, directory: ../elsewhere }\n");
  expect((await cli(f, 1, "apps", "deploy")).both).toContain("package widgets: its Executor app ../elsewhere is outside the package");
  expect(executor.requests.length).toBe(requests);

  // A catalog app without a source stays the catalog's: installed, and listed as such.
  select(f, "  - name: executor\n    settings: { catalog_apps: [github] }\n  - name: widgets\n    settings: { app: true }\n");
  write(join(f.dir, "executor-apps/assistant/package.json"), '{ "description": "Briefs.", "dependencies": { "apps": "1.0.0" } }\n');
  write(join(f.dir, "executor-apps/assistant/index.ts"), "export default {};\n");
  await cli(f, 0, "sync", "--packages");
  const third = await cli(f, 0, "apps", "deploy");

  expect(third.stdout).toContain("installed catalog app github (app_2)");
  expect(third.stdout).toContain("deployed executor-apps/assistant → assistant (app_3)");
  expect(third.stdout).toContain("1 deployed, 1 unchanged");

  const session = (await cli(f, 0, "instructions", "--packages")).stdout;

  expect(session).toContain("# Executor apps");
  expect(session.split("\n").filter(line => line.startsWith("- `"))).toEqual([
    "- `github` (catalog)",
    "- `executor-apps/assistant/`: Briefs.",
    "- `widget` (package widgets): Widgets for the office.",
  ]);
});

test("up reconciles without a write or a type-check when nothing changed; without executor selected, apps is an unknown command, up deploys nothing and sessions list no apps", async () => {
  const f = fixture("lifecycle");

  rmSync(join(f.dir, "executor-apps/opencode"), { recursive: true });
  widgets(f);
  cache(f);
  rig(f, write);
  select(f, "  - name: executor\n  - name: widgets\n    settings: { app: true }\n");
  await cli(f, 0, "sync", "--packages");
  await cli(f, 0, "apps", "deploy");

  // A type-check now would fail: its cache is gone.
  rmSync(join(f.home, "cache"), { recursive: true });
  const writes = executor.writes().length;
  const up = await cli(f, 0, "up");

  expect(up.both).toContain("package executor: unchanged packages/widgets/executor-app → widget");
  expect(up.both).toContain("package executor: 0 deployed, 1 unchanged");
  expect(executor.writes().length).toBe(writes);

  // Without the token, up fails naming what is missing.
  const child = Bun.spawnSync([exe, "--office", f.dir, "up"], { cwd: f.dir, env: f.env });

  expect(child.exitCode).toBe(1);
  expect(child.stdout.toString() + child.stderr.toString()).toContain("package executor: its up failed: the office has no Executor token");

  // Not selected: an executor-apps/ folder is just files.
  write(join(f.dir, "executor-apps/assistant/package.json"), "{}\n");
  select(f, "  - name: widgets\n");
  await cli(f, 0, "sync", "--packages");
  const requests = executor.requests.length;

  expect((await cli(f, 2, "apps", "deploy")).both).toContain("Unknown command or options: apps deploy");
  expect((await cli(f, 0, "up")).both).not.toContain("package executor");
  expect((await cli(f, 0, "instructions", "--packages")).stdout).not.toContain("Executor apps");
  expect(executor.requests.length).toBe(requests);
});

/** The MCP servers the office's installed design plugin registers, with a Doop agent key saved. */
async function doopServers(f: DefinitionFixture): Promise<string[]> {
  write(join(f.dir, ".opencode/doop/agent-key"), "doop_fixture_key\n");
  // Sync replaces the installed package, so import the current files.
  const plugin = (await import(join(realpathSync(join(f.dir, ".opencode/plugins/design")), "index.js"))).default;
  const servers: string[] = [];
  const registration = { dispose: async () => {} };

  const close = await plugin.setup({
    location: { directory: f.dir },
    skill: { transform: async () => registration, reload: async () => {} },
    mcp: { transform: async (edit: (editor: { set(name: string): void }) => void) => { edit({ set: name => servers.push(name) });

 return registration; }, reload: async () => {} },
  });

  close?.();

  return servers;
}

test("Doop's executor_app chooses its route: the app with executor selected and no doop MCP server, an error naming executor without it, and the MCP server when off", async () => {
  const f = fixture("doop");
  const doopApp = "- `doop` (package design)";

  select(f, "  - name: design\n    settings: { executor_app: true }\n");
  expect((await cli(f, 1, "sync", "--packages")).both).toContain("executor_app needs package executor, which office.yaml doesn't select");

  select(f, "  - name: executor\n  - name: design\n    settings: { executor_app: true }\n");
  await cli(f, 0, "sync", "--packages");
  expect((await cli(f, 0, "instructions", "--packages")).stdout).toContain(doopApp);
  expect(await doopServers(f)).toEqual([]);

  select(f, "  - name: executor\n  - name: design\n");
  await cli(f, 0, "sync", "--packages");
  expect((await cli(f, 0, "instructions", "--packages")).stdout).not.toContain(doopApp);
  expect(await doopServers(f)).toEqual(["doop"]);

  select(f, "  - name: design\n");
  await cli(f, 0, "sync", "--packages");
  expect(await doopServers(f)).toEqual(["doop"]);
});
