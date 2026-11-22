import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { command, gitAt, groundwork, scopeFixture, write } from "./opencode-scope.fixture.ts";

const { office, fixture } = scopeFixture();

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
        else if(ctx.settings.edition === "both") ctx.desktopPanel("desktop/built.cjs");
      }};`);
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
  expect(readFileSync(f.imports, "utf8")).toBe(collections);
  // A package command loads every selected package's setup, never its opencode(ctx) collection.
  await f.run(["references", "list"]);
  expect(readFileSync(f.imports, "utf8")).toBe(`${collections}setup\n`);
  expect(await f.run(["folio", "edition"])).toContain("fiction");
  expect(readFileSync(f.imports, "utf8")).toBe(`${collections}setup\nsetup\n`);

  if (groundwork) {
    // Custom receipts do not change the schema/data in the older reader's links table.
    await f.run(["opencode", "inspect"], 0, groundwork);
    expect(await f.run(sync, 1, groundwork)).toContain("opencode");
    expect(readlinkSync(link)).toBe("../../packages/common/extensions/server");
    expect(readFileSync(panel, "utf8")).toBe("// custom panel");
  }

  // Each failure is reported as a failed registration and leaves the last good link and panel; inspect
  // reads the recorded state, the same for every failure. The symlinked gui/dist test covers a claim
  // through a redirected path.
  for (const mode of ["throw", "duplicate", "escape"]) {
    change(mode);
    expect(await f.run(sync, 1)).toContain("OpenCode registration");
    expect(readlinkSync(link)).toBe("../../packages/common/extensions/server");
    expect(readFileSync(panel, "utf8")).toBe("// custom panel");
  }

  expect(await f.run(["opencode", "inspect"])).toContain("registration unavailable at last sync");

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
