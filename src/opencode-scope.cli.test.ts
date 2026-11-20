import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as v from "valibot";
import { compile } from "./build.ts";

const sandbox = mkdtempSync(join(tmpdir(), "office-opencode-scope-"));
const office = join(sandbox, "bin/office");
const launcher = process.env.OFFICE_TEST_OPENCODE;

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

beforeAll(async () => {
  mkdirSync(dirname(office));
  await compile(office);
}, 60_000);

afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

const rootConfig = `{
  // The office owner's comment.
  "commands": { "scope-setting": { "description": "office-default", "template": "Office" } },
}`;

const deskConfig = `{
  // The desk owner's comment.
  "commands": { "scope-setting": { "description": "builder-override", "template": "Builder" } },
  "plugins": [{ "package": "../extensions/local", "options": {"token": "hidden-option"} }],
}`;

function command(name: string) {
  return `import {appendFileSync} from "node:fs";
    appendFileSync(process.env.SCOPE_IMPORTS, "${name}\\n");
    export default {id:"${name}", async setup(ctx) {
      await ctx.command.transform(editor => editor.add({name:"${name}", description:"scope fixture", async execute() {}}))
    }};`;
}

function fixture(name: string, endpoint: string) {
  const home = join(sandbox, name, "home");
  const dir = join(sandbox, name, "office");
  const repo = join(dir, "builder/repos/sample");
  const imports = join(home, "imports");

  const env = {
    HOME: home, PATH: "/usr/bin:/bin", NO_COLOR: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_ALLOW_PROTOCOL: "file",
    XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
    OFFICE_MACHINE_RECORD: join(home, "machine.json"), OFFICE_MACHINE_DIR: join(home, "machine"), OFFICE_MISE_CONFIG_DIR: join(home, "mise"),
    OFFICE_APP_CONFIG_DIR: join(home, "app"), OFFICE_APP_PANELS_DIR: join(home, "panels"), OFFICE_SYSTEMD_USER_DIR: join(home, "units"),
    SCOPE_IMPORTS: imports,
  };

  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  mkdirSync(join(dir, "sibling"), { recursive: true });
  expect(Bun.spawnSync(["git", "init", "-q", repo], { env }).exitCode).toBe(0);

  const yaml = `name: sample\nstate: ${home}/office-state\nopencode: {mode: host, url: ${endpoint}}\ndesks: {builder: {app: false}, sibling: {app: false}}\n`;
  const select = (selection: string) => write(join(dir, "office.yaml"), yaml + selection);
  select("packages: [{name: common}]\n");
  write(join(dir, "packages/common/package.yaml"), "name: common\ndescription: Scope fixture\n");
  write(join(dir, "packages/common/plugin/index.js"), command("shared-command"));
  write(join(dir, ".opencode/opencode.jsonc"), rootConfig);
  write(join(dir, "builder/.opencode/opencode.jsonc"), deskConfig);
  write(join(dir, "builder/extensions/local/index.js"), command("builder-command"));
  write(join(dir, "builder/.opencode/plugins/independent.js"), command("native-command"));
  write(join(repo, "opencode.json"), '{"commands":{"scope-setting":{"description":"direct-repo","template":"Repo"}}}');

  const run = async (args: string[], status = 0) => {
    const proc = Bun.spawn([office, ...args], { cwd: dir, env: args.includes("inspect") ? { ...env, PATH: join(home, "empty") } : env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);

    expect(code, stdout + stderr).toBe(status);

    return stdout + stderr;
  };

  return { home, dir, repo, imports, env, select, run };
}

test("compiled offline inventory distinguishes scoped declarations, links, clone and desktop; sync withdraws only its package link", async () => {
  let requests = 0;

  const trap = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    requests++;

    return new Response("unexpected request", { status: 500 });
  } });

  try {
    const f = fixture("offline", trap.url.origin);
    const path = (file: string) => join(f.dir, file);
    const link = path(".opencode/plugins/common");
    const sync = ["sync", "--packages"];
    const inspect = ["opencode", "inspect", "builder/repos/sample"];

    write(path("packages/common/gui/dist/gui-experimental.cjs"), "module.exports = {}");
    await f.run(sync);
    expect(readlinkSync(link)).toBe("../../packages/common/plugin");
    symlinkSync("../../packages/common/plugin", path(".opencode/plugins/owner-alias"));
    symlinkSync("../../packages/missing/elsewhere", path(".opencode/plugins/owner-dangling"));
    write(path("opencode.json"), JSON.stringify({ plugins: [
      "./packages/common/plugin", "https://hidden-user:hidden-password@example.invalid/hidden-path?hidden-query",
    ], providers: { fixture: { headers: { Authorization: "hidden-header" } } } }));
    const selected = "packages: [{name: common}]\nplugins: [{name: imported, repo: 'https://hidden-git@example.invalid/demo?hidden-ref'}]\n";

    f.select(selected.replace("{name: common}", "{name: common, settings: {note: !custom hidden-yaml-warning}}"));
    const edited = rootConfig.replace("owner's comment", "edited comment");
    write(path(".opencode/opencode.jsonc"), edited);
    // If inspect imports the definition or plugin, the marker or a failing process exposes it.
    rmSync(path("packages/common/package.yaml"));
    write(path("packages/common/office.ts"), `import {writeFileSync} from "node:fs"; writeFileSync(process.env.SCOPE_IMPORTS, "definition"); throw Error("unread");`);
    write(join(f.home, "config/opencode/opencode.json"), '{"plugins":["hidden-global-plugin"]}');
    const report = await f.run(inspect);

    expect(report).toContain("[desk builder] configured builder/extensions/local: builder/.opencode/opencode.jsonc#plugins[0]");
    expect(report).toContain("[folder builder/repos/sample] native config: builder/repos/sample/opencode.json");
    expect(report).toContain("declared Git clone (example.invalid; no checkout observed): office.yaml plugins: imported -> .opencode/plugins/imported");
    expect(report).toContain("Office package link (selected; ../../packages/common/plugin)");
    expect(report).toContain("convention plugin candidate (dangling): .opencode/plugins/owner-dangling");
    const duplicates = report.split("possible duplicate source (same target; activation not checked):")[1];

    expect(duplicates).toContain("configured packages/common/plugin: opencode.json#plugins[0]");
    expect(duplicates).toContain("Office package link (selected; ../../packages/common/plugin): .opencode/plugins/common");
    expect(report).toContain(`bundle present; listed in ${f.env.OFFICE_APP_CONFIG_DIR}/opencode.json`);
    expect(report).not.toContain("hidden-");
    expect(report).toContain("runtime not checked");
    expect(existsSync(f.imports)).toBe(false);
    expect(requests).toBe(0);
    expect(await f.run(["opencode", "inspect", "sibling"])).not.toContain("builder/");
    expect((await f.run(["opencode", "inspect", ".opencode"])).match(/native config: \.opencode\/opencode\.jsonc/g)).toHaveLength(1);

    f.select(selected);
    await f.run(sync, 1);
    expect(readFileSync(f.imports, "utf8")).toBe("definition");
    expect(readlinkSync(link)).toBe("../../packages/common/plugin");
    f.select("");
    await f.run(sync);
    await f.run(["sync"]);
    expect(existsSync(link)).toBe(false);
    expect(readlinkSync(path(".opencode/plugins/owner-alias"))).toBe("../../packages/common/plugin");
    expect(readlinkSync(path(".opencode/plugins/owner-dangling"))).toBe("../../packages/missing/elsewhere");
    expect(readFileSync(path("builder/.opencode/plugins/independent.js"), "utf8")).toBe(command("native-command"));
    expect(readFileSync(path("builder/.opencode/opencode.jsonc"), "utf8")).toBe(deskConfig);
    expect(readFileSync(path(".opencode/opencode.jsonc"), "utf8")).toBe(edited);
    // A reserved package name doesn't prove an owner directory is a legacy bundle.
    rmSync(path(".opencode/plugins/office"));
    write(path(".opencode/plugins/office/index.js"), "// independently authored");
    expect(await f.run(["sync"], 1)).toContain("not a link office sync made");
    expect(readFileSync(path(".opencode/plugins/office/index.js"), "utf8")).toBe("// independently authored");
    // A changed destination is an owner file, even for a still-selected package.
    rmSync(path("packages/common/office.ts"));
    write(path("packages/common/package.yaml"), "name: common\ndescription: Scope fixture\n");
    write(link, "owner bytes\n");
    f.select("packages: [{name: common}]\n");
    expect(await f.run(sync, 1)).toContain("not a link office sync made");
    expect(readFileSync(link, "utf8")).toBe("owner bytes\n");
    rmSync(path(".opencode/plugins"), { recursive: true });
    symlinkSync(f.env.OFFICE_APP_CONFIG_DIR, path(".opencode/plugins"));
    expect(await f.run(sync, 1)).toContain("refusing to follow or replace it");
    expect(existsSync(join(f.env.OFFICE_APP_CONFIG_DIR, "common"))).toBe(false);
  } finally {
    trap.stop(true);
  }
}, 60_000);

// Opt-in: a real v2 launcher, isolated HOME and server on a kernel-assigned loopback port.
test.skipIf(!launcher)("OpenCode sees the shared command in both desks, the builder commands and override only in builder and its repo", async () => {
  if (!launcher) throw new Error("set OFFICE_TEST_OPENCODE to an absolute OpenCode V2 launcher");

  // V2 also searches above a project and loads system config. Only run on a clean Linux hierarchy.
  if (process.platform !== "linux" || existsSync("/etc/opencode")) throw new Error("use an isolated Linux environment with no system OpenCode config");

  for (let dir = dirname(sandbox); ; dir = dirname(dir)) {
    if ([".opencode", "opencode.json", "opencode.jsonc"].some(name => existsSync(join(dir, name)))) throw new Error("fixture would inherit non-test project config; choose a clean TMPDIR");

    if (dir === dirname(dir)) break;
  }

  const f = fixture("native", "http://127.0.0.1:1");
  await f.run(["sync"]);
  await f.run(["sync", "--packages"]);
  const password = crypto.randomUUID();

  const server = Bun.spawn([launcher, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: f.home, stdout: "pipe", stderr: "inherit",
    env: { ...f.env, OPENCODE_PASSWORD: password, OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_FFF: "1",
      OPENCODE_MODELS_URL: "http://127.0.0.1:1", HTTPS_PROXY: "http://127.0.0.1:1", HTTP_PROXY: "http://127.0.0.1:1", NO_PROXY: "127.0.0.1" },
  });

  const timeout = setTimeout(() => server.kill("SIGKILL"), 45_000);

  try {
    let log = "";
    let url: string | undefined;

    for await (const bytes of server.stdout) {
      log += new TextDecoder().decode(bytes);
      url = log.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)\s/)?.[1];

      if (url) break;
    }

    if (!url) throw new Error("private fixture server did not announce its loopback URL");

    async function verify(folder: string, inBuilder: boolean, shared: boolean) {
      const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "x-opencode-directory": encodeURIComponent(folder) };

      const get = async (route: string) => {
        const response = await fetch(`${url}/api/${route}`, { headers, redirect: "error", signal: AbortSignal.timeout(10_000) });

        expect(response.status).toBe(200);

        return response.json();
      };

      const listing = async () => v.parse(v.object({ data: v.array(v.object({ name: v.string(), description: v.optional(v.string()) })) }), await get("command")).data;
      const deadline = Date.now() + 8_000;
      const expected = ["scope-setting", ...(shared ? ["shared-command"] : []), ...(inBuilder ? ["builder-command", "native-command"] : [])];
      let entries = await listing();

      // Registration is asynchronous. Wait for every positive control before testing absence.
      while (!expected.every(name => entries.some(item => item.name === name)) && Date.now() < deadline) {
        await Bun.sleep(100);
        entries = await listing();
      }

      const commands = entries.map(item => item.name);

      expect(commands.includes("shared-command")).toBe(shared);
      expect(commands.includes("builder-command")).toBe(inBuilder);
      expect(commands.includes("native-command")).toBe(inBuilder);
      expect(entries.find(item => item.name === "scope-setting")?.description).toBe(inBuilder ? "builder-override" : "office-default");
    }

    await verify(f.dir, false, true);
    await verify(join(f.dir, "builder"), true, true);
    await verify(f.repo, true, true);
    await verify(join(f.dir, "sibling"), false, true);
    f.select("");
    await f.run(["sync", "--packages"]);
    const after = join(f.repo, "after-withdrawal");
    mkdirSync(after);
    await verify(after, true, false);
  } finally {
    clearTimeout(timeout);
    server.kill("SIGKILL");
    await server.exited;
  }
}, 60_000);
