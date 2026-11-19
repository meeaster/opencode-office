import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import * as v from "valibot";

import { sync } from "./commands/sync.ts";
import { envFilePath } from "./host-env.ts";
import { installedPackages } from "./layout.ts";
import { grantConsent } from "./machine.ts";
import { loadOffice } from "./office.ts";
import { machinePlatform, systemPlatformVariable } from "./package-system.ts";
import { fragmentNotes } from "./package-tools.ts";
import { check, packageManifestSchema } from "./schema.ts";

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

/** A local package `demo` with a host block switched by `host` and a system block switched by `system`. */
function demo(extra = ""): void {
  write(
    join(office, "packages/demo/package.yaml"),
    `name: demo
description: A demo package.
settings:
  host:
    description: Whether host offices get the demo install
    default: true
  system:
    description: Whether a supported host gets the demo system setup
    default: false
tools:
  jq: "1.7.1"
host:
  setting: host
  install:
    description: Demo
    creates: ~/.local/bin/demo
    script: scripts/install.ts
system:
  setting: system
  description: Demo Browser from the distribution
  platforms: [ubuntu-24.04-amd64-wsl, debian-13-arm64]
  prepare: scripts/prepare.sh
  bootstrap: system/bootstrap.toml
  ready: [${ready()}]
  env:
    DEMO_BROWSER: /usr/bin/demo-browser
${extra}`,
  );
  write(join(office, "packages/demo/system/bootstrap.toml"), '# Demo\'s packages.\n[bootstrap.packages]\n"apt:demo-browser" = "latest"\n\n[bootstrap.files."/etc/demo.conf"]\ncontent = "on\\n"\n');
}

/** office.yaml in `which` mode, listing demo with `settings` (YAML under its entry). */
function mode(which: "host" | "container", settings = ""): void {
  const opencode = which === "host" ? "opencode:\n  mode: host\n  url: http://127.0.0.1:49999\n" : "opencode: container\n";

  write(join(office, "office.yaml"), `name: t\n${opencode}packages:\n  - name: demo\n${settings}`);
}

const on = "    settings:\n      system: true\n";

/** demo's fragment, or "" when it has none. */
const fragment = () => (existsSync(join(office, ".office/mise/demo.toml")) ? readFileSync(join(office, ".office/mise/demo.toml"), "utf8") : "");

function notes() {
  const loaded = loadOffice(office);
  const item = installedPackages(loaded).installed.find((candidate) => candidate.entry.name === "demo");

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
content = "on\\n"
`;

test("an office that opts in on a supported host gets the setup in the fragment and the variable in the environment file, and check looks for what it installs", async () => {
  demo();
  mode("host", on);
  grantConsent(loadOffice(office));

  const changes = await sync(loadOffice(office));

  expect(changes).toContain("wrote package demo's system setup, Demo Browser from the distribution, to .office/mise/demo.toml: office setup offers to apply it on this machine (mise asks for sudo); nothing else does");
  expect(fragment()).toEndWith(`\n\n${systemPart}`);
  expect(fragment()).toContain('[tasks."demo:install"]');
  expect(readFileSync(envFilePath(), "utf8")).toContain("export DEMO_BROWSER='/usr/bin/demo-browser'\n");
  expect(notes()).toEqual({
    ok: false,
    notes: [
      "tools jq in machine.packages.toml",
      "mise setup in .office/mise/demo.toml",
      "Demo is missing from ~/.local/bin/demo; office up installs it (or mise install, or mise run demo:install, once the office's tools are linked)",
      `Demo Browser from the distribution isn't set up on this machine yet (missing ${ready()}): run office setup in a terminal, which offers to apply it (mise asks for sudo)`,
    ],
  });

  write(ready(), "");

  expect(notes().notes).toContain("Demo Browser from the distribution is set up on this machine");
  // A second sync changes nothing: the setup is written once, and applying it is the user's.
  expect((await sync(loadOffice(office))).filter((line) => line.includes("system setup"))).toEqual([]);
});

test("the system block is independent of the host block's setting, and off by default", async () => {
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
  expect(notes().notes.some((note) => note.includes("Demo Browser"))).toBe(false);
});

test("it applies only on the platforms the block names, in host mode, and a platform without -wsl is no WSL machine", async () => {
  demo();

  for (const [platform, why] of [
    ["ubuntu-24.04-amd64", "this machine is ubuntu-24.04-amd64, not ubuntu-24.04-amd64-wsl or debian-13-arm64"],
    ["ubuntu-22.04-amd64-wsl", "this machine is ubuntu-22.04-amd64-wsl, not ubuntu-24.04-amd64-wsl or debian-13-arm64"],
    ["", "this machine is a platform office can't identify, not ubuntu-24.04-amd64-wsl or debian-13-arm64"],
  ]) {
    process.env[systemPlatformVariable] = platform;
    mode("host", "    settings:\n      host: false\n      system: true\n");
    await sync(loadOffice(office));

    // Opting in where it can't apply is noted, without failing check.
    expect(fragment()).not.toContain("bootstrap");
    expect(notes()).toEqual({ ok: true, notes: ["tools jq in machine.packages.toml", `Demo Browser from the distribution isn't set up: ${why}`] });
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

test("the bootstrap file holds only [bootstrap.…] tables without hooks, and the block's paths stay in the package", async () => {
  demo();
  mode("host", on);
  write(join(office, "packages/demo/system/bootstrap.toml"), '[tools]\njq = "1"\n[bootstrap.hooks]\npre-packages = "rm -rf /"\n');

  expect(await sync(loadOffice(office))).toContain(
    "FAILED package demo: system/bootstrap.toml: [tools] isn't a [bootstrap.…] table; system/bootstrap.toml: [bootstrap.hooks]: hooks are sync's, from the system block's prepare script; .office/mise/demo.toml is left as it was",
  );

  const errors = (system: string) => {
    const result = check(v.safeParse(packageManifestSchema, Bun.YAML.parse(`name: bad\ndescription: Bad.\nsettings:\n  on:\n    description: On.\n    default: false\n  yes:\n    description: Yes.\n    default: true\nsystem:\n${system}`)));

    return result.ok ? [] : result.errors;
  };

  const valid = "  setting: on\n  description: D\n  platforms: [ubuntu-24.04-amd64-wsl]\n  bootstrap: system/b.toml\n  ready: [/usr/bin/d]\n";

  expect(errors(valid)).toEqual([]);
  expect(errors(valid.replace("setting: on", "setting: yes"))).toEqual(["system.setting: must name one of the package's settings whose default is false: an office opts in"]);
  expect(errors(valid.replace("system/b.toml", "../b.toml"))).toEqual([expect.stringContaining("system.bootstrap: ")]);
  expect(errors(`${valid}  prepare: scripts/p.ts\n`)).toEqual([expect.stringContaining("system.prepare: must be a .sh file in the package")]);
  expect(errors(valid.replace("ubuntu-24.04-amd64-wsl", "Ubuntu 24.04"))).toEqual([expect.stringContaining("must be a platform such as ubuntu-24.04-amd64-wsl")]);
  expect(errors(valid.replace("/usr/bin/d", "usr/bin/d"))).toEqual([expect.stringContaining("must be an absolute path")]);
  expect(errors(`${valid}  env:\n    PATH: /bin\n`)).toEqual([expect.stringContaining("is set by office itself")]);
});

test("the built-in browser package leaves agent-browser's own Chromium alone by default, and with system_chrome sets up Google Chrome from apt", async () => {
  const browser = (settings: string) => write(join(office, "office.yaml"), `name: t\nopencode:\n  mode: host\n  url: http://127.0.0.1:49999\npackages:\n  - name: browser\n${settings}`);
  const text = () => readFileSync(join(office, ".office/mise/browser.toml"), "utf8");

  browser("");
  grantConsent(loadOffice(office));
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
  expect(JSON.parse(readFileSync(join(office, ".office/packages/browser/.settings.json"), "utf8"))).toMatchObject({ browse: false, system_chrome: true });

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
