import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as v from "valibot";
import { compile } from "./build.ts";

const sandbox = mkdtempSync(join(tmpdir(), "office-opencode-scope-"));
const office = join(sandbox, "bin/office");
const launcher = process.env.OFFICE_TEST_OPENCODE;
const previous = process.env.OFFICE_TEST_PRE_INSPECT;

// Optional control: the compiled CLI from before plugin delivery refused owner folders (567252f).
const control = process.env.OFFICE_TEST_PLUGIN_CONTROL;

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

  const run = async (args: string[], status = 0, executable = office) => {
    const proc = Bun.spawn([executable, ...args], { cwd: dir, env: args.includes("inspect") ? { ...env, PATH: join(home, "empty") } : env, stdout: "pipe", stderr: "pipe" });
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
      "./packages/common/plugin", "https://hidden-user:hidden-password@hidden-host.invalid/hidden-path?hidden-query",
      "hidden-token-shaped-npm", "./hidden-opaque-component", "hidden-company@1.0.0", "hidden-company@2.0.0",
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

    expect(report).toContain("[desk builder] configured local directory: builder/.opencode/opencode.jsonc#plugins[0]");
    expect(report).toContain("[folder builder/<folder-2>/<folder-3>] native config: builder/<folder-2>/<folder-3>/opencode.json");
    expect(report).toContain("declared Git clone (no checkout observed): office.yaml plugins: imported -> .opencode/plugins/imported");
    expect(report).toContain("Office-created package link (selected built-in package): .opencode/plugins/office");
    expect(report).toContain("convention plugin candidate (dangling)");
    const duplicates = report.split("possible duplicate source (same filesystem target; activation not checked):")[1];

    expect(duplicates).toContain("configured local directory: opencode.json#plugins[0]");
    expect(duplicates).toContain("Office-created package link (selected local package): .opencode/plugins/common");
    expect(report).toContain("same package name or ID; versions not resolved");
    expect(report).toContain("bundle present; listed in app-machine opencode.json");
    expect(report).not.toContain("hidden-");
    expect(report).toContain("runtime not checked");
    expect(existsSync(f.imports)).toBe(false);
    expect(requests).toBe(0);
    expect(await f.run(["opencode", "inspect", "sibling"])).not.toContain("builder/");
    expect((await f.run(["opencode", "inspect", ".opencode"])).match(/native config: \.opencode\/opencode\.jsonc/g)).toHaveLength(1);
    const failed = await f.run(["opencode", "inspect", join(f.home, "hidden-lookup\nINJECTED")], 1);
    expect(failed).not.toMatch(/hidden-lookup|INJECTED/);
    expect(await f.run(["opencode", "inspect", "--hidden-flag\nINJECTED"], 1)).not.toMatch(/hidden-flag|INJECTED/);

    const panels = f.env.OFFICE_APP_PANELS_DIR;
    const record = join(panels, "common/office-panel.json");
    const bundle = join(panels, "common/gui-experimental.cjs");
    const backup = `${record}.original`;
    renameSync(record, backup);
    symlinkSync(backup, record);
    expect(await f.run(inspect)).not.toContain("desktop: common");
    rmSync(record);
    write(record, readFileSync(backup, "utf8").replace('"sample"', '"another-office"'));
    expect(await f.run(inspect)).not.toContain("desktop: common");
    renameSync(backup, record);
    rmSync(bundle);
    mkdirSync(bundle);
    expect(await f.run(inspect)).toContain("bundle missing or not a regular file");
    rmSync(bundle, { recursive: true });

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
    await f.run(["cron", "list"]); // A plugin destination collision is not a broken cron provider.
    rmSync(path(".opencode/plugins"), { recursive: true });
    symlinkSync(f.env.OFFICE_APP_CONFIG_DIR, path(".opencode/plugins"));
    expect(await f.run(sync, 1)).toContain("refusing to follow or replace it");
    expect(existsSync(join(f.env.OFFICE_APP_CONFIG_DIR, "common"))).toBe(false);
  } finally {
    trap.stop(true);
  }
}, 60_000);

test("a path and target are not custody: preserve ambiguous, dangling, redirected and replaced root links", async () => {
  const f = fixture("custody", "http://127.0.0.1:1");
  const folder = join(f.dir, ".opencode/plugins");
  mkdirSync(folder, { recursive: true });
  const link = join(folder, "common");
  const target = "../../packages/common/plugin";
  symlinkSync(target, link);
  symlinkSync("../../.office/packages/gone/plugin", join(folder, "gone"));
  symlinkSync(target, join(folder, "alias"));
  const sync = ["sync", "--packages"];
  const inspect = ["opencode", "inspect"];

  expect(await f.run(sync)).toContain(".opencode/plugins/common: no matching Office creation receipt");
  expect(await f.run(inspect)).toContain("package-shaped link (selected local package; no creation receipt)");
  const ledger = join(f.dir, ".office/resolved/opencode-links.sqlite");
  {
    using db = new Database(ledger);
    db.exec("PRAGMA journal_mode=WAL");
  }

  const bytes = readFileSync(ledger);
  expect(await f.run(inspect, 1)).toContain("ledger is changing or needs recovery");
  expect(readFileSync(ledger)).toEqual(bytes);

  for (const suffix of ["-wal", "-shm"]) expect(existsSync(`${ledger}${suffix}`)).toBe(false);
  await f.run(sync);
  await f.run(["cron", "list"]);
  f.select("");
  await f.run(sync);
  expect(readlinkSync(link)).toBe(target);
  expect(readlinkSync(join(folder, "gone"))).toBe("../../.office/packages/gone/plugin");
  expect(readlinkSync(join(folder, "alias"))).toBe(target);

  f.select("plugins: [{name: common, repo: /unavailable}]\n");
  expect(await f.run(["sync"], 1)).toContain("existing symlink kept");
  expect(readlinkSync(link)).toBe(target);
  renameSync(link, join(f.home, "saved-link"));
  f.select("packages: [{name: common}]\n");
  await f.run(sync);
  expect(await f.run(inspect)).toContain("Office-created package link (selected local package)");
  renameSync(link, join(f.home, "original-inode"));
  symlinkSync(target, link); // Replacement with IDENTICAL spelling.
  f.select("");
  await f.run(sync);
  expect(readlinkSync(link)).toBe(target);
  rmSync(link);
  f.select("packages: [{name: common}]\n");
  await f.run(sync);
  rmSync(link);
  symlinkSync("../../.office/packages/common/plugin", link); // Both target shapes are plausible.
  expect(await f.run(sync, 1)).toContain("no matching Office creation receipt");
  f.select("");
  await f.run(sync);
  await f.run(sync);
  expect(readlinkSync(link)).toBe("../../.office/packages/common/plugin");
}, 60_000);

function gitAt(dir: string, env: ReturnType<typeof fixture>["env"], ...args: string[]) {
  const res = Bun.spawnSync(["git", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: dir, env });
  expect(res.exitCode, res.stderr.toString()).toBe(0);

  return res.stdout.toString().trim();
}

test("a first plugin clone verifies the effective origin before fetching and before checkout", async () => {
  const f = fixture("first-origin", "http://127.0.0.1:1");
  const remote = join(f.home, "declared");
  const mirror = join(f.home, "unexpected");
  const plugin = join(f.dir, ".opencode/plugins/imported");
  const trace = join(f.home, "git.trace");
  const shim = join(f.home, "bin/git");
  const native = Bun.which("git", { PATH: f.env.PATH });

  if (!native) throw new Error("git required for plugin checkout test");

  write(join(remote, "note"), "declared\n");
  gitAt(remote, f.env, "init", "-q");
  gitAt(remote, f.env, "add", "note");
  gitAt(remote, f.env, "commit", "-qm", "declared");
  write(join(mirror, "note"), "mirror\n");
  gitAt(mirror, f.env, "init", "-q");
  gitAt(mirror, f.env, "add", "note");
  gitAt(mirror, f.env, "commit", "-qm", "mirror");
  expect(gitAt(mirror, f.env, "rev-parse", "HEAD")).not.toBe(gitAt(remote, f.env, "rev-parse", "HEAD"));
  f.select(`plugins: [{name: imported, repo: ${remote}}]\n`);

  // Record the transport boundary. Even a build missing the guard cannot import anything.
  write(shim, `#!/bin/sh\necho "$1" >> "${trace}"\ncase "$1" in fetch|checkout) exit 91;; esac\nexec "${native}" "$@"\n`);
  chmodSync(shim, 0o755);
  f.env.PATH = `${dirname(shim)}:${f.env.PATH}`;
  const rewrite = `url.${mirror}.insteadOf`;
  const policy = join(f.home, "plugin.gitconfig");
  gitAt(f.home, f.env, "config", "--file", policy, rewrite, remote);
  gitAt(f.home, f.env, "config", "--global", `includeIf.gitdir:${plugin}/.git.path`, policy);

  for (let attempt = 0; attempt < 2; attempt++) {
    write(trace, "");
    const report = await f.run(["sync"], 1);
    expect(readFileSync(trace, "utf8").split("\n")).not.toContain("fetch");
    expect(report).toContain("cannot verify plugin checkout origin");
    expect(report).not.toContain(remote);
    expect(report).not.toContain("unexpected");
    expect(existsSync(plugin)).toBe(false);
  }

  // An owner's empty folder is refused before Git runs at all, origin aside.
  mkdirSync(plugin);
  const inode = statSync(plugin).ino;
  write(trace, "");
  expect(await f.run(["sync"], 1)).toContain("Move it aside");
  expect(readFileSync(trace, "utf8")).not.toContain("fetch");
  expect(statSync(plugin).ino).toBe(inode);
  expect(readdirSync(plugin)).toEqual([]);
  rmSync(plugin, { recursive: true });

  gitAt(f.home, f.env, "config", "--file", policy, "--unset", rewrite);
  // Change the configured origin only after a successful, ordinary local fetch.
  write(shim, `#!/bin/sh\ncase " $* " in *" checkout "*) echo checkout;; *) echo "$1";; esac >> "${trace}"\n"${native}" "$@" || exit $?\nif [ "$1" = fetch ]; then "${native}" remote set-url origin ../changed; fi\n`);
  write(trace, "");
  expect(await f.run(["sync"], 1)).toContain("cannot verify plugin checkout origin");
  const commands = readFileSync(trace, "utf8").split("\n");
  expect(commands).toContain("fetch");
  expect(commands).not.toContain("checkout");
  expect(existsSync(plugin)).toBe(false);

  // A checkout can write files and still exit nonzero. Nothing partial becomes a plugin.
  write(shim, `#!/bin/sh\n"${native}" "$@" || exit $?\ncase " $* " in *" checkout "*) echo 'https://hidden-user:hidden-pass@example.invalid' >&2; exit 92;; esac\n`);
  const failed = await f.run(["sync"], 1);
  expect(failed).toContain("plugin Git operation failed");
  expect(failed).not.toContain("hidden-");
  expect(existsSync(plugin)).toBe(false);
  expect(readdirSync(f.dir).some(name => name.startsWith(".office-plugin-"))).toBe(false);

  rmSync(shim);
  await f.run(["sync"]);
  await f.run(["sync"]);
  expect(gitAt(plugin, f.env, "rev-parse", "HEAD")).toBe(gitAt(remote, f.env, "rev-parse", "HEAD"));
  expect(readFileSync(join(plugin, "note"), "utf8")).toBe("declared\n");
}, 60_000);

test("a plugin checkout with the wrong origin is not cleaned, fetched or force-checked-out", async () => {
  const f = fixture("clone-origin", "http://127.0.0.1:1");
  const remote = join(f.home, "original");
  const plugin = join(f.dir, ".opencode/plugins/imported");
  write(join(remote, "index.js"), command("original"));
  const git = (...args: string[]) => gitAt(remote, f.env, ...args);
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "original");
  f.select(`plugins: [{name: imported, repo: ${remote}}]\n`);
  await f.run(["sync"]);
  write(join(remote, "index.js"), command("changed-upstream"));
  git("commit", "-qam", "advance");
  write(join(plugin, "index.js"), "// owner edits");
  const head = gitAt(plugin, f.env, "rev-parse", "HEAD");
  const fetched = readFileSync(join(plugin, ".git/FETCH_HEAD"));
  f.select(`plugins: [{name: imported, repo: ${f.home}/different}]\n`);
  expect(await f.run(["sync"], 1)).toContain("cannot verify plugin checkout origin");
  expect(gitAt(plugin, f.env, "rev-parse", "HEAD")).toBe(head);
  expect(readFileSync(join(plugin, "index.js"), "utf8")).toBe("// owner edits");
  f.select(`plugins: [{name: imported, repo: ${remote}}]\n`);
  gitAt(plugin, f.env, "config", `url.${f.home}/different.insteadOf`, remote);
  expect(await f.run(["sync"], 1)).toContain("cannot verify plugin checkout origin");
  expect(readFileSync(join(plugin, "index.js"), "utf8")).toBe("// owner edits");
  expect(readFileSync(join(plugin, ".git/FETCH_HEAD"))).toEqual(fetched);
  expect(gitAt(plugin, f.env, "rev-parse", "HEAD")).toBe(head);
  gitAt(plugin, f.env, "config", "--unset", `url.${f.home}/different.insteadOf`);
  // A real fetch can wait. Change only the fixture's origin after fetching, before --force.
  const gitPath = Bun.which("git", { PATH: f.env.PATH });

  if (!gitPath) throw new Error("git required for plugin checkout test");
  const shim = join(f.home, "bin/git");
  write(shim, `#!/bin/sh\n"${gitPath}" "$@" || exit $?\nif [ "$1" = fetch ]; then "${gitPath}" remote set-url origin ../different; fi\n`);
  chmodSync(shim, 0o755);
  const originalPath = f.env.PATH;
  f.env.PATH = `${dirname(shim)}:${originalPath}`;
  expect(await f.run(["sync"], 1)).toContain("cannot verify plugin checkout origin");
  f.env.PATH = originalPath;
  expect(gitAt(plugin, f.env, "rev-parse", "HEAD")).toBe(head);
  expect(readFileSync(join(plugin, "index.js"), "utf8")).toBe("// owner edits");
  gitAt(plugin, f.env, "remote", "set-url", "origin", remote);
  await f.run(["sync"]);
  expect(gitAt(plugin, f.env, "rev-parse", "HEAD")).toBe(git("rev-parse", "HEAD"));
  rmSync(plugin, { recursive: true });
  gitAt(f.dir, f.env, "init", "-q", plugin);
  gitAt(plugin, f.env, "remote", "add", "origin", `${f.home}/different`);
  const config = readFileSync(join(plugin, ".git/config"));
  expect(await f.run(["sync"], 1)).toContain("cannot verify plugin checkout origin");
  expect(readFileSync(join(plugin, ".git/config"))).toEqual(config);
  gitAt(plugin, f.env, "remote", "set-url", "origin", remote);
  write(join(plugin, ".git/owner-note"), "keep\n");
  // The right origin does not make a checkout with no commit Office's to fill in.
  expect(await f.run(["sync"], 1)).toContain("has no commit");
  expect(readFileSync(join(plugin, ".git/owner-note"), "utf8")).toBe("keep\n");
  expect(existsSync(join(plugin, ".git/FETCH_HEAD"))).toBe(false);
}, 60_000);

/** Every entry under `dir` with its mode and contents, and the folder's own inode and mode. */
function snapshot(dir: string) {
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

function pluginRemote(f: ReturnType<typeof fixture>, files: Record<string, string>) {
  const remote = join(f.home, "remote");

  for (const [name, text] of Object.entries(files)) write(join(remote, name), text);
  gitAt(remote, f.env, "init", "-q");
  gitAt(remote, f.env, "add", ".");
  gitAt(remote, f.env, "commit", "-qm", "plugin");
  f.select(`plugins: [{name: imported, repo: ${remote}}]\n`);

  return remote;
}

test("a plugin checkout with no commit is refused before fetching, even with the declared origin, and exposes nothing", async () => {
  for (const executable of [office, ...(control ? [control] : [])]) {
    const f = fixture(executable === office ? "unborn" : "unborn-control", "http://127.0.0.1:1");
    const plugin = join(f.dir, ".opencode/plugins/imported");
    // A required smudge filter fails on the last file, after index.js is written.
    const remote = pluginRemote(f, { ".gitattributes": "zz-last filter=fail\n", "index.js": command("exposed"), "zz-last": "last\n" });
    gitAt(f.dir, f.env, "init", "-q", plugin);
    gitAt(plugin, f.env, "remote", "add", "origin", remote);
    gitAt(plugin, f.env, "config", "filter.fail.smudge", "false");
    gitAt(plugin, f.env, "config", "filter.fail.required", "true");
    const before = snapshot(plugin);
    const report = await f.run(["sync"], 1, executable);

    if (executable !== office) {
      // The control: refresh checks out into the folder OpenCode discovers.
      expect(existsSync(join(plugin, "index.js"))).toBe(true);
      expect(existsSync(join(plugin, "zz-last"))).toBe(false);
      continue;
    }

    expect(report).toContain("existing plugin checkout has no commit; left unchanged. Move it aside");
    expect(report).not.toContain(remote);
    expect(snapshot(plugin)).toEqual(before);
    expect(existsSync(join(plugin, "index.js"))).toBe(false);
    expect(existsSync(join(plugin, ".git/FETCH_HEAD"))).toBe(false);
  }
}, 60_000);

test("first plugin delivery never replaces an owner's folder, even an empty one or one that appears mid-delivery", async () => {
  const f = fixture("owner-folder", "http://127.0.0.1:1");
  const plugin = join(f.dir, ".opencode/plugins/imported");
  const remote = pluginRemote(f, { "index.js": command("delivered") });
  const native = Bun.which("git", { PATH: f.env.PATH });

  if (!native) throw new Error("git required for plugin checkout test");
  mkdirSync(plugin, { recursive: true });
  chmodSync(plugin, 0o750);
  const owner = snapshot(plugin);
  expect(await f.run(["sync"], 1)).toContain("existing folder at the plugin destination kept; office sync clones only into a path that does not exist. Move it aside");
  expect(snapshot(plugin)).toEqual(owner);

  if (control) {
    // The control publishes over the empty folder: another inode, staging's 0700 mode.
    await f.run(["sync"], 0, control);
    expect(statSync(plugin).ino).not.toBe(owner.ino);
    expect(statSync(plugin).mode & 0o777).toBe(0o700);
  }

  rmSync(plugin, { recursive: true });
  // An owner folder replaces the claim while Git fetches. It stays, with its inode and mode.
  const shim = join(f.home, "bin/git");
  const aside = join(f.home, "aside");
  const substitute = join(f.home, "substitute");
  write(shim, `#!/bin/sh\n"${native}" "$@" || exit $?\nif [ "$1" = fetch ]; then mv "${plugin}" "${aside}"; mkdir -m 750 "${plugin}"; stat -c %i "${plugin}" > "${substitute}"; fi\n`);
  chmodSync(shim, 0o755);
  const originalPath = f.env.PATH;
  f.env.PATH = `${dirname(shim)}:${originalPath}`;
  expect(await f.run(["sync"], 1)).toContain("cannot verify plugin checkout origin");
  expect(statSync(plugin).ino).toBe(Number(readFileSync(substitute, "utf8")));
  expect(statSync(plugin).mode & 0o777).toBe(0o750);
  expect(readdirSync(plugin)).toEqual([]);
  rmSync(plugin, { recursive: true });
  rmSync(aside, { recursive: true });

  // A file an owner puts inside the claim survives, and nothing is published around it.
  write(shim, `#!/bin/sh\n"${native}" "$@" || exit $?\nif [ "$1" = fetch ]; then echo owner > "${plugin}/owner.txt"; fi\n`);
  expect(await f.run(["sync"], 1)).toContain("plugin destination changed during delivery; kept what appeared there and published nothing");
  expect(readdirSync(plugin)).toEqual(["owner.txt"]);
  expect(readFileSync(join(plugin, "owner.txt"), "utf8")).toBe("owner\n");
  rmSync(plugin, { recursive: true });

  f.env.PATH = originalPath;
  await f.run(["sync"]);
  await f.run(["sync"]);
  expect(gitAt(plugin, f.env, "rev-parse", "HEAD")).toBe(gitAt(remote, f.env, "rev-parse", "HEAD"));
  expect(readFileSync(join(plugin, "index.js"), "utf8")).toBe(command("delivered"));
  expect(readdirSync(f.dir).some(name => name.startsWith(".office-plugin-"))).toBe(false);
}, 60_000);

// A real previous release is the control: no synthetic generation and no rewriting a digest.
test.skipIf(!previous)("upgrade refuses previously indexed inspect names, aliases and descendants while preserving unrelated routes and pinned repair", async () => {
  if (!previous) throw new Error("set OFFICE_TEST_PRE_INSPECT to the compiled pre-inspect Office CLI");

  for (const [kind, name, alias] of [["name", "opencode inspect", "folio"], ["alias", "folio", "opencode inspect"], ["descendant", "opencode inspect drawer show", "folio"]]) {
    const f = fixture(`upgrade-${kind}`, "http://127.0.0.1:1");
    const remote = join(f.home, "press-remote");
    const author = join(f.dir, "packages/author/office.ts");
    const snapshot = join(f.dir, ".office/resolved/references.json");
    const pinned = join(f.dir, ".office/packages/press/plugin/index.js");
    const commandModule = (route: string, alternate: string) => `import {writeFileSync} from "node:fs"; writeFileSync(process.env.SCOPE_IMPORTS,"imported"); export default { name:"author",description:"fixture",setup(ctx){ctx.command({name:${JSON.stringify(route)},aliases:[${JSON.stringify(alternate)}],summary:"fixture",run(){console.log("previous author command")}})}}`;
    const git = (...args: string[]) => gitAt(remote, f.env, ...args);
    write(author, commandModule(name, alias));
    write(join(remote, "pkg/office.ts"), 'export default {name:"press",description:"fixture",setup(ctx){ctx.add({registry:"references.repository",value:{name:"bound-reference",url:"local"}});ctx.command({name:"edition",summary:"fixture",run(){console.log("edition")}})}}');
    write(join(remote, "pkg/plugin/index.js"), command("edition-a"));
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "first");
    git("tag", "stable");
    const selection = `packages:\n  - {name: press, repo: ${remote}, path: pkg, ref: stable}\n`;
    f.select(`${selection}  - name: author\n`);
    await f.run(["sync", "--packages"], 0, previous);
    const oldRoute = kind === "alias" ? alias : name;
    expect(await f.run(oldRoute.split(" "), 0, previous)).toContain("previous author command");
    rmSync(f.imports);
    const original = readFileSync(snapshot, "utf8");
    expect(await f.run(oldRoute.split(" "), 1)).toContain("previously indexed package command or alias");
    expect(await f.run(["--help"])).toContain("indexed route of package author");
    expect(await f.run(["references", "list"])).toContain("bound-reference");
    expect(existsSync(f.imports)).toBe(false);
    write(join(remote, "pkg/plugin/index.js"), command("edition-b"));
    git("commit", "-qam", "moved tag");
    git("tag", "-f", "stable");
    rmSync(dirname(dirname(pinned)), { recursive: true });
    expect(await f.run(["sync", "--packages"], 1)).toContain("is reserved");
    expect(readFileSync(snapshot, "utf8")).toBe(original);
    expect(readFileSync(pinned, "utf8")).toBe(command("edition-a"));
    expect(await f.run(["references", "list"])).toContain("bound-reference");

    if (kind === "alias") f.select(selection);
    else write(author, commandModule("folio read", "folio"));
    await f.run(["sync", "--packages"]);
    const report = await f.run(["opencode", "inspect"]);
    expect(report).toContain("selected pinned Git package");
    expect(report).not.toContain(remote);
    expect(report).not.toContain("stable");
    expect(report).toContain("no creation receipt");
    f.select("");
    await f.run(["sync", "--packages"]);
    expect(readlinkSync(join(f.dir, ".opencode/plugins/press"))).toBe("../../.office/packages/press/plugin");
    await f.run(["references", "list"]);
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
