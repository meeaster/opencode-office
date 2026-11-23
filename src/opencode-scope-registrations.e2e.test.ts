import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { command, gitAt, scopeFixture, write } from "./opencode-scope.fixture.ts";
import { definitionText, pluginDefinition, writePackage } from "./test-package.ts";

const { office, fixture } = scopeFixture();

/** A definition whose `edition` setting decides what it registers with the opencode package. */
const editions = definitionText(`{settings:{type:"object",additionalProperties:false,properties:{edition:{type:"string",default:"both"}}},
    setup(ctx) {
      appendFileSync(process.env.SCOPE_IMPORTS, "setup\\n");
      const edition = ctx.settings.edition;
      if (edition === "none") return;
      if (edition !== "panel") opencode.plugins.add(ctx, {directory: "extensions/server"});
      if (edition === "duplicate") opencode.plugins.add(ctx, {directory: "plugin"});
      if (edition === "escape") opencode.panels.add(ctx, {file: "../outside.cjs"});
      if (edition === "missing") opencode.panels.add(ctx, {file: "missing.cjs"});
      if (edition === "both" || edition === "panel") opencode.panels.add(ctx, {file: "desktop/built.cjs"});
    },
    commands:{"folio edition":{summary:"fixture",run(){console.log("fiction")}}}}`, `import {opencode} from "@office/opencode";
  import {appendFileSync} from "node:fs";`);

test("explicit registrations: one owned link and an isolated panel; nothing by folder name; a failed registration keeps the last good ones; gui dev and inspect run no package code", async () => {
  const f = fixture("authored", "http://127.0.0.1:1");
  const pkg = join(f.dir, "packages/common");
  const link = join(f.dir, ".opencode/plugins/common");
  const panel = join(f.env.OFFICE_APP_PANELS_DIR, "common/gui-experimental.cjs");
  const appConfig = join(f.env.OFFICE_APP_CONFIG_DIR, "opencode.json");
  write(appConfig, '{"plugins":["independent-owner-panel"]}');
  write(join(pkg, "extensions/server/index.js"), command("custom-command"));
  write(join(pkg, "desktop/built.cjs"), "// custom panel");
  write(join(pkg, "gui/dist/gui-experimental.cjs"), "// a folder name registers nothing");
  writePackage(join(pkg, "office.ts"), editions, { dependencies: ["opencode"] });
  const sync = ["sync", "--packages"];
  const change = (edition: string) => f.select(`packages: [{name: common, settings: {edition: ${edition}}}]\n`);
  await f.run(sync);
  expect(readlinkSync(link)).toBe("../../packages/common/extensions/server");
  expect(readFileSync(panel, "utf8")).toBe("// custom panel");
  const registration = readFileSync(appConfig, "utf8");
  expect(JSON.parse(registration).plugins).toHaveLength(2);
  await f.run(sync);
  expect(readFileSync(appConfig, "utf8")).toBe(registration);
  const setups = () => readFileSync(f.imports, "utf8").split("\n").filter(Boolean).length;
  const before = setups();
  expect(await f.run(["opencode", "inspect"])).toContain("last synced registration: server declared, desktop declared");
  expect(await f.run(["folio", "edition"])).toContain("fiction");
  expect(setups()).toBe(before + 1);

  // A second server directory or an escaping panel fails the gathering: nothing is published or applied.
  for (const [mode, message] of [["duplicate", "opencode.plugins server directory added twice by package common"], ["escape", "file must be a relative path inside the package"]]) {
    change(mode);
    expect(await f.run(sync, 1)).toContain(message);
    expect(readlinkSync(link)).toBe("../../packages/common/extensions/server");
    expect(readFileSync(panel, "utf8")).toBe("// custom panel");
  }

  // A panel file that isn't there fails at delivery: the last good link and panel stay.
  change("missing");
  expect(await f.run(sync, 1)).toContain("OpenCode registration: OpenCode panel asset must be an existing regular file inside the package");
  expect(readlinkSync(link)).toBe("../../packages/common/extensions/server");
  expect(readFileSync(panel, "utf8")).toBe("// custom panel");
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
  expect(await f.run(["gui", "dev", "common"], 1)).toContain("common has no desktop panel registered with opencode.panels.add at the last sync");
  expect(existsSync(join(f.dir, "builder/.opencode/plugins/independent.js"))).toBe(true);
  change("both");
  await f.run(sync);
  const settled = setups();
  const dev = Bun.spawn([office, "gui", "dev", "common"], { cwd: f.dir, env: f.env, stdout: "pipe", stderr: "pipe" });
  const timeout = setTimeout(() => dev.kill("SIGKILL"), 10_000);

  try {
    let watching = "";
    const reader = dev.stdout.getReader();

    while (!watching.includes("watching packages/common/desktop/built.cjs")) {
      const next = await reader.read();

      if (next.done) throw new Error("gui dev did not watch the registered bundle");
      watching += new TextDecoder().decode(next.value);
    }

    write(join(pkg, "desktop/built.cjs"), "// watched build");

    for (let i = 0; i < 80 && readFileSync(panel, "utf8") !== "// watched build"; i++) await Bun.sleep(50);
    expect(readFileSync(panel, "utf8")).toBe("// watched build");
    // gui dev reads what sync applied; it never runs the package's setup, nor imports a definition
    // that would fail.
    expect(setups()).toBe(settled);
    writePackage(join(pkg, "office.ts"), definitionText('{}', 'throw new Error("imported");'));
    write(join(pkg, "desktop/built.cjs"), "// still disk only");

    for (let i = 0; i < 80 && readFileSync(panel, "utf8") !== "// still disk only"; i++) await Bun.sleep(50);
    expect(readFileSync(panel, "utf8")).toBe("// still disk only");
    writePackage(join(pkg, "office.ts"), editions, { dependencies: ["opencode"] });
    change("server");
    await f.run(sync);
    write(join(pkg, "desktop/built.cjs"), "// no longer declared");
    expect(await dev.exited).toBe(1);
    expect(readFileSync(panel, "utf8")).toBe("// still disk only");
  } finally {
    clearTimeout(timeout);
    dev.kill();
    await dev.exited;
  }

  // A bundle folder or a bundle that leads elsewhere through a link is refused before any copy.
  change("both");
  await f.run(sync);
  const synced = readFileSync(panel, "utf8");
  write(join(f.dir, "builds/desktop/built.cjs"), "// built elsewhere");
  rmSync(join(pkg, "desktop"), { recursive: true });
  symlinkSync("../../builds/desktop", join(pkg, "desktop"));
  expect(await f.run(["gui", "dev", "common"], 1)).toContain("desktop: the panel's folder leads outside the package through a link");
  rmSync(join(pkg, "desktop"));
  mkdirSync(join(pkg, "desktop"));
  write(join(pkg, "other.cjs"), "// another file");
  symlinkSync("../other.cjs", join(pkg, "desktop/built.cjs"));
  expect(await f.run(["gui", "dev", "common"], 1)).toContain("OpenCode panel asset must be an existing regular file inside the package, without redirected paths");
  expect(readFileSync(panel, "utf8")).toBe(synced);
  rmSync(join(pkg, "desktop/built.cjs"));
  write(join(pkg, "desktop/built.cjs"), "// custom panel");

  // A hand-made link with Office's text for the registered path is Office's: kept while
  // registered, withdrawn when the registration goes. An owner link elsewhere stays.
  rmSync(link);
  symlinkSync("../../packages/common/extensions/server", link);
  expect(await f.run(sync)).not.toContain("linked .opencode/plugins/common");
  change("none");
  expect(await f.run(sync)).toContain("unlinked .opencode/plugins/common");
  symlinkSync("../../builder/extensions/local", link);
  await f.run(sync);
  expect(readlinkSync(link)).toBe("../../builder/extensions/local");
}, 60_000);

test("a package registering nothing gets no link and no panel, whatever its folders; a registration through a symlinked folder is refused", async () => {
  const f = fixture("unregistered", "http://127.0.0.1:1");
  const pkg = join(f.dir, "packages/common");
  write(join(f.dir, "builds/common/gui-experimental.cjs"), "// built elsewhere in the office");
  mkdirSync(join(pkg, "gui"));
  symlinkSync("../../../builds/common", join(pkg, "gui/dist"));
  writePackage(join(pkg, "office.ts"), definitionText("{}"));
  expect(await f.run(["sync", "--packages"])).not.toContain("FAILED");
  expect(existsSync(join(f.dir, ".opencode/plugins/common"))).toBe(false);
  expect(existsSync(join(f.env.OFFICE_APP_PANELS_DIR, "common"))).toBe(false);

  writePackage(join(pkg, "office.ts"), pluginDefinition("plugin", { panel: "gui/dist/gui-experimental.cjs" }), { dependencies: ["opencode"] });
  expect(await f.run(["sync", "--packages"], 1)).toContain("without redirected paths");
  expect(existsSync(join(f.env.OFFICE_APP_PANELS_DIR, "common"))).toBe(false);
}, 60_000);

test("check and inspect report registrations as applied: no deletion advice while unread, no skill guessed from folders, retained panels by registration", async () => {
  const f = fixture("authored-health", "http://127.0.0.1:1");
  const pkg = join(f.dir, "packages/common");
  const removal = "none of its packages has that panel now";
  write(join(pkg, "skills/helper/SKILL.md"), "---\nname: helper\ndescription: fixture\n---\nHelper.\n");
  write(join(pkg, "extensions/server/index.js"), command("custom-command"));
  write(join(pkg, "desktop/built.cjs"), "// authored panel");
  writePackage(join(pkg, "office.ts"), editions, { dependencies: ["opencode"] });
  const change = (edition: string) => f.select(`packages: [{name: common, settings: {edition: ${edition}}}]\n`);
  await f.run(["sync", "--packages"]);
  let check = await f.run(["check"], 1);
  expect(check).not.toContain("helper");
  expect(check).not.toContain(removal);

  // Still selected, but the last delivery failed: the panel is not this office's to delete.
  change("missing");
  await f.run(["sync", "--packages"], 1);
  check = await f.run(["check"], 1);
  expect(check).not.toContain(removal);
  expect(await f.run(["opencode", "inspect"])).toContain("desktop: retained panel, registration not confirmed since its last sync (");
  // Settings changed since the last sync: check reads what the package registers now.
  change("server");
  check = await f.run(["check"], 1);
  expect(check).not.toContain("helper");

  await f.run(["sync", "--packages"]);
  const inspect = await f.run(["opencode", "inspect"]);
  expect(inspect).toContain("desktop: retained panel, not declared by its package (");
  expect(inspect).not.toContain("desktop: common (");
  expect(await f.run(["check"], 1)).toContain(removal);

  change("panel");
  await f.run(["sync", "--packages"]);
  expect(await f.run(["check"], 1)).not.toContain("helper");
  expect(await f.run(["opencode", "inspect"])).toContain("desktop: common (");

  // Registering neither asset leaves no record for the package: its panel is still only retained.
  change("none");
  await f.run(["sync", "--packages"]);
  const none = await f.run(["opencode", "inspect"]);
  expect(none).toContain("desktop: retained panel, not declared by its package (");
  expect(none).not.toContain("desktop: common (");
}, 60_000);

test("a pinned package's registrations repair the bound revision and an invalid staged replacement is rejected", async () => {
  const f = fixture("authored-pin", "http://127.0.0.1:1");
  const upstream = join(f.home, "upstream");
  const pkg = join(upstream, "pkg");
  const pulled = join(f.dir, ".office/packages/folio");
  const git = (...args: string[]) => gitAt(upstream, f.env, ...args);
  const select = (ref: string) => f.select(`packages: [{name: folio, repo: ${upstream}, path: pkg, ref: '${ref}'}]\n`);
  const definition = pluginDefinition("src/server", { panel: "dist/panel.cjs" });
  writePackage(join(pkg, "office.ts"), definition, { name: "folio", dependencies: ["opencode"] });
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
  writePackage(join(pkg, "office.ts"), definition.replace("dist/panel.cjs", "missing.cjs"), { name: "folio", dependencies: ["opencode"] });
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

test("deselecting a pulled package notes its retained panel at the registered bundle path", async () => {
  const f = fixture("authored-deselect", "http://127.0.0.1:1");
  const upstream = join(f.home, "upstream");
  const git = (...args: string[]) => gitAt(upstream, f.env, ...args);
  writePackage(join(upstream, "pkg/office.ts"), definitionText(`{setup(ctx){opencode.panels.add(ctx, {file: "dist/panel.cjs"})}}`, 'import {opencode} from "@office/opencode";'), { name: "folio", dependencies: ["opencode"] });
  write(join(upstream, "pkg/dist/panel.cjs"), "// registered only");
  git("init", "-q");
  git("add", ".");
  git("commit", "-qm", "panel");
  f.select(`packages: [{name: folio, repo: ${upstream}, path: pkg, ref: '${git("rev-parse", "HEAD")}'}]\n`);
  await f.run(["sync", "--packages"]);
  expect(readFileSync(join(f.env.OFFICE_APP_PANELS_DIR, "folio/gui-experimental.cjs"), "utf8")).toBe("// registered only");
  f.select("packages: []\n");
  expect(await f.run(["sync", "--packages"])).toContain("panel office-folio stays installed");
}, 60_000);
