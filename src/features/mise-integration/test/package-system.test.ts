import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";


import { syncLines as sync } from "../../../../test/support/sync.fixture.ts";
import { envFilePath } from "../../machine/paths.ts";
import { gatherPackages } from "../../../gather.ts";
import { grantConsent } from "../../machine/record.ts";
import { loadOffice } from "../../../office.ts";
import { machinePlatform, systemApplies, systemPlatformVariable } from "../system.ts";
import { installedPackages } from "../../../loader/definitions/inventory.ts";
import { requiredPackages } from "../../../loader/sources/selection.ts";
import { project } from "../projection.ts";
import { recipes, type Recipe } from "../../../../packages/mise-integration/claims.ts";
import { fragmentNotes } from "../delivery.ts";
import { definitionText, settingsSchema, writePackage } from "../../../../test/support/test-package.ts";
import { readAppliedSettings } from "../../../../sdk/applied-settings.ts";

let dir: string;

let office: string;

const savedPlatform = process.env[systemPlatformVariable];

const savedHome = process.env.HOME;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-package-system-"));
  office = join(dir, "office");
  process.env.HOME = join(dir, "home");
  process.env[systemPlatformVariable] = "ubuntu-24.04-amd64-wsl";
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env[systemPlatformVariable] = savedPlatform;
  process.env.HOME = savedHome;
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** The ready path a test creates to stand for the setup having been applied. */
const ready = () => join(dir, "root/usr/bin/demo-browser");

function recipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    name: "demo", setting: "system", description: "Demo Browser from the distribution",
    platforms: ["ubuntu-24.04-amd64-wsl", "debian-13-arm64"], prepare: "scripts/prepare.sh",
    bootstrap: "system/bootstrap.toml", ready: [ready()], env: { DEMO_BROWSER: "/usr/bin/demo-browser" },
    ...overrides,
  };
}

/** A local package `demo` with an install switched by `host` and a recipe switched by `system`. */
function demo(system = recipe(), schema = settingsSchema({ host: true, system: false })): void {
  writePackage(join(office, "packages/demo/office.ts"), definitionText(`{
    settings: ${schema},
    setup(ctx) {
      if (ctx.settings.host) ctx.add(installs, { name: "install", description: "Demo", destination: "~/.local/bin/demo", ready: "~/.local/bin/demo", script: "scripts/install.ts", executable: true });
      ctx.add(recipes, ${JSON.stringify(system)});
    },
  }`, `
    const installs = { id: "mise-integration.installs", parse: value => value };
    const recipes = { id: "mise-integration.recipes", parse: value => value };
  `));
  write(join(office, "packages/demo/scripts/install.ts"), "");
  write(join(office, "packages/demo/scripts/prepare.sh"), "");
  write(join(office, "packages/demo/system/bootstrap.toml"), '# Demo\'s packages.\n[bootstrap.packages]\n"apt:demo-browser" = "latest"\n\n[bootstrap.files."/etc/demo.conf"]\nos = "linux"\ncontent = "on\\n"\n');
}

/** office.yaml in `which` mode, listing demo with `settings` (YAML under its entry). */
function mode(which: "host" | "container", settings = ""): void {
  const opencode = which === "host" ? "opencode:\n  mode: host\n  url: http://127.0.0.1:49999\n" : "opencode: container\n";

  write(join(office, "office.yaml"), `name: t\n${opencode}packages:\n  - name: demo\n${settings}`);
}

const on = "    settings:\n      system: true\n";

test("native directories allow children; absent and conditional files own paths without requiring presence", async () => {
  demo(recipe({ description: "Example" }));
  mode("host", on);
  write(ready(), "");
  const file = join(office, "packages/demo/system/bootstrap.toml");
  write(file, `[bootstrap.directories."~/.config/demo"]\nmode="0755"\n[bootstrap.files."~/.config/demo/old"]\nstate="absent"\n[bootstrap.files."~/.config/demo/optional"]\nos="macos"\ncontent="mac"\n`);
  const manifest = join(office, "packages/demo/office.ts");
  const run = () => sync(loadOffice(office), { scope: "packages" });
  expect((await run()).join("\n")).not.toContain("FAILED");
  expect((await notes()).notes).toContain("Example is set up on this machine");
  const original = fragment();
  const target = join(dir, "home/.config/demo/old");
  write(file, `${readFileSync(file, "utf8")}[bootstrap.directories.${JSON.stringify(target)}]\nmode="0755"\n`);
  expect((await run()).join("\n")).toContain(`${target} claimed by both`);
  expect(fragment()).toBe(original);
  // A contributed recipe's setting must default to off too.
  write(file, readFileSync(file, "utf8").replace(`[bootstrap.directories.${JSON.stringify(target)}]\nmode="0755"\n`, ""));
  write(manifest, readFileSync(manifest, "utf8").replace('"system":{"type":"boolean","default":false}', '"system":{"type":"boolean","default":true}'));
  expect((await run()).join("\n")).toContain("system recipe demo: its setting system must be declared type: boolean with default: false, so it defaults to off");
  expect(fragment()).toBe(original);
});

/** demo's fragment, or "" when it has none. */
const fragment = () => (existsSync(join(office, ".office/mise/demo.toml")) ? readFileSync(join(office, ".office/mise/demo.toml"), "utf8") : "");

async function notes() {
  const loaded = loadOffice(office);
  const item = (await gatherPackages(loaded, { machine: true })).packages.find((candidate) => candidate.entry.name === "demo");

  if (item === undefined) throw new Error("demo isn't installed");

  return fragmentNotes(loaded, item);
}

const systemPart = `# The system setup of package demo: Demo Browser from the distribution. office setup offers to apply it on this machine, from your terminal (mise asks for sudo); nothing else does, and what it installs stays when it is turned off.
[vars]
office_package_demo = "{{ config_source | canonicalize | dirname }}/../../packages/demo"

[bootstrap.hooks.pre-packages]
description = "Prepare Demo Browser from the distribution"
run = "bash \\"{{ vars.office_package_demo }}/scripts/prepare.sh\\""

# Demo's packages.
[bootstrap.packages]
"apt:demo-browser" = "latest"

[bootstrap.files."/etc/demo.conf"]
os = "linux"
content = "on\\n"
`;

test("an office that opts in on a supported host gets the setup in the fragment and the variable in the environment file, and check looks for what it installs", async () => {
  demo();
  mode("host", on);
  grantConsent(loadOffice(office), "");

  const changes = await sync(loadOffice(office));

  expect(changes).toContain("wrote package demo's system setup, Demo Browser from the distribution, to .office/mise/demo.toml: office setup offers to apply it on this machine (mise asks for sudo); nothing else does");
  expect(fragment()).toEndWith(`\n\n${systemPart}`);
  expect(fragment()).toContain('[tasks."demo:install"]');
  expect(readFileSync(envFilePath(), "utf8")).toContain("export DEMO_BROWSER='/usr/bin/demo-browser'\n");
  expect(await notes()).toEqual({
    ok: false,
    notes: [
      "mise setup in .office/mise/demo.toml",
      "Demo is missing from ~/.local/bin/demo; office up installs it (or mise install, or mise run demo:install, once the office's tools are linked)",
      `Demo Browser from the distribution isn't set up on this machine yet (missing ${ready()}): run office setup in a terminal, which offers to apply it (mise asks for sudo)`,
    ],
  });

  write(ready(), "");

  expect((await notes()).notes).toContain("Demo Browser from the distribution is set up on this machine");
  // A second sync changes nothing: the setup is written once, and applying it is the user's.
  expect((await sync(loadOffice(office))).filter((line) => line.includes("system setup"))).toEqual([]);
});

test("two enabled recipes setting the same variable are named and the variable is omitted", async () => {
  demo();
  mode("host", on);
  const config = join(office, "office.yaml");
  const other = join(office, "packages/other");

  writePackage(join(other, "office.ts"), definitionText(`{
    settings: ${settingsSchema({ system: false })},
    setup(ctx) {
      ctx.add(recipes, ${JSON.stringify(recipe({ name: "other", prepare: undefined }))});
    },
  }`, 'const recipes = { id: "mise-integration.recipes", parse: value => value };'));
  write(join(other, "system/bootstrap.toml"), "[bootstrap.packages]\n");
  write(config, `${readFileSync(config, "utf8")}  - name: other\n${on}`);
  grantConsent(loadOffice(office), "");

  expect(await sync(loadOffice(office))).toContain(`FAILED packages demo and other both set DEMO_BROWSER in their system recipes, so ${envFilePath()} sets neither; remove it from one`);
  expect(readFileSync(envFilePath(), "utf8")).not.toContain("DEMO_BROWSER");
});

test("the system recipe is independent of the install's setting, and off by default", async () => {
  demo();
  mode("host", "    settings:\n      host: false\n      system: true\n");

  await sync(loadOffice(office));

  expect(fragment()).not.toContain("[tasks.");
  expect(fragment()).toEndWith(`so it applies in every folder.\n\n${systemPart}`);
  expect(fragment()).not.toContain("[tools]");

  mode("host");

  const changes = await sync(loadOffice(office));

  expect(changes).toContain("removed package demo's system setup, Demo Browser from the distribution, from .office/mise/demo.toml: its system setting is off; what it installed stays on the machine");
  expect(fragment()).not.toContain("bootstrap");
  expect(fragment()).toContain('[tasks."demo:install"]');
  expect((await notes()).notes.some((note) => note.includes("Demo Browser"))).toBe(false);
});

test("it applies only on the platforms the block names, in host mode, and a platform without -wsl is no WSL machine", async () => {
  demo();
  // Sync and check decide alike (systemState), so one sync stands for each platform it doesn't name.
  process.env[systemPlatformVariable] = "ubuntu-24.04-amd64";
  mode("host", "    settings:\n      host: false\n      system: true\n");
  await sync(loadOffice(office));

  expect(fragment()).not.toContain("bootstrap");

  for (const [platform, why] of [
    ["ubuntu-24.04-amd64", "this machine is ubuntu-24.04-amd64, not ubuntu-24.04-amd64-wsl or debian-13-arm64"],
    ["ubuntu-22.04-amd64-wsl", "this machine is ubuntu-22.04-amd64-wsl, not ubuntu-24.04-amd64-wsl or debian-13-arm64"],
    ["", "this machine is a platform office can't identify, not ubuntu-24.04-amd64-wsl or debian-13-arm64"],
  ]) {
    process.env[systemPlatformVariable] = platform;

    // Opting in where it can't apply is noted, without failing check.
    expect(await notes()).toEqual({ ok: true, notes: [`Demo Browser from the distribution isn't set up: ${why}`] });
  }

  // A block's platform without -wsl covers the machine under WSL too.
  process.env[systemPlatformVariable] = "debian-13-arm64-wsl";
  await sync(loadOffice(office));

  expect(fragment()).toContain("[bootstrap.packages]");

  mode("container", on);

  expect(await sync(loadOffice(office))).toContain(
    "removed package demo's system setup, Demo Browser from the distribution, from .office/mise/demo.toml: the office runs OpenCode in its container (opencode: container); what it installed stays on the machine",
  );
  expect(fragment()).toBe("");
});

test("a recipe refuses bootstrap files with hooks or tables outside bootstrap", async () => {
  demo();
  mode("host", on);
  const bootstrap = join(office, "packages/demo/system/bootstrap.toml");

  for (const [table, key] of [["bootstrap.hooks", "hooks"], ["tools", "tools"]]) {
    write(bootstrap, `[bootstrap.packages]\n[${table}]\n`);
    expect((await sync(loadOffice(office))).join("\n")).toContain(`FAILED package demo: Invalid key: Expected never but received "${key}"`);
    expect(fragment()).toBe("");
  }
});

test("the built-in browser package leaves agent-browser's own Chromium alone by default, and with system_chrome sets up Google Chrome from apt", async () => {
  const browser = (settings: string) => write(join(office, "office.yaml"), `name: t\nopencode:\n  mode: host\n  url: http://127.0.0.1:49999\npackages:\n  - name: browser\n${settings}`);
  const text = () => readFileSync(join(office, ".office/mise/browser.toml"), "utf8");

  browser("");
  grantConsent(loadOffice(office), "");
  await sync(loadOffice(office));

  expect(text()).not.toContain("bootstrap");
  expect(text()).toContain('[tasks."browser:install"]');
  expect(readFileSync(envFilePath(), "utf8")).not.toContain("AGENT_BROWSER_EXECUTABLE_PATH");

  browser("    settings:\n      browse: false\n      system_chrome: true\n");
  await sync(loadOffice(office));

  const fragmentText = text();

  expect(fragmentText).not.toContain('[tasks."browser:install"]');
  expect(fragmentText).toContain('office_package_browser = "{{ config_source | canonicalize | dirname }}/../../.office/packages/browser"\n');
  expect(fragmentText).toContain('run = "bash \\"{{ vars.office_package_browser }}/scripts/google-chrome-apt-source.sh\\""');

  for (const name of ["google-chrome-stable", "libnss3-tools", "fonts-noto-color-emoji", "fonts-noto-cjk", "unattended-upgrades"]) expect(fragmentText).toContain(`"apt:${name}" = "latest"`);

  expect(fragmentText).toContain('"origin=Google LLC,label=Google,codename=stable,site=dl.google.com";');
  expect(readFileSync(envFilePath(), "utf8")).toContain("export AGENT_BROWSER_EXECUTABLE_PATH='/usr/bin/google-chrome-stable'\n");
  expect(readAppliedSettings(office, "browser")).toMatchObject({ browse: false, system_chrome: true });

  // A container-mode office never gets it, whatever the setting says.
  write(join(office, "office.yaml"), "name: t\nopencode: container\npackages:\n  - name: browser\n    settings:\n      system_chrome: true\n");
  await sync(loadOffice(office));

  expect(existsSync(join(office, ".office/mise/browser.toml"))).toBe(false);
  expect(readFileSync(join(office, "machine.packages.toml"), "utf8")).toContain('\n"npm:agent-browser" = "0.43.0" # browser\n');
});

test("the machine's platform comes from os-release and the kernel, unless the variable names one", () => {
  process.env[systemPlatformVariable] = "debian-13-arm64";

  expect(machinePlatform()).toBe("debian-13-arm64");

  delete process.env[systemPlatformVariable];

  const detected = machinePlatform();

  if (process.platform === "linux") expect(detected).toMatch(/^[a-z0-9]+-[0-9.]+-(?:amd64|arm64)(?:-wsl)?$/);
  else expect(detected).toBeUndefined();
});

test("a recipe applies only when office.yaml explicitly enables its setting and rejects an implicit true default", () => {
  const read = () => {
    const loaded = loadOffice(office);
    const inventory = installedPackages(loaded, new Set(requiredPackages));
    const item = inventory.installed.find(candidate => candidate.entry.name === "demo");

    if (!item) throw new Error(inventory.problems.map(problem => problem.message).join("\n"));

    return { loaded, item };
  };

  demo(recipe(), `{type:"object",properties:{system:{type:"boolean",default:false}},allOf:[{properties:{system:{default:true}}}]}`);
  mode("host");
  const rows = [{ id: recipes.id, value: recipe() }];
  const problem = "packages.demo.settings.system: resolves to true though office.yaml doesn't set it; the setting of a system setup must default to off, so an office opts in";

  expect(() => project(read().item, rows)).toThrow(`system recipe demo: ${problem}`);

  mode("host", on);
  const { loaded, item } = read();
  const projected = { ...item, ...project(item, rows) };
  expect(systemApplies(loaded, projected)).toBe(true);
  projected.entry.settings = { system: "true" };
  expect(systemApplies(loaded, projected)).toBe(false);
});

test("recipes validate bootstrap paths, prepare scripts, platforms, readiness paths and environment", async () => {
  mode("host", on);

  for (const [overrides, reason] of [
    [{ bootstrap: "../b.toml" }, "must not climb out with .."],
    [{ prepare: "scripts/p.ts" }, "must be a .sh file in the package"],
    [{ platforms: ["Ubuntu 24.04"] }, "must be a platform such as ubuntu-24.04-amd64-wsl"],
    [{ ready: ["usr/bin/d"] }, "must be an absolute path"],
    [{ env: { PATH: "/bin" } }, "is set by office itself"],
    [{ env: { DEMO_BROWSER: "one\ntwo" } }, "must be one line of plain text"],
  ] satisfies [Partial<Recipe>, string][]) {
    demo(recipe(overrides));
    expect((await sync(loadOffice(office))).join("\n")).toContain(reason);
  }
});
