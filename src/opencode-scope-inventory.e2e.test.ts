import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import * as v from "valibot";
import { command, deskConfig, gitAt, launcher, previous, rootConfig, scopeFixture, write } from "./opencode-scope.fixture.ts";

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
    // A redirected plugin folder is never followed, even for a selected package.
    rmSync(path("packages/common/office.ts"));
    write(path("packages/common/package.yaml"), "name: common\ndescription: Scope fixture\n");
    f.select("packages: [{name: common}]\n");
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
  await f.run(["cron", "list"]); // A plugin destination collision is not a broken cron provider.
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

  // So is a desk folder that is itself a link: its skills would be written and withdrawn outside the office.
  rmSync(deskSkills);
  const outside = join(f.home, "real-builder");
  renameSync(path("builder"), outside);
  symlinkSync(outside, path("builder"));
  write(join(outside, ".opencode/skills/.keep"), "");
  symlinkSync("../../../skills/beta", join(outside, ".opencode/skills/beta"));
  expect(await f.run(["sync"], 1)).toContain("its desk is not an office directory (refusing to follow or replace it)");
  expect(readdirSync(join(outside, ".opencode/skills")).sort()).toEqual([".keep", "beta"]);
  expect(readlinkSync(join(outside, ".opencode/skills/beta"))).toBe("../../../skills/beta");
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
  // Where an earlier release cloned a plugin: a real checkout in .opencode/plugins/, loaded as it is.
  const legacyRemote = join(f.home, "legacy-remote");
  write(join(legacyRemote, "index.js"), command("legacy-command"));
  gitAt(legacyRemote, f.env, "init", "-q");
  gitAt(legacyRemote, f.env, "add", ".");
  gitAt(legacyRemote, f.env, "commit", "-qm", "legacy");
  gitAt(f.home, f.env, "clone", "-q", legacyRemote, join(f.dir, ".opencode/plugins/legacy"));
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

    const loads = async (folder: string, names: string[]) => {
      const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, "x-opencode-directory": encodeURIComponent(folder) };
      const deadline = Date.now() + 8_000;

      for (;;) {
        const listed = v.parse(v.object({ data: v.array(v.object({ name: v.string() })) }), await (await fetch(`${url}/api/command`, { headers, signal: AbortSignal.timeout(10_000) })).json()).data.map(item => item.name);

        if (names.every(name => listed.includes(name)) || Date.now() > deadline) return names.filter(name => listed.includes(name));
        await Bun.sleep(200);
      }
    };

    // With both remotes unreachable, sync moves the legacy checkout and links it, and links the
    // clone whose link was deleted, before the fetches fail; both stay loaded in the running server.
    expect(await loads(f.dir, ["legacy-command"])).toEqual(["legacy-command"]);
    rmSync(join(f.dir, ".opencode/plugins/cloned"));
    renameSync(remote, `${remote}.away`);
    renameSync(legacyRemote, `${legacyRemote}.away`);
    f.select(`packages: [{name: common}]\nplugins: [{name: cloned, repo: ${remote}}, {name: legacy, repo: ${legacyRemote}}]\n`);
    const offline = await f.run(["sync"], 1);
    expect(offline).toContain("moved the checkout .opencode/plugins/legacy to .office/plugins/legacy");
    expect(readlinkSync(join(f.dir, ".opencode/plugins/legacy"))).toBe("../../.office/plugins/legacy");
    expect(readlinkSync(join(f.dir, ".opencode/plugins/cloned"))).toBe("../../.office/plugins/cloned");
    const fresh = join(f.dir, "sibling/after-offline-sync");
    mkdirSync(fresh);

    for (const folder of [f.dir, join(f.dir, "builder"), fresh]) expect(await loads(folder, ["cloned-command", "legacy-command"])).toEqual(["cloned-command", "legacy-command"]);
    renameSync(`${remote}.away`, remote);
    renameSync(`${legacyRemote}.away`, legacyRemote);
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
