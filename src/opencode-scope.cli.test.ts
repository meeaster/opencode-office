import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as v from "valibot";
import { compile } from "./build.ts";
import { excludeEnd, excludeStart } from "./commands/sync.ts";

const sandbox = mkdtempSync(join(tmpdir(), "office-opencode-scope-"));
const office = join(sandbox, "bin/office");
const launcher = process.env.OFFICE_TEST_OPENCODE;
const groundwork = process.env.OFFICE_TEST_PRE_ASSETS;
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
    expect(report).toContain("declared Git clone (no checkout observed; not linked as .opencode/plugins/imported): office.yaml plugins: imported -> .office/plugins/imported");
    expect(report).toContain("Office package link (selected built-in package): .opencode/plugins/office");
    expect(report).toContain("convention plugin candidate (dangling)");
    const duplicates = report.split("possible duplicate source (same filesystem target; activation not checked):")[1];

    expect(duplicates).toContain("configured local directory: opencode.json#plugins[0]");
    expect(duplicates).toContain("Office package link (selected local package): .opencode/plugins/common");
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

test("ownership by target: Office's links are recognized and withdrawn by their text; the owner's entries and name clashes are left alone, at the root and in desks", async () => {
  const f = fixture("ownership", "http://127.0.0.1:1");
  const path = (file: string) => join(f.dir, file);
  const plugins = path(".opencode/plugins");
  const skills = path(".opencode/skills");
  const deskSkills = path("builder/.opencode/skills");
  write(path("skills/alpha/SKILL.md"), "---\nname: alpha\ndescription: fixture\n---\n");
  write(path("skills/beta/SKILL.md"), "---\nname: beta\ndescription: fixture\n---\n");

  const select = (packages: string, root: string, desk: string) => write(path("office.yaml"), [
    "name: sample", `state: ${f.home}/office-state`, "opencode: {mode: host, url: http://127.0.0.1:1}",
    `desks: {builder: {app: false, skills: [${desk}]}, sibling: {app: false}}`, `skills: {enabled: [${root}]}`, `packages: [${packages}]`, "",
  ].join("\n"));

  // The owner's entries: a real plugin folder, a link elsewhere, a file, a real skill folder and
  // a link to a library skill under another name, which Office never writes.
  write(path(".opencode/plugins/owner-plugin/index.js"), command("owner-plugin"));
  symlinkSync("../../builder/extensions/local", join(plugins, "owner-link"));
  write(join(plugins, "notes.txt"), "owner\n");
  write(join(skills, "owner-skill/SKILL.md"), "---\nname: owner-skill\ndescription: fixture\n---\n");
  symlinkSync("../../skills/alpha", join(skills, "alias"));
  // Office's by their text alone, though nothing recorded making them: dangling and hand-made.
  symlinkSync("../../.office/packages/gone/plugin", join(plugins, "gone"));
  symlinkSync("../../.office/plugins/old-clone", join(plugins, "old-clone"));
  symlinkSync("../../packages/retired/skills/beta", join(skills, "beta"));
  symlinkSync("../../packages/common/plugin", join(plugins, "common"));
  mkdirSync(deskSkills, { recursive: true });
  symlinkSync("../../../skills/alpha", join(deskSkills, "alpha"));
  symlinkSync("../../skills/alpha", join(deskSkills, "wrong-depth"));
  const owner = () => [readlinkSync(join(plugins, "owner-link")), readFileSync(join(plugins, "notes.txt"), "utf8"), readlinkSync(join(skills, "alias")), readlinkSync(join(deskSkills, "wrong-depth")), existsSync(path(".opencode/plugins/owner-plugin/index.js")), existsSync(join(skills, "owner-skill/SKILL.md"))];
  const kept = owner();
  write(path(".office/resolved/opencode-links.sqlite"), "receipts of an earlier development build");

  select("{name: common}", "alpha, beta", "beta");
  const first = await f.run(["sync"]);
  expect(first).toContain("removed .office/resolved/opencode-links.sqlite, the link receipts of earlier development builds");
  expect(first).toContain("unlinked .opencode/plugins/gone");
  expect(first).toContain("unlinked .opencode/plugins/old-clone");
  expect(first).toContain("unlinked builder/.opencode/skills/alpha");
  expect(first).not.toContain("linked .opencode/plugins/common");
  expect(readlinkSync(join(plugins, "common"))).toBe("../../packages/common/plugin");
  expect(readlinkSync(join(skills, "alpha"))).toBe("../../skills/alpha");
  // A legacy package skill link is Office's, so the library skill of that name replaces it.
  expect(readlinkSync(join(skills, "beta"))).toBe("../../skills/beta");
  expect(readlinkSync(join(deskSkills, "beta"))).toBe("../../../skills/beta");
  expect(existsSync(join(plugins, "gone")) || existsSync(join(plugins, "old-clone")) || existsSync(join(deskSkills, "alpha"))).toBe(false);
  expect(owner()).toEqual(kept);
  expect(await f.run(["sync"])).not.toMatch(/linked|unlinked/);

  // A name clash with an owner entry is refused and reported; the owner's entry stays.
  rmSync(join(plugins, "common"));
  write(join(plugins, "common/index.js"), "// the owner's own common\n");
  expect(await f.run(["sync"], 1)).toContain("which holds a plugin of this office's own (not a link office sync made), so it isn't linked; rename one of them");
  expect(readFileSync(join(plugins, "common/index.js"), "utf8")).toBe("// the owner's own common\n");
  rmSync(join(plugins, "common"), { recursive: true });
  symlinkSync("../../builder/extensions/local", join(plugins, "common"));
  expect(await f.run(["sync"], 1)).toContain("not a link office sync made");
  expect(readlinkSync(join(plugins, "common"))).toBe("../../builder/extensions/local");
  rmSync(join(plugins, "common"));
  select("{name: common}", "alpha, owner-skill", "beta");
  expect(await f.run(["sync"])).toContain("kept the office's own .opencode/skills/owner-skill instead of linking");
  expect(existsSync(join(skills, "beta"))).toBe(false);

  // Deselecting withdraws Office's links, the identical hand-made ones too; nothing of the owner's.
  rmSync(join(plugins, "common"));
  symlinkSync("../../packages/common/plugin", join(plugins, "common"));
  select("", "", "");
  const withdrawn = await f.run(["sync"]);
  expect(withdrawn).toContain("unlinked .opencode/plugins/common");
  expect(withdrawn).toContain("unlinked .opencode/skills/alpha");
  expect(withdrawn).toContain("unlinked builder/.opencode/skills/beta");
  expect(readdirSync(plugins).sort()).toEqual(["notes.txt", "office", "owner-link", "owner-plugin"]);
  expect(readdirSync(skills).sort()).toEqual(["alias", "owner-skill"]);
  expect(readdirSync(deskSkills)).toEqual(["wrong-depth"]);
  expect(owner()).toEqual(kept);
  expect(readFileSync(path("builder/.opencode/plugins/independent.js"), "utf8")).toBe(command("native-command"));
  expect(existsSync(path(".office/resolved/opencode-links.sqlite"))).toBe(false);

  // A redirected folder is never followed, for skills as for plugins.
  rmSync(deskSkills, { recursive: true });
  symlinkSync(f.home, deskSkills);
  select("", "", "alpha");
  expect(await f.run(["sync"], 1)).toContain("refusing to follow or replace it");
  expect(existsSync(join(f.home, "alpha"))).toBe(false);
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
  const plugin = join(f.dir, ".office/plugins/imported");
  const link = join(f.dir, ".opencode/plugins/imported");
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
  expect(readdirSync(join(f.dir, ".office/tmp"))).toEqual([]);
  expect(existsSync(link)).toBe(false);

  rmSync(shim);
  await f.run(["sync"]);
  await f.run(["sync"]);
  expect(gitAt(plugin, f.env, "rev-parse", "HEAD")).toBe(gitAt(remote, f.env, "rev-parse", "HEAD"));
  expect(readFileSync(join(plugin, "note"), "utf8")).toBe("declared\n");
  expect(readlinkSync(link)).toBe("../../.office/plugins/imported");
}, 60_000);

test("typed registrations replace both conventions: one owned link, isolated panel registration, explicit empty and failed collections", async () => {
  const f = fixture("authored", "http://127.0.0.1:1");
  const pkg = join(f.dir, "packages/common");
  const link = join(f.dir, ".opencode/plugins/common");
  const panel = join(f.env.OFFICE_APP_PANELS_DIR, "common/gui-experimental.cjs");
  const appConfig = join(f.env.OFFICE_APP_CONFIG_DIR, "opencode.json");
  write(appConfig, '{"plugins":["independent-owner-panel"]}');
  write(join(pkg, "extensions/server/index.js"), command("custom-command"));
  write(join(pkg, "desktop/built.cjs"), "// custom panel");
  write(join(pkg, "gui/dist/gui-experimental.cjs"), "// convention must not win");
  rmSync(join(pkg, "package.yaml"));
  write(join(pkg, "office.ts"), `import type {OpenCodeContext} from "../../.office/packages/office/package-context.ts";
    import {appendFileSync} from "node:fs";
    export default {name:"common",description:"fixture",settings:{edition:{description:"edition",default:"both"}},
      setup(ctx) { appendFileSync(process.env.SCOPE_IMPORTS,"setup\\n"); ctx.command({name:"folio edition",summary:"fixture",run(){console.log("fiction")}}); },
      opencode(ctx:OpenCodeContext) {
        appendFileSync(process.env.SCOPE_IMPORTS, "collected\\n");
        if(ctx.settings.edition === "none") return;
        ctx.serverPlugin("extensions/server");
        if(ctx.settings.edition === "duplicate") ctx.serverPlugin("plugin");
        if(ctx.settings.edition === "throw") throw Error("fixture failure after first claim");
        if(ctx.settings.edition === "escape") ctx.desktopPanel("../outside.cjs");
        else if(ctx.settings.edition === "linked") ctx.desktopPanel("redirect/built.cjs");
        else if(ctx.settings.edition === "both") ctx.desktopPanel("desktop/built.cjs");
      }};`);
  write(join(f.home, "foreign/built.cjs"), "// foreign bytes");
  symlinkSync(join(f.home, "foreign"), join(pkg, "redirect"));
  const sync = ["sync", "--packages"];
  const change = (edition: string) => f.select(`packages: [{name: common, settings: {edition: ${edition}}}]\n`);
  await f.run(sync);
  expect(readlinkSync(link)).toBe("../../packages/common/extensions/server");
  expect(readFileSync(panel, "utf8")).toBe("// custom panel");
  const registration = readFileSync(appConfig, "utf8");
  expect(JSON.parse(registration).plugins).toHaveLength(2);
  await f.run(sync);
  expect(readFileSync(appConfig, "utf8")).toBe(registration);
  const collections = readFileSync(f.imports, "utf8");
  expect(collections).toBe("setup\ncollected\nsetup\ncollected\n");
  expect(await f.run(["opencode", "inspect"])).toContain("last synced registration: server declared, desktop declared");
  await f.run(["cron", "list"]);
  // A minimal fixture intentionally fails full office health; inventory must still not re-collect.
  await f.run(["check"], 1);
  await f.run(["references", "list"]);
  expect(readFileSync(f.imports, "utf8")).toBe(collections);
  expect(await f.run(["folio", "edition"])).toContain("fiction");
  expect(readFileSync(f.imports, "utf8")).toBe(`${collections}setup\n`);

  if (groundwork) {
    // Custom receipts do not change the schema/data in the older reader's links table.
    await f.run(["opencode", "inspect"], 0, groundwork);
    expect(await f.run(sync, 1, groundwork)).toContain("opencode");
    expect(readlinkSync(link)).toBe("../../packages/common/extensions/server");
    expect(readFileSync(panel, "utf8")).toBe("// custom panel");
  }

  for (const mode of ["throw", "duplicate", "escape", "linked"]) {
    change(mode);
    expect(await f.run(sync, 1)).toContain("OpenCode registration");
    expect(await f.run(["opencode", "inspect"])).toContain("registration unavailable at last sync");
    expect(readlinkSync(link)).toBe("../../packages/common/extensions/server");
    expect(readFileSync(panel, "utf8")).toBe("// custom panel");
  }

  write(panel, "// a later office's copy");
  change("server");
  await f.run(sync);
  expect(readFileSync(panel, "utf8")).toBe("// a later office's copy");
  change("none");
  await f.run(sync);
  expect(existsSync(link)).toBe(false);
  expect(readFileSync(appConfig, "utf8")).toBe(registration);
  expect(readFileSync(panel, "utf8")).toBe("// a later office's copy");
  expect(await f.run(["opencode", "inspect"])).toContain("server withheld, desktop withheld");
  expect(await f.run(["gui", "dev", "common"], 1)).toContain("no matching synced desktop registration");
  expect(existsSync(join(f.dir, "builder/.opencode/plugins/independent.js"))).toBe(true);
  change("both");
  await f.run(sync);
  const dev = Bun.spawn([office, "gui", "dev", "common"], { cwd: f.dir, env: f.env, stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => dev.kill("SIGKILL"), 10_000);

  try {
    let watching = "";
    const reader = dev.stdout.getReader();

    while (!watching.includes("watching packages/common/desktop/built.cjs")) {
      const next = await reader.read();

      if (next.done) throw new Error("gui dev did not watch the claimed bundle");
      watching += new TextDecoder().decode(next.value);
    }

    write(join(pkg, "desktop/built.cjs"), "// watched build");

    for (let i = 0; i < 80 && readFileSync(panel, "utf8") !== "// watched build"; i++) await Bun.sleep(50);
    expect(readFileSync(panel, "utf8")).toBe("// watched build");
    change("server");
    await f.run(sync);
    write(join(pkg, "desktop/built.cjs"), "// no longer declared");
    expect(await dev.exited).toBe(1);
    expect(readFileSync(panel, "utf8")).toBe("// watched build");
  } finally {
    clearTimeout(timeout);
    dev.kill();
    await dev.exited;
  }

  // A hand-made link with Office's text for the authored path is Office's: kept while declared,
  // withdrawn when the registration withholds the server. An owner link elsewhere stays.
  rmSync(link);
  symlinkSync("../../packages/common/extensions/server", link);
  expect(await f.run(sync)).not.toContain("linked .opencode/plugins/common");
  change("none");
  expect(await f.run(sync)).toContain("unlinked .opencode/plugins/common");
  symlinkSync("../../builder/extensions/local", link);
  await f.run(sync);
  expect(readlinkSync(link)).toBe("../../builder/extensions/local");
}, 60_000);

test("a convention package with a symlinked gui/dist keeps its link and panel; an authored claim through that symlink is refused", async () => {
  const deliver = async (name: string, executable: string) => {
    const f = fixture(name, "http://127.0.0.1:1");
    const pkg = join(f.dir, "packages/common");
    write(join(f.dir, "builds/common/gui-experimental.cjs"), "// built elsewhere in the office");
    mkdirSync(join(pkg, "gui"));
    symlinkSync("../../../builds/common", join(pkg, "gui/dist"));
    const output = await f.run(["sync", "--packages"], 0, executable);
    const link = readlinkSync(join(f.dir, ".opencode/plugins/common"));
    const panel = readFileSync(join(f.env.OFFICE_APP_PANELS_DIR, "common/gui-experimental.cjs"), "utf8");

    return { f, pkg, output, link, panel, plugins: JSON.parse(readFileSync(join(f.env.OFFICE_APP_CONFIG_DIR, "opencode.json"), "utf8")).plugins };
  };

  const { f, pkg, output, link, panel, plugins } = await deliver("convention-link", office);
  expect(output).not.toContain("FAILED");
  expect(link).toBe("../../packages/common/plugin");
  expect(panel).toBe("// built elsewhere in the office");
  expect(plugins).toHaveLength(1);

  if (groundwork) {
    // The release before authored registration delivered the same link and panel.
    const old = await deliver("convention-link-old", groundwork);
    expect([old.link, old.panel, old.plugins.length]).toEqual([link, panel, plugins.length]);
  }

  rmSync(join(pkg, "package.yaml"));
  write(join(pkg, "office.ts"), `export default {name:"common",description:"fixture",opencode(ctx){ctx.serverPlugin("plugin"); ctx.desktopPanel("gui/dist/gui-experimental.cjs")}};`);
  expect(await f.run(["sync", "--packages"], 1)).toContain("without redirected paths");
  expect(readlinkSync(join(f.dir, ".opencode/plugins/common"))).toBe(link);
  expect(readFileSync(join(f.env.OFFICE_APP_PANELS_DIR, "common/gui-experimental.cjs"), "utf8")).toBe(panel);
}, 60_000);

test("check and inspect report authored registrations as declared: no deletion advice while unread, skills and retained panels by claim", async () => {
  const f = fixture("authored-health", "http://127.0.0.1:1");
  const pkg = join(f.dir, "packages/common");
  const skillNote = "skills helper don't load";
  const removal = "none of its packages has that panel now";
  write(join(pkg, "skills/helper/SKILL.md"), "---\nname: helper\ndescription: fixture\n---\nHelper.\n");
  write(join(pkg, "desktop/built.cjs"), "// authored panel");
  rmSync(join(pkg, "package.yaml"));
  write(join(pkg, "office.ts"), `export default {name:"common",description:"fixture",settings:{edition:{description:"edition",default:"both"}},
    opencode(ctx) {
      if (ctx.settings.edition === "throw") throw Error("fixture failure");
      if (ctx.settings.edition !== "panel") ctx.serverPlugin("plugin");
      if (ctx.settings.edition !== "server") ctx.desktopPanel("desktop/built.cjs");
    }};`);
  const change = (edition: string) => f.select(`packages: [{name: common, settings: {edition: ${edition}}}]\n`);
  await f.run(["sync", "--packages"]);
  let check = await f.run(["check"], 1);
  expect(check).not.toContain(skillNote);
  expect(check).not.toContain(removal);

  // Still selected, but the last collection failed: the panel is not this office's to delete.
  change("throw");
  await f.run(["sync", "--packages"], 1);
  check = await f.run(["check"], 1);
  expect(check).not.toContain(removal);
  expect(check).not.toContain(skillNote);
  // Settings changed since the last sync: the recorded registration is stale.
  change("server");
  check = await f.run(["check"], 1);
  expect(check).not.toContain(removal);

  await f.run(["sync", "--packages"]);
  const inspect = await f.run(["opencode", "inspect"]);
  expect(inspect).toContain("desktop: retained panel, not declared by its package (");
  expect(inspect).not.toContain("desktop: common (");

  change("panel");
  await f.run(["sync", "--packages"]);
  expect(await f.run(["check"], 1)).toContain(skillNote);
  expect(await f.run(["opencode", "inspect"])).toContain("desktop: common (");
}, 60_000);

test("an authored-only pinned package repairs the bound revision and rejects an invalid staged replacement", async () => {
  const f = fixture("authored-pin", "http://127.0.0.1:1");
  const upstream = join(f.home, "upstream");
  const pkg = join(upstream, "pkg");
  const pulled = join(f.dir, ".office/packages/folio");
  const git = (...args: string[]) => gitAt(upstream, f.env, ...args);
  const select = (ref: string) => f.select(`packages: [{name: folio, repo: ${upstream}, path: pkg, ref: '${ref}'}]\n`);
  const definition = `export default {name:"folio", description:"fixture", opencode(ctx){ctx.serverPlugin("src/server"); ctx.desktopPanel("dist/panel.cjs")}};`;
  write(join(pkg, "office.ts"), definition);
  write(join(pkg, "src/server/index.js"), command("bound-asset"));
  write(join(pkg, "dist/panel.cjs"), "// edition A");
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "edition A");
  git("tag", "stable");
  select("stable");
  await f.run(["sync", "--packages"]);
  const link = join(f.dir, ".opencode/plugins/folio");
  expect(readlinkSync(link)).toBe("../../.office/packages/folio/src/server");
  expect(await f.run(["opencode", "inspect"])).toContain("Office package link (selected pinned Git package)");
  write(join(pkg, "office.ts"), definition.replace("dist/panel.cjs", "missing.cjs"));
  git("commit", "-qam", "invalid edition B");
  git("tag", "-f", "stable");
  rmSync(pulled, { recursive: true });
  await f.run(["sync", "--packages"]);
  expect(readFileSync(join(pulled, "office.ts"), "utf8")).toBe(definition);
  select(git("rev-parse", "HEAD"));
  expect(await f.run(["sync", "--packages"], 1)).toContain("existing regular file");
  expect(readFileSync(join(pulled, "office.ts"), "utf8")).toBe(definition);
  expect(readlinkSync(link)).toBe("../../.office/packages/folio/src/server");
  expect(readFileSync(join(f.env.OFFICE_APP_PANELS_DIR, "folio/gui-experimental.cjs"), "utf8")).toBe("// edition A");
}, 60_000);

test("deselecting a pulled authored package notes its retained panel at the authored bundle path", async () => {
  const f = fixture("authored-deselect", "http://127.0.0.1:1");
  const upstream = join(f.home, "upstream");
  const git = (...args: string[]) => gitAt(upstream, f.env, ...args);
  write(join(upstream, "pkg/office.ts"), `export default {name:"folio", description:"fixture", opencode(ctx){ctx.desktopPanel("dist/panel.cjs")}};`);
  write(join(upstream, "pkg/dist/panel.cjs"), "// authored only");
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "panel");
  f.select(`packages: [{name: folio, repo: ${upstream}, path: pkg, ref: '${git("rev-parse", "HEAD")}'}]\n`);
  await f.run(["sync", "--packages"]);
  expect(readFileSync(join(f.env.OFFICE_APP_PANELS_DIR, "folio/gui-experimental.cjs"), "utf8")).toBe("// authored only");
  f.select("packages: []\n");
  expect(await f.run(["sync", "--packages"])).toContain("panel office-folio stays installed");
}, 60_000);

test("a plugin checkout with the wrong origin is not cleaned, fetched or force-checked-out", async () => {
  const f = fixture("clone-origin", "http://127.0.0.1:1");
  const remote = join(f.home, "original");
  const plugin = join(f.dir, ".office/plugins/imported");
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
    // The control clones into .opencode/plugins/, where earlier releases did.
    const plugin = join(f.dir, executable === office ? ".office/plugins/imported" : ".opencode/plugins/imported");
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
    expect(existsSync(join(f.dir, ".opencode/plugins/imported"))).toBe(false);

    // Where an earlier release cloned, a checkout with no commit is not provably Office's: it stays.
    const legacy = join(f.dir, ".opencode/plugins/imported");
    renameSync(plugin, legacy);
    const kept = snapshot(legacy);
    expect(await f.run(["sync"], 1)).toContain(".opencode/plugins/imported is a folder office sync can't verify as this plugin's checkout");
    expect(snapshot(legacy)).toEqual(kept);
    expect(existsSync(plugin)).toBe(false);
  }
}, 60_000);

test("first plugin delivery never replaces an owner's folder, even an empty one or one that appears mid-delivery", async () => {
  const f = fixture("owner-folder", "http://127.0.0.1:1");
  const plugin = join(f.dir, ".office/plugins/imported");
  const legacy = join(f.dir, ".opencode/plugins/imported");
  const remote = pluginRemote(f, { "index.js": command("delivered") });
  const native = Bun.which("git", { PATH: f.env.PATH });

  if (!native) throw new Error("git required for plugin checkout test");
  mkdirSync(plugin, { recursive: true });
  chmodSync(plugin, 0o750);
  const owner = snapshot(plugin);
  expect(await f.run(["sync"], 1)).toContain("existing folder at the plugin destination kept; office sync clones only into a path that does not exist. Move it aside");
  expect(snapshot(plugin)).toEqual(owner);

  if (control) {
    // The control publishes over the empty folder where it clones: another inode, staging's 0700 mode.
    mkdirSync(legacy);
    const before = statSync(legacy).ino;
    await f.run(["sync"], 0, control);
    expect(statSync(legacy).ino).not.toBe(before);
    expect(statSync(legacy).mode & 0o777).toBe(0o700);
    rmSync(legacy, { recursive: true });
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
  expect(readdirSync(join(f.dir, ".office/tmp"))).toEqual([]);
  expect(readlinkSync(legacy)).toBe("../../.office/plugins/imported");
}, 60_000);

test("a Git-cloned plugin lives in .office/plugins, is linked after publication, updates in place and moves there from where earlier releases cloned it", async () => {
  const f = fixture("clone-link", "http://127.0.0.1:1");
  const remote = pluginRemote(f, { "index.js": command("cloned-v1") });
  const checkout = join(f.dir, ".office/plugins/imported");
  const link = join(f.dir, ".opencode/plugins/imported");
  // OpenCode doesn't notice a checkout appearing behind an existing link, so one made first is made again.
  mkdirSync(dirname(link), { recursive: true });
  symlinkSync("../../.office/plugins/imported", link);
  const dangling = lstatSync(link).ino;
  const first = await f.run(["sync"]);
  expect(first).toContain(".office/plugins/imported: cloned");
  expect(first).toContain("relinked .opencode/plugins/imported");
  expect(lstatSync(link).ino).not.toBe(dangling);
  expect(readlinkSync(link)).toBe("../../.office/plugins/imported");
  expect(readFileSync(join(link, "index.js"), "utf8")).toBe(command("cloned-v1"));
  const identity = [statSync(checkout).ino, lstatSync(link).ino];
  expect(await f.run(["sync"])).not.toMatch(/: cloned|: updated|linked \./);

  write(join(remote, "index.js"), command("cloned-v2"));
  gitAt(remote, f.env, "commit", "-qam", "v2");
  expect(await f.run(["sync"])).toContain(".office/plugins/imported: updated");
  expect(readFileSync(join(link, "index.js"), "utf8")).toBe(command("cloned-v2"));
  expect([statSync(checkout).ino, lstatSync(link).ino]).toEqual(identity);

  rmSync(link);
  expect(await f.run(["check"], 1)).toContain("plugin imported is cloned but .opencode/plugins/imported doesn't link to it (office sync links it)");
  expect(await f.run(["sync"])).toContain("linked .opencode/plugins/imported");
  expect(statSync(checkout).ino).toBe(identity[0]);
  expect(await f.run(["opencode", "inspect"])).toContain("Office link to a Git clone (declared): .opencode/plugins/imported");

  // Withdrawal unlinks; the checkout, which may hold local work, stays.
  f.select("");
  expect(await f.run(["sync"])).toContain("unlinked .opencode/plugins/imported");
  expect(existsSync(link)).toBe(false);
  expect(existsSync(join(checkout, ".git"))).toBe(true);

  // An earlier release's checkout in .opencode/plugins/ moves whole, then is linked.
  rmSync(checkout, { recursive: true });
  gitAt(f.home, f.env, "clone", "-q", remote, link);
  write(join(link, "untracked-note"), "kept\n");
  const legacy = statSync(link).ino;
  f.select(`plugins: [{name: imported, repo: ${remote}}]\n`);
  expect(await f.run(["check"], 1)).toContain(".opencode/plugins/imported/ is where earlier releases cloned plugin imported");
  const migrated = await f.run(["sync"]);
  expect(migrated).toContain("moved the checkout .opencode/plugins/imported to .office/plugins/imported");
  expect(migrated).toContain("linked .opencode/plugins/imported");
  expect(statSync(checkout).ino).toBe(legacy);
  expect(readFileSync(join(checkout, "untracked-note"), "utf8")).toBe("kept\n");
  expect(readlinkSync(link)).toBe("../../.office/plugins/imported");

  // A checkout there that isn't provably this plugin's stays where it is.
  rmSync(link);
  gitAt(f.home, f.env, "clone", "-q", remote, link);
  gitAt(link, f.env, "remote", "set-url", "origin", join(f.home, "elsewhere"));
  const unproven = snapshot(link);
  expect(await f.run(["sync"], 1)).toContain(".opencode/plugins/imported is a folder office sync can't verify as this plugin's checkout");
  expect(snapshot(link)).toEqual(unproven);
}, 60_000);

test("a package plugin that changes location is relinked with a restart notice, which check reports before sync", async () => {
  const f = fixture("retarget", "http://127.0.0.1:1");
  const upstream = join(f.home, "upstream");
  const link = join(f.dir, ".opencode/plugins/press");
  write(join(upstream, "pkg/package.yaml"), "name: press\ndescription: fixture\n");
  write(join(upstream, "pkg/plugin/index.js"), command("press"));
  gitAt(upstream, f.env, "init", "-q");
  gitAt(upstream, f.env, "add", ".");
  gitAt(upstream, f.env, "commit", "-qm", "press");
  f.select(`packages: [{name: press, repo: ${upstream}, path: pkg, ref: '${gitAt(upstream, f.env, "rev-parse", "HEAD")}'}]\n`);
  await f.run(["sync", "--packages"]);
  expect(readlinkSync(link)).toBe("../../.office/packages/press/plugin");

  // The owner takes the package local: same name, another directory.
  write(join(f.dir, "packages/press/package.yaml"), "name: press\ndescription: fixture\n");
  write(join(f.dir, "packages/press/plugin/index.js"), command("press"));
  f.select("packages: [{name: press}]\n");
  expect(await f.run(["check"], 1)).toContain(".opencode/plugins/press links to ../../.office/packages/press/plugin, but its package's plugin is ../../packages/press/plugin (office sync relinks it; then restart OpenCode to pick up press");
  expect(await f.run(["sync", "--packages"])).toContain("relinked .opencode/plugins/press to ../../packages/press/plugin; restart OpenCode to pick up press");
  expect(readlinkSync(link)).toBe("../../packages/press/plugin");
  expect(await f.run(["sync", "--packages"])).not.toContain("restart OpenCode");
}, 60_000);

test("sync keeps Office's plumbing out of Git in one info/exclude block, leaving the owner's lines and entries; check names tracked plumbing", async () => {
  const f = fixture("exclude", "http://127.0.0.1:1");
  const path = (file: string) => join(f.dir, file);
  const remote = pluginRemote(f, { "index.js": command("cloned") });
  const exclude = path(".git/info/exclude");

  const select = (packages: string, skills: string) => write(path("office.yaml"), [
    "name: sample", `state: ${f.home}/office-state`, "opencode: {mode: host, url: http://127.0.0.1:1}",
    `desks: {builder: {app: false, skills: [${skills}]}, sibling: {app: false}}`, `skills: {enabled: [${skills}]}`,
    `packages: [${packages}]`, `plugins: [{name: imported, repo: ${remote}}]`, "",
  ].join("\n"));

  const git = (...args: string[]) => gitAt(f.dir, f.env, ...args);
  write(path("skills/alpha/SKILL.md"), "---\nname: alpha\ndescription: fixture\n---\n");
  write(path(".opencode/plugins/owner-plugin/index.js"), command("owner-plugin"));
  write(path(".opencode/skills/owner-skill/SKILL.md"), "---\nname: owner-skill\ndescription: fixture\n---\n");

  // Without Git, sync writes no exclude and makes no repository.
  select("{name: common}", "alpha");
  await f.run(["sync"]);
  expect(existsSync(path(".git"))).toBe(false);

  git("init", "-q");
  write(path(".gitignore"), "/builder/repos/\n");
  // The owner's lines, and one an earlier release wrote for a clone in .opencode/plugins/.
  write(exclude, "# the owner's\n*.log\n/.opencode/plugins/imported/\n");
  const report = await f.run(["sync"]);
  const block = (lines: string[]) => [excludeStart, "/.office/", ...lines, excludeEnd].join("\n");
  const all = block(["/.opencode/plugins/common", "/.opencode/plugins/imported", "/.opencode/plugins/office", "/.opencode/skills/alpha", "/builder/.opencode/skills/alpha"]);
  expect(readFileSync(exclude, "utf8")).toBe(`# the owner's\n*.log\n${all}\n`);
  expect(report).toContain("replaced 1 plugin exclude line earlier releases wrote with the office sync block (info/exclude)");
  expect(await f.run(["sync"])).not.toContain("info/exclude");
  expect(readFileSync(exclude, "utf8")).toBe(`# the owner's\n*.log\n${all}\n`);

  const staged = git("add", "-A", "--dry-run").split("\n").map(line => line.replace(/^add '(.*)'$/, "$1"));
  expect(staged.filter(line => /^(\.office\/|\.opencode\/plugins\/(common|imported|office)$|\.opencode\/skills\/alpha$|builder\/\.opencode\/skills\/alpha$)/.test(line))).toEqual([]);
  expect(staged).toContain(".opencode/plugins/owner-plugin/index.js");
  expect(staged).toContain(".opencode/skills/owner-skill/SKILL.md");

  // Withdrawn entries leave the block; a line the owner adds after it stays.
  write(exclude, `${readFileSync(exclude, "utf8")}/scratch-notes/\n`);
  select("", "");
  expect(await f.run(["sync"])).toContain("stopped excluding /.opencode/plugins/common from commits (info/exclude)");
  expect(readFileSync(exclude, "utf8")).toBe(`# the owner's\n*.log\n/scratch-notes/\n${block(["/.opencode/plugins/imported", "/.opencode/plugins/office"])}\n`);

  // Plumbing committed by an earlier release stays tracked until the owner untracks it.
  git("add", "-f", ".office/packages/office", ".opencode/plugins/office");
  git("commit", "-qm", "plumbing as earlier releases committed it");
  const untrack = "git rm -r --cached --quiet -- .office .opencode/plugins/office";
  const health = await f.run(["check"], 1);
  expect(health).toContain("Office's plumbing is still committed");
  expect(health).toContain(untrack);
  expect(Bun.spawnSync(["sh", "-c", untrack], { cwd: f.dir, env: f.env }).exitCode).toBe(0);
  git("commit", "-qm", "untrack plumbing");
  expect(await f.run(["check"], 1)).not.toContain("plumbing is still committed");
  expect(readlinkSync(path(".opencode/plugins/office"))).toBe("../../.office/packages/office/plugin");
  expect(git("status", "--porcelain", "--untracked-files=all", "--", ".office", ".opencode/plugins/office")).toBe("");
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
    // The earlier release's link is Office's by its target, and goes with its package.
    expect(report).toContain("Office package link (selected pinned Git package): .opencode/plugins/press");
    f.select("");
    expect(await f.run(["sync", "--packages"])).toContain("unlinked .opencode/plugins/press");
    expect(existsSync(join(f.dir, ".opencode/plugins/press"))).toBe(false);
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
  // A Git-cloned plugin, loaded through .opencode/plugins/cloned -> ../../.office/plugins/cloned.
  const remote = join(f.home, "cloned-remote");
  write(join(remote, "index.js"), command("cloned-command"));
  gitAt(remote, f.env, "init", "-q");
  gitAt(remote, f.env, "add", ".");
  gitAt(remote, f.env, "commit", "-qm", "cloned");
  f.select(`packages: [{name: common}]\nplugins: [{name: cloned, repo: ${remote}}]\n`);
  await f.run(["sync"]);
  expect(readlinkSync(join(f.dir, ".opencode/plugins/cloned"))).toBe("../../.office/plugins/cloned");
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
      const expected = ["scope-setting", ...(shared ? ["shared-command", "cloned-command"] : []), ...(inBuilder ? ["builder-command", "native-command"] : [])];
      let entries = await listing();

      // Registration is asynchronous. Wait for every positive control before testing absence.
      while (!expected.every(name => entries.some(item => item.name === name)) && Date.now() < deadline) {
        await Bun.sleep(100);
        entries = await listing();
      }

      const commands = entries.map(item => item.name);

      expect(commands.includes("shared-command")).toBe(shared);
      expect(commands.includes("cloned-command")).toBe(shared);
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
