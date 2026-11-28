import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import * as v from "valibot";
import { command, gitAt, launcher, repoConfig, rootConfig, scopeFixture, write } from "./opencode-scope.fixture.ts";
import { pluginDefinition, writePackage } from "../../../../test/support/test-package.ts";

const { sandbox, fixture } = scopeFixture();

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
    const inspect = ["opencode", "inspect", "repos/builder/sample"];

    write(path("packages/common/gui/dist/gui-experimental.cjs"), "module.exports = {}");
    writePackage(path("packages/common/office.ts"), pluginDefinition("plugin", { panel: "gui/dist/gui-experimental.cjs" }), { dependencies: ["opencode"] });
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
    writePackage(path("packages/common/office.ts"), `import {writeFileSync} from "node:fs"; writeFileSync(process.env.SCOPE_IMPORTS, "definition"); throw Error("unread");`);
    write(join(f.home, "config/opencode/opencode.json"), '{"plugins":["hidden-global-plugin"]}');
    const report = await f.run(inspect);

    expect(report).toContain("[folder repos/<folder-2>] configured local directory: repos/<folder-2>/.opencode/opencode.jsonc#plugins[0]");
    expect(report).toContain("[folder repos/<folder-2>/<folder-3>] native config: repos/<folder-2>/<folder-3>/opencode.json");
    expect(report).not.toMatch(/\bdesk\b|builder/);
    expect(report).toContain("declared Git clone (no checkout observed; not linked as .opencode/plugins/imported): office.yaml plugins: imported -> .office/plugins/imported");
    expect(report).toContain("Office package copy (selected built-in package): .opencode/plugins/office");
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
    expect(await f.run(["opencode", "inspect", "repos/sibling"])).not.toContain("configured local directory: repos/");
    expect((await f.run(["opencode", "inspect", ".opencode"])).match(/native config: \.opencode\/opencode\.jsonc/g)).toHaveLength(1);
    const failed = await f.run(["opencode", "inspect", join(f.home, "hidden-lookup\nINJECTED")], 1);
    expect(failed).not.toMatch(/hidden-lookup|INJECTED/);
    expect(await f.run(["opencode", "inspect", "--hidden-flag\nINJECTED"], 1)).not.toMatch(/hidden-flag|INJECTED/);

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
    expect(readFileSync(path("repos/builder/.opencode/plugins/independent.js"), "utf8")).toBe(command("native-command"));
    expect(readFileSync(path("repos/builder/.opencode/opencode.jsonc"), "utf8")).toBe(repoConfig);
    expect(readFileSync(path(".opencode/opencode.jsonc"), "utf8")).toBe(edited);
    // An owner directory with a package's name is the office's own, never replaced.
    writePackage(path("packages/common/office.ts"), pluginDefinition(), { dependencies: ["opencode"] });
    write(path(".opencode/plugins/common/index.js"), "// independently authored");
    f.select("packages: [{name: common}]\n");
    expect(await f.run(["sync"], 1)).toContain("no Office copy or link owns it");
    expect(readFileSync(path(".opencode/plugins/common/index.js"), "utf8")).toBe("// independently authored");
    // A redirected plugin folder is never followed, even for a selected package.
    rmSync(path(".opencode/plugins"), { recursive: true });
    symlinkSync(f.env.OFFICE_APP_CONFIG_DIR, path(".opencode/plugins"));
    expect(await f.run(sync, 1)).toContain("refusing to follow or replace it");
    expect(existsSync(join(f.env.OFFICE_APP_CONFIG_DIR, "common"))).toBe(false);
  } finally {
    trap.stop(true);
  }
}, 60_000);

test("ownership by target: Office's plugin links are recognized and withdrawn by their text; the owner's entries, name clashes and skill folders are left alone", async () => {
  const f = fixture("ownership", "http://127.0.0.1:1");
  const path = (file: string) => join(f.dir, file);
  const plugins = path(".opencode/plugins");
  const skills = path(".opencode/skills");
  const repoSkills = path("repos/builder/.opencode/skills");
  write(path("skills/alpha/SKILL.md"), "---\nname: alpha\ndescription: fixture\n---\n");

  const select = (packages: string) => write(path("office.yaml"), [
    "name: sample", `state: ${f.home}/office-state`, "opencode: {mode: host, url: http://127.0.0.1:1}",
    `packages: [${packages}]`, "",
  ].join("\n"));

  // The owner's entries: a real plugin folder, a link elsewhere, a file, a real skill folder, and
  // links to skills: none is Office's, the ones earlier releases wrote included.
  write(path(".opencode/plugins/owner-plugin/index.js"), command("owner-plugin"));
  symlinkSync("../../repos/builder/extensions/local", join(plugins, "owner-link"));
  write(join(plugins, "notes.txt"), "owner\n");
  write(join(skills, "owner-skill/SKILL.md"), "---\nname: owner-skill\ndescription: fixture\n---\n");
  symlinkSync("../../skills/alpha", join(skills, "alpha"));
  mkdirSync(repoSkills, { recursive: true });
  symlinkSync("../../../../skills/alpha", join(repoSkills, "alpha"));
  // A legacy copy-source link is the owner's now. Local and clone links are recognized by text.
  symlinkSync("../../.office/packages/gone/plugin", join(plugins, "gone"));
  symlinkSync("../../.office/plugins/old-clone", join(plugins, "old-clone"));
  symlinkSync("../../packages/common/plugin", join(plugins, "common"));
  const owner = () => [readlinkSync(join(plugins, "owner-link")), readFileSync(join(plugins, "notes.txt"), "utf8"), readlinkSync(join(skills, "alpha")), readlinkSync(join(repoSkills, "alpha")), existsSync(path(".opencode/plugins/owner-plugin/index.js")), existsSync(join(skills, "owner-skill/SKILL.md"))];
  const kept = owner();

  select("{name: common}");
  const first = await f.run(["sync"]);
  expect(readlinkSync(join(plugins, "gone"))).toBe("../../.office/packages/gone/plugin");
  expect(first).toContain("unlinked .opencode/plugins/old-clone");
  expect(first).not.toContain("linked .opencode/plugins/common");
  // No skill is delivered without the skills package: no link line, and no link folder.
  expect(first).not.toMatch(/linked \.(?:opencode|agents)\/skills\//);
  expect(existsSync(path(".agents/skills"))).toBe(false);
  expect(readdirSync(skills).sort()).toEqual(["alpha", "owner-skill"]);
  expect(readlinkSync(join(plugins, "common"))).toBe("../../packages/common/plugin");
  expect(existsSync(join(plugins, "old-clone"))).toBe(false);
  expect(owner()).toEqual(kept);
  expect(await f.run(["sync"])).not.toMatch(/linked|unlinked/);

  // A name clash with an owner entry is refused and reported; the owner's entry stays.
  rmSync(join(plugins, "common"));
  write(join(plugins, "common/index.js"), "// the owner's own common\n");
  expect(await f.run(["sync"], 1)).toContain("which holds a plugin of this office's own (no Office copy or link owns it)");
  expect(readFileSync(join(plugins, "common/index.js"), "utf8")).toBe("// the owner's own common\n");
  rmSync(join(plugins, "common"), { recursive: true });
  symlinkSync("../../repos/builder/extensions/local", join(plugins, "common"));
  expect(await f.run(["sync"], 1)).toContain("no Office copy or link owns it");
  expect(readlinkSync(join(plugins, "common"))).toBe("../../repos/builder/extensions/local");
  await f.run(["cron", "list"]); // A plugin destination collision is not a broken cron provider.

  // Deselecting withdraws Office's links, the identical hand-made ones too; nothing of the owner's.
  rmSync(join(plugins, "common"));
  symlinkSync("../../packages/common/plugin", join(plugins, "common"));
  select("");
  expect(await f.run(["sync"])).toContain("unlinked .opencode/plugins/common");
  expect(readdirSync(plugins).sort()).toEqual(["gone", "notes.txt", "office", "owner-link", "owner-plugin"]);
  expect(readdirSync(skills).sort()).toEqual(["alpha", "owner-skill"]);
  expect(readdirSync(repoSkills)).toEqual(["alpha"]);
  expect(owner()).toEqual(kept);
  expect(readFileSync(path("repos/builder/.opencode/plugins/independent.js"), "utf8")).toBe(command("native-command"));
}, 60_000);

test("changing a package between managed and local switches its plugin between a recorded copy and a link", async () => {
  const f = fixture("retarget", "http://127.0.0.1:1");
  const upstream = join(f.home, "upstream");
  const link = join(f.dir, ".opencode/plugins/press");
  writePackage(join(upstream, "pkg/office.ts"), pluginDefinition(), { name: "press", dependencies: ["opencode"] });
  write(join(upstream, "pkg/plugin/index.js"), command("press"));
  gitAt(upstream, f.env, "init", "-q");
  gitAt(upstream, f.env, "add", ".");
  gitAt(upstream, f.env, "commit", "-qm", "press");
  const managed = `packages: [{name: press, repo: ${upstream}, path: pkg, ref: '${gitAt(upstream, f.env, "rev-parse", "HEAD")}'}]\n`;
  f.select(managed);
  await f.run(["sync", "--packages"]);
  const receipt = () => JSON.parse(readFileSync(join(f.dir, ".office/opencode/copies.json"), "utf8")).copies;

  expect(lstatSync(link).isDirectory()).toBe(true);
  expect(receipt()).toContain(".opencode/plugins/press");
  write(join(link, "index.js"), "// edited copy");
  expect(await f.run(["check"], 1)).toContain(".opencode/plugins/press/index.js");
  await f.run(["sync", "--packages"]);
  expect(readFileSync(join(link, "index.js"), "utf8")).toBe(command("press"));

  // The owner takes the package local: same name, another directory.
  writePackage(join(f.dir, "packages/press/office.ts"), pluginDefinition(), { dependencies: ["opencode"] });
  write(join(f.dir, "packages/press/plugin/index.js"), command("press"));
  f.select("packages: [{name: press}]\n");
  // The published set still links press to its pulled-in copy, so nothing loads until sync.
  expect(await f.run(["check"], 1)).toContain("FAIL package press: the package set links it to a different folder; run office sync");
  rmSync(join(f.dir, ".office/current/node_modules/@office/press"));
  expect(await f.run(["check"], 1)).toContain("FAIL package press: selected since the last sync; run office sync");
  expect(await f.run(["sync", "--packages"])).toContain("removed plugin copy .opencode/plugins/press; restart OpenCode to pick up press if it loaded the previous delivery");
  expect(readlinkSync(link)).toBe("../../packages/press/plugin");
  expect(receipt()).not.toContain(".opencode/plugins/press");

  renameSync(join(f.dir, "packages/press"), join(f.home, "local-press"));
  f.select(managed);
  await f.run(["sync", "--packages"]);
  expect(lstatSync(link).isDirectory()).toBe(true);
  expect(receipt()).toContain(".opencode/plugins/press");

  f.select("packages: []\n");
  await f.run(["sync", "--packages"]);
  expect(existsSync(link)).toBe(false);
  expect(receipt()).not.toContain(".opencode/plugins/press");
}, 60_000);

// Opt-in: a real v2 launcher, isolated HOME and server on a kernel-assigned loopback port.
test.skipIf(!launcher)("OpenCode sees the shared command in every working repository, the builder commands and override only in builder and its nested repo", async () => {
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
    await verify(f.builder, true, true);
    await verify(f.repo, true, true);
    await verify(join(f.dir, "repos/sibling"), false, true);

    const loads = async (folder: string, names: string[]) => {
      const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "x-opencode-directory": encodeURIComponent(folder) };
      const deadline = Date.now() + 8_000;

      for (;;) {
        const listed = v.parse(v.object({ data: v.array(v.object({ name: v.string() })) }), await (await fetch(`${url}/api/command`, { headers, signal: AbortSignal.timeout(10_000) })).json()).data.map(item => item.name);

        if (names.every(name => listed.includes(name)) || Date.now() > deadline) return names.filter(name => listed.includes(name));
        await Bun.sleep(200);
      }
    };

    // With the remote unreachable, sync links the clone whose link was deleted before the fetch
    // fails; it stays loaded in the running server.
    rmSync(join(f.dir, ".opencode/plugins/cloned"));
    renameSync(remote, `${remote}.away`);
    await f.run(["sync"], 1);
    expect(readlinkSync(join(f.dir, ".opencode/plugins/cloned"))).toBe("../../.office/plugins/cloned");
    const fresh = join(f.dir, "repos/sibling/after-offline-sync");
    mkdirSync(fresh);

    for (const folder of [f.dir, f.builder, fresh]) expect(await loads(folder, ["cloned-command"])).toEqual(["cloned-command"]);
    renameSync(`${remote}.away`, remote);
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
