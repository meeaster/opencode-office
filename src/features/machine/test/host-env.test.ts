import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";


import { syncLines as sync } from "../../../../test/support/sync.fixture.ts";
import { envFilePath, machineDirVariable } from "../paths.ts";
import { hostWrappers, sourcedBy, sourceLine } from "../host-env.ts";
import { globalConfD, installSfw, machineReport, miseConfigVariable, releaseMachine } from "../machine.ts";
import { grantConsent, readMachine } from "../record.ts";
import { machineRecordVariable } from "../paths.ts";
import { gatherPackages } from "../../../gather.ts";
import { loadOffice } from "../../../office.ts";
import { parseManifest } from "../../../schema.ts";
import { wrappedCommands } from "../../tools/sfw.ts";
import { configureStartup } from "../shell-startup.ts";
import { defaultPins, hostPlatform } from "../../../versions.ts";
import { definitionText, sharedToolsLock, writePackage } from "../../../../test/support/test-package.ts";
import { projectionPath } from "../../tools/applied.ts";

let dir: string;

let office: string;

const variables = [machineRecordVariable, miseConfigVariable, machineDirVariable, "HOME", "ZDOTDIR", "OFFICE_ENV_FILE", "XDG_DATA_HOME"] as const;

const saved = new Map(variables.map((name) => [name, process.env[name]]));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-host-env-"));
  office = join(dir, "office");
  process.env[machineRecordVariable] = join(dir, "record/machine.json");
  process.env[miseConfigVariable] = join(dir, "mise-config");
  process.env[machineDirVariable] = join(dir, "data");
  process.env.HOME = join(dir, "home");
  delete process.env.ZDOTDIR;
  delete process.env.OFFICE_ENV_FILE;
  // mise's shims and the default data folder follow XDG_DATA_HOME, which the temporary home replaces.
  delete process.env.XDG_DATA_HOME;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });

  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});


/** What \`office check\` says of the machine, from the office's packages as one gathering loads them. */
async function report(at: string) {
  const config = loadOffice(at);

  return machineReport(config, await gatherPackages(config, { machine: true }));
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A host-mode office with consent, a local package `demo` whose host block declares `host`, and the firewall as `firewall` says. */
function makeOffice({ firewall = true, host = "", tools = "" } = {}): void {
  write(join(office, "office.yaml"), `name: t\nopencode:\n  mode: host\n  url: http://127.0.0.1:49999\n${firewall ? tools : `tools:\n${tools.replace(/^tools:\n/, "")}  sfw: { enabled: false }\n`}packages:\n  - name: demo\n`);
  writePackage(join(office, "packages/demo/package.yaml"), host || "{}\n");
  write(join(office, "office.lock"), sharedToolsLock());
}

const data = () => join(dir, "data");

const sfwPath = () => join(dir, "data/sfw/sfw");

test("setup adds bash activation before an existing office source and doesn't prompt twice", async () => {
  const file = join(dir, "home/.bashrc");
  const original = `# eval "$(mise activate bash)"\nsource '${envFilePath()}'\n`;
  write(file, original);
  expect(await configureStartup("bash", "mise", async () => "no")).toBe(true);
  expect(readFileSync(file, "utf8")).toBe(original);
  expect(await configureStartup("bash", "mise", async () => "yes")).toBe(false);
  expect(readFileSync(file, "utf8")).toBe(original.replace("\nsource", '\neval "$(mise activate bash)"\nsource'));
  expect(await configureStartup("bash", "mise")).toBe(false);
});

test("setup follows zsh's sourced activation and updates the linked rc in ZDOTDIR", async () => {
  const folder = join(dir, "zsh");
  const linked = join(folder, "dotfile");
  process.env.ZDOTDIR = folder;
  write(join(dir, "home/tools"), 'eval "$(mise activate zsh)"\n');
  write(linked, 'source "$HOME/tools"');
  symlinkSync(linked, join(folder, ".zshrc"));
  expect(await configureStartup("zsh", "mise", async () => "yes")).toBe(false);
  expect(readFileSync(linked, "utf8")).toBe(`source "$HOME/tools"\n${sourceLine()}\n`);
  expect(await configureStartup("zsh", "mise")).toBe(false);
});

test.skipIf(hostPlatform() === undefined)("with the firewall on, sync writes the wrappers and the environment file, records each, and says sfw comes with office up", async () => {
  makeOffice();
  grantConsent(loadOffice(office));

  const changes = await sync(loadOffice(office));

  expect(changes).toContain(`wrote ${join(data(), "env.sh")}, the office's environment file; source it from your shell's startup file (office setup prints the line)`);
  expect(changes).toContain(`wrote ${join(data(), "sfw/package-manager.sh")}, the Socket Firewall wrapper script`);
  expect(changes).toContain(`linked ${join(data(), "sfw/bin/npm")} to the Socket Firewall wrapper for npm`);
  expect(changes).toContain(`Socket Firewall itself isn't installed yet, so the wrappers refuse to run downloads: office up installs sfw ${defaultPins.sfw.version}`);

  for (const command of wrappedCommands) expect(lstatSync(join(hostWrappers(), command)).isSymbolicLink()).toBe(true);

  const env = readFileSync(envFilePath(), "utf8");

  expect(env).toContain(`__office_path '${hostWrappers()}'`);
  expect(env).toContain("export NPM_CONFIG_MIN_RELEASE_AGE='3'");
  expect(await sync(loadOffice(office))).toEqual([]);

  // Until office up installs it, the wrappers refuse rather than download unchecked.
  const refused = Bun.spawnSync(["sh", "-c", "npm --version"], { env: { PATH: `${hostWrappers()}:/usr/bin:/bin` } });

  expect(refused.exitCode).toBe(127);
  expect(refused.stderr.toString()).toStartWith(`office: Socket Firewall is not installed at ${sfwPath()}`);
  expect((await report(office)).find((line) => line.name === `machine ${sfwPath()}`)).toEqual({ ok: false, name: `machine ${sfwPath()}`, detail: `not installed; office up installs sfw ${defaultPins.sfw.version}, and until then the wrappers refuse to run downloads` });
});

/** A fake sfw, and a pin whose digest on every platform is its SHA-256. */
function fakeSfw(version: string) {
  const bytes = new TextEncoder().encode(`#!/bin/sh\necho "Socket Firewall Free, version ${version}"\n`);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

  return { bytes, pin: { version, digest, platforms: { "linux-x64": digest, "linux-arm64": digest, "darwin-x64": digest, "darwin-arm64": digest } } };
}

test("office up installs sfw checked against the lock, records it, and leaves it on the next run", async () => {
  makeOffice();
  grantConsent(loadOffice(office));
  await sync(loadOffice(office));

  const { bytes, pin } = fakeSfw(defaultPins.sfw.version);
  const urls: string[] = [];

  const download = async (url: string) => {
    urls.push(url);

    return bytes;
  };

  // A download that doesn't match office.lock installs nothing.
  expect(installSfw(loadOffice(office), defaultPins.sfw, download)).rejects.toThrow("doesn't match office.lock's SHA-256; nothing was installed");
  expect(existsSync(sfwPath())).toBe(false);

  expect(await installSfw(loadOffice(office), pin, download)).toEqual([`office: installed Socket Firewall ${pin.version} in ${sfwPath()}, checked against office.lock`]);
  expect(urls.at(-1)).toStartWith(`https://github.com/SocketDev/sfw-free/releases/download/v${pin.version}/sfw-free-`);
  expect(readMachine()?.files.find((file) => file.path === sfwPath())).toEqual({ kind: "file", path: sfwPath(), package: null, sha256: pin.digest.replace("sha256:", "") });
  expect(await installSfw(loadOffice(office), pin, download)).toEqual([]);
  expect(await sync(loadOffice(office))).toEqual([]);
});

test.skipIf(hostPlatform() === undefined)("while a package doesn't load, check still checks each recorded file against the record, and sfw against office.lock", async () => {
  makeOffice();
  grantConsent(loadOffice(office));
  await sync(loadOffice(office));
  const { bytes, pin } = fakeSfw(defaultPins.sfw.version);
  await installSfw(loadOffice(office), pin, async () => bytes);
  rmSync(join(office, "packages/demo"), { recursive: true });
  writePackage(join(office, "packages/demo/office.ts"), definitionText('{setup(){throw Error("broken setup")}}'));
  const script = join(data(), "sfw/package-manager.sh");
  rmSync(envFilePath());
  write(script, "# edited\n");
  rmSync(sfwPath());
  const config = loadOffice(office);
  const gathered = await gatherPackages(config, { machine: true });
  expect(gathered.complete).toBe(false);
  // As office check passes it: no claims while the gathering is incomplete.
  const lines = machineReport(config, gathered.complete ? gathered : undefined);
  const line = (path: string) => lines.find((entry) => entry.name === `machine ${path}`);

  expect(line(envFilePath())).toEqual({ ok: false, name: `machine ${envFilePath()}`, detail: "missing since office wrote it; office sync settles it once every package loads" });
  expect(line(script)?.detail).toBe("changed since office wrote it; office leaves it: delete it, then office sync");
  expect(line(sfwPath())?.detail).toBe(`missing, so the wrappers refuse to run downloads; office up installs sfw ${defaultPins.sfw.version}`);
  expect(line(join(hostWrappers(), "npm"))).toEqual({ ok: true, name: `machine ${join(hostWrappers(), "npm")}`, detail: `links to ${join(data(), "sfw/package-manager.sh")}, as office wrote it` });
});

test("the environment file carries the office's minimum release age, and sync rewrites it when the age changes", async () => {
  makeOffice({ tools: "minimum_release_age: 36h\n" });
  grantConsent(loadOffice(office));
  await sync(loadOffice(office));

  const variables = () => Bun.spawnSync(["sh", "-c", `. '${envFilePath()}'; printf '%s|%s|%s|%s|%s' "$NPM_CONFIG_MIN_RELEASE_AGE" "$pnpm_config_minimum_release_age" "\${UV_EXCLUDE_NEWER-unset}" "\${PIP_UPLOADED_PRIOR_TO-unset}" "$MISE_MINIMUM_RELEASE_AGE"`], { env: { PATH: "/usr/bin:/bin" } }).stdout.toString();

  expect(variables()).toBe("2|2160|36 hours|P2D|36h");

  makeOffice({ tools: "minimum_release_age: 0d\n" });
  expect(await sync(loadOffice(office))).toContain(`rewrote ${envFilePath()}, the office's environment file`);
  expect(variables()).toBe("0|0|unset|unset|0d");

  // With the firewall off the ages still apply.
  makeOffice({ firewall: false });
  await sync(loadOffice(office));
  expect(variables()).toBe("3|4320|3 days|P3D|3d");
});

test("turning the firewall off removes sfw and its wrappers and rewrites the environment file; leaving host mode removes the rest", async () => {
  makeOffice();
  grantConsent(loadOffice(office));
  await sync(loadOffice(office));

  const { bytes, pin } = fakeSfw("1.16.0");

  await installSfw(loadOffice(office), pin, async () => bytes);
  makeOffice({ firewall: false });

  const changes = await sync(loadOffice(office));

  expect(changes).toContain(`removed ${sfwPath()}, as office.yaml turns Socket Firewall off`);
  expect(changes).toContain(`removed ${join(hostWrappers(), "npm")}, as office.yaml turns Socket Firewall off`);
  expect(changes).toContain(`rewrote ${envFilePath()}, the office's environment file`);
  expect(existsSync(join(data(), "sfw"))).toBe(false);
  expect(readFileSync(envFilePath(), "utf8")).not.toContain(hostWrappers());
  // demo declares no tool, and the office package's are shared tools: no machine.packages.toml to link.
  expect(readMachine()?.files.map((file) => file.path)).toEqual([envFilePath()]);

  makeOffice({ firewall: true });
  await sync(loadOffice(office));
  await installSfw(loadOffice(office), pin, async () => bytes);

  expect(releaseMachine(loadOffice(office))).toEqual(expect.arrayContaining([`removed ${sfwPath()}, as office sync --release-machine asked`, expect.stringMatching(/^office t no longer manages this machine/)]));
  expect(existsSync(join(data(), "sfw"))).toBe(false);
  expect(existsSync(envFilePath())).toBe(false);
  expect(readMachine()).toBeUndefined();
});

test("a package's host block adds folders and variables to the environment file; two packages setting one variable fail", async () => {
  makeOffice({ host: "host:\n  path: [bin, ~/.local/bin, /opt/demo/bin]\n  env:\n    DEMO_MODE: \"it's on\"\n    DEMO_PORT: 8080\n" });
  grantConsent(loadOffice(office));
  await sync(loadOffice(office));

  const env = readFileSync(envFilePath(), "utf8");

  expect(env).toContain(`__office_path '${join(office, "packages/demo/bin")}'`);
  expect(env).toContain(`__office_path '${join(dir, "home/.local/bin")}'`);
  expect(env).toContain("export DEMO_MODE='it'\\''s on'\nexport DEMO_PORT='8080'\n");

  const sourced = Bun.spawnSync(["sh", "-c", `. '${envFilePath()}'; printf '%s|%s' "$PATH" "$DEMO_MODE"`], { env: { PATH: "/usr/bin:/bin" } }).stdout.toString();

  expect(sourced).toBe(`${hostWrappers()}:${projectionPath(loadOffice(office))}:${join(process.env.MISE_DATA_DIR || join(dir, "home/.local/share/mise"), "shims")}:${join(dir, "home/.opencode/bin")}:${join(office, "packages/demo/bin")}:${join(dir, "home/.local/bin")}:/opt/demo/bin:/usr/bin:/bin|it's on`);

  const manifest = join(office, "packages/demo/package.json");
  const json = readFileSync(manifest, "utf8");
  write(manifest, "{");
  expect((await sync(loadOffice(office))).join("\n")).toContain("FAILED package demo: package.json: JSON Parse error");
  expect(readFileSync(envFilePath(), "utf8")).toBe(env);
  write(manifest, json);

  write(join(office, "office.yaml"), `${readFileSync(join(office, "office.yaml"), "utf8")}  - name: other\n`);
  writePackage(join(office, "packages/other/package.yaml"), "host:\n  env:\n    DEMO_MODE: off\n");

  expect(await sync(loadOffice(office))).toContain(`FAILED packages demo and other both set DEMO_MODE in their host or system block, so ${envFilePath()} sets neither; remove it from one`);
  expect(readFileSync(envFilePath(), "utf8")).not.toContain("DEMO_MODE");
});

test("a package that fails to read stops sync: a deselected package's machine inputs stay with everyone else's", async () => {
  const host = (name: string) => `host:\n  path: [${name}-bin]\n  env: { ${name.toUpperCase()}_MODE: ok }\n  install: {description: Install, creates: ~/.local/bin/${name}, script: install.ts}\n`;
  makeOffice({ firewall: false, host: host("demo") });
  const config = join(office, "office.yaml");
  const initial = readFileSync(config, "utf8");
  write(config, `${initial}  - name: other\n`);
  writePackage(join(office, "packages/other/package.yaml"), `${host("other")}`);

  for (const name of ["demo", "other"]) write(join(office, `packages/${name}/install.ts`), "");
  grantConsent(loadOffice(office));
  const run = () => sync(loadOffice(office), { scope: "packages" });
  expect((await run()).join("\n")).not.toContain("FAILED");
  const link = (name: string) => join(globalConfD(), `office-t-1-${name}.toml`);
  const before = readFileSync(link("demo"), "utf8");
  expect(readFileSync(link("other"), "utf8")).toContain("other:install");
  expect(readFileSync(envFilePath(), "utf8")).toContain("OTHER_MODE");
  write(config, initial);
  writePackage(join(office, "packages/demo/package.yaml"), "[bad");
  const env = readFileSync(envFilePath(), "utf8");
  expect((await run()).join("\n")).toContain("FAILED package demo");
  expect(readFileSync(link("demo"), "utf8")).toBe(before);
  expect(readFileSync(link("other"), "utf8")).toContain("other:install");
  expect(existsSync(join(office, ".office/mise/other.toml"))).toBe(true);
  expect(readFileSync(envFilePath(), "utf8")).toBe(env);
  // Fixed, the next sync withdraws the deselected package's inputs.
  writePackage(join(office, "packages/demo/package.yaml"), host("demo"));
  expect((await run()).join("\n")).not.toContain("FAILED");
  expect(lstatSync(link("other"), { throwIfNoEntry: false })).toBeUndefined();
  expect(readFileSync(envFilePath(), "utf8")).not.toContain("OTHER_MODE");
  expect(readFileSync(envFilePath(), "utf8")).toContain("export DEMO_MODE='ok'");
});

test("a host block's folders and variables are plain: no shell code, PATH separators or variables office sets", () => {
  const errors = (host: string) => {
    const result = parseManifest("bad", Bun.YAML.parse(`host:\n${host}`));

    return result.ok ? [] : result.errors;
  };

  expect(errors("  path: [\"$HOME/bin\"]\n")).toEqual([expect.stringContaining("host.path[0]: must be a folder such as ~/.local/bin")]);
  expect(errors("  path: [\"a:b\"]\n")).toHaveLength(1);
  expect(errors("  path: [../elsewhere]\n")).toEqual(["host.path[0]: must not climb out with .."]);
  expect(errors("  env:\n    PATH: /bin\n")).toEqual([expect.stringContaining("is set by office itself")]);
  expect(errors("  env:\n    MISE_MINIMUM_RELEASE_AGE: 1h\n")).toEqual([expect.stringContaining("is set by office itself")]);
  expect(errors("  env:\n    OFFICE_X: y\n")).toHaveLength(1);
  expect(errors("  env:\n    \"A B\": y\n")).toEqual([expect.stringContaining("must be an environment variable name")]);
  expect(errors("  env:\n    MULTI: \"a\\nb\"\n")).toEqual([expect.stringContaining("must be one line of plain text")]);
  expect(errors("  path: [bin, ~/x, /opt/y]\n  env:\n    OK: \"$not expanded`\"\n")).toEqual([]);
});

test("check finds the line that sources the environment file through a linked startup file, or a file it sources, or the shell's own variable", () => {
  const home = join(dir, "home");
  const dotfiles = join(dir, "dotfiles");

  expect(sourceLine()).toBe(`[ -r '${envFilePath()}' ] && . '${envFilePath()}'`);
  expect(sourcedBy()).toBeUndefined();

  // ~/.zshrc is a link into a dotfiles repository, which sources another file that names it.
  write(join(dotfiles, "zshrc"), `# . ${envFilePath()} is commented here\nsource ~/.config/zsh/office.zsh\n`);
  mkdirSync(home, { recursive: true });
  symlinkSync(join(dotfiles, "zshrc"), join(home, ".zshrc"));

  expect(sourcedBy()).toBeUndefined();

  write(join(home, ".config/zsh/office.zsh"), `${sourceLine()}\n`);
  expect(sourcedBy()).toBe(`${join(home, ".config/zsh/office.zsh")}, which ${join(home, ".zshrc")} sources`);

  write(join(dotfiles, "zshrc"), `${sourceLine()}\n`);
  expect(sourcedBy()).toBe(join(home, ".zshrc"));

  rmSync(join(home, ".zshrc"));
  process.env.OFFICE_ENV_FILE = envFilePath();
  expect(sourcedBy()).toBe("this shell's environment (OFFICE_ENV_FILE)");
});
