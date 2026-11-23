// The compiled-office fixture the opencode-scope end-to-end files share. Each file calls
// scopeFixture() once, at the top level: it registers that file's own beforeAll/afterAll, so files
// run in parallel each get their own executable and scratch folder.
import { afterAll, beforeAll, expect, setDefaultTimeout } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { compile } from "./build.ts";
import { pluginDefinition, writePackage } from "./test-package.ts";

/** Opt-in: an absolute OpenCode V2 launcher for the native check. */
export const launcher = process.env.OFFICE_TEST_OPENCODE;

/** Opt-in: the compiled CLI from before authored registration, as a control. */
export const groundwork = process.env.OFFICE_TEST_PRE_ASSETS;

/** Opt-in control: the compiled CLI from before plugin delivery refused owner folders (567252f). */
export const control = process.env.OFFICE_TEST_PLUGIN_CONTROL;

export function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export const rootConfig = `{
  // The office owner's comment.
  "commands": { "scope-setting": { "description": "office-default", "template": "Office" } },
}`;

export const deskConfig = `{
  // The desk owner's comment.
  "commands": { "scope-setting": { "description": "builder-override", "template": "Builder" } },
  "plugins": [{ "package": "../extensions/local", "options": {"token": "hidden-option"} }],
}`;

/** A plugin that records its import in SCOPE_IMPORTS and registers one command. */
export function command(name: string) {
  return `import {appendFileSync} from "node:fs";
    appendFileSync(process.env.SCOPE_IMPORTS, "${name}\\n");
    export default {id:"${name}", async setup(ctx) {
      await ctx.command.transform(editor => editor.add({name:"${name}", description:"scope fixture", async execute() {}}))
    }};`;
}

export function gitAt(dir: string, env: Record<string, string>, ...args: string[]) {
  const res = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: dir, env });
  expect(res.exitCode, res.stderr.toString()).toBe(0);

  return res.stdout.toString().trim();
}

/** Every entry under `dir` with its mode and contents, and the folder's own inode and mode. */
export function snapshot(dir: string) {
  const entries: Record<string, string> = {};

  const walk = (folder: string) => {
    for (const name of readdirSync(join(dir, folder)).sort()) {
      const path = join(folder, name);
      const info = lstatSync(join(dir, path));

      if (info.isDirectory()) {
        entries[path] = `folder ${info.mode}`;
        walk(path);
      } else entries[path] = `${info.mode} ${readFileSync(join(dir, path), "base64")}`;
    }
  };

  walk("");
  const { ino, mode } = statSync(dir);

  return { ino, mode, entries };
}

export function scopeFixture() {
  // An end-to-end test spawns the compiled office many times; under a parallel run it gets 30s, not Bun's 5s.
  setDefaultTimeout(30_000);

  const sandbox = mkdtempSync(join(tmpdir(), "office-opencode-scope-"));
  const office = join(sandbox, "bin/office");

  beforeAll(async () => {
    mkdirSync(dirname(office));
    await compile(office);
  }, 60_000);

  afterAll(() => rmSync(sandbox, { recursive: true, force: true }));

  function fixture(name: string, endpoint: string) {
    const home = join(sandbox, name, "home");
    const dir = join(sandbox, name, "office");
    const repo = join(dir, "builder/repos/sample");
    const imports = join(home, "imports");

    const env = {
      HOME: home, TMPDIR: tmpdir(), PATH: "/usr/bin:/bin", NO_COLOR: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_ALLOW_PROTOCOL: "file",
      XDG_DATA_HOME: join(home, "data"), XDG_CONFIG_HOME: join(home, "config"), XDG_CACHE_HOME: join(home, "cache"), XDG_STATE_HOME: join(home, "state"),
      OFFICE_MACHINE_RECORD: join(home, "machine.json"), OFFICE_MACHINE_DIR: join(home, "machine"), OFFICE_MISE_CONFIG_DIR: join(home, "mise"),
      OFFICE_APP_CONFIG_DIR: join(home, "app"), OFFICE_APP_PANELS_DIR: join(home, "panels"), OFFICE_SYSTEMD_USER_DIR: join(home, "units"),
      DOCKER_HOST: `unix://${home}/absent.sock`, DBUS_SESSION_BUS_ADDRESS: `unix:path=${home}/no-bus`,
      SCOPE_IMPORTS: imports,
    };

    mkdirSync(home, { recursive: true });
    mkdirSync(repo, { recursive: true });
    mkdirSync(join(dir, "sibling"), { recursive: true });
    expect(Bun.spawnSync(["git", "init", "-q", repo], { env }).exitCode).toBe(0);

    const yaml = `name: sample\nstate: ${home}/office-state\nopencode: {mode: host, url: ${endpoint}}\ndesks: {builder: {app: false}, sibling: {app: false}}\n`;
    const select = (selection: string) => write(join(dir, "office.yaml"), yaml + selection);
    select("packages: [{name: common}]\n");
    writePackage(join(dir, "packages/common/office.ts"), pluginDefinition(), { dependencies: ["opencode"] });
    write(join(dir, "packages/common/plugin/index.js"), command("shared-command"));
    write(join(dir, ".opencode/opencode.jsonc"), rootConfig);
    write(join(dir, "builder/.opencode/opencode.jsonc"), deskConfig);
    write(join(dir, "builder/extensions/local/index.js"), command("builder-command"));
    write(join(dir, "builder/.opencode/plugins/independent.js"), command("native-command"));
    write(join(repo, "opencode.json"), '{"commands":{"scope-setting":{"description":"direct-repo","template":"Repo"}}}');

    const run = async (args: string[], status = 0, executable = office) => {
      const proc = Bun.spawn([executable, ...args], { cwd: dir, env: args.includes("inspect") ? { ...env, PATH: join(home, "empty") } : env, stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);

      expect(code, stdout + stderr).toBe(status);

      return stdout + stderr;
    };

    return { home, dir, repo, imports, env, select, run };
  }

  return { sandbox, office, fixture };
}

export type ScopeFixture = ReturnType<ReturnType<typeof scopeFixture>["fixture"]>;

/** A Git remote holding `files` in one commit, selected as the plugins: entry `imported`. */
export function pluginRemote(f: ScopeFixture, files: Record<string, string>) {
  const remote = join(f.home, "remote");

  for (const [name, text] of Object.entries(files)) write(join(remote, name), text);
  gitAt(remote, f.env, "init", "-q");
  gitAt(remote, f.env, "add", ".");
  gitAt(remote, f.env, "commit", "-qm", "plugin");
  f.select(`plugins: [{name: imported, repo: ${remote}}]\n`);

  return remote;
}
