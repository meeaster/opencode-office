import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import * as v from "valibot";

import { sync } from "./commands/sync.ts";
import { envFilePath, hostWrappers, machineDirVariable, sourcedBy, sourceLine } from "./host-env.ts";
import { globalConfD, grantConsent, installSfw, machineRecordVariable, machineReport, miseConfigVariable, readMachine, releaseMachine } from "./machine.ts";
import { loadOffice } from "./office.ts";
import { check, packageManifestSchema } from "./schema.ts";
import { wrappedCommands } from "./sfw.ts";
import { defaultPins, hostPlatform } from "./versions.ts";

let dir: string;

let office: string;

const variables = [machineRecordVariable, miseConfigVariable, machineDirVariable, "HOME", "ZDOTDIR", "OFFICE_ENV_FILE"] as const;

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
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });

  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A host-mode office with consent, a local package `demo` whose host block declares `host`, and the firewall as `firewall` says. */
function makeOffice({ firewall = true, host = "" } = {}): void {
  write(join(office, "office.yaml"), `name: t\nopencode:\n  mode: host\n  url: http://127.0.0.1:49999\n${firewall ? "" : "socket_firewall: false\n"}packages:\n  - name: demo\n`);
  write(join(office, "packages/demo/package.yaml"), `name: demo\ndescription: A demo package.\n${host}`);
}

const data = () => join(dir, "data");

const sfwPath = () => join(dir, "data/sfw/sfw");

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
  expect(machineReport(loadOffice(office)).find((line) => line.name === `machine ${sfwPath()}`)).toEqual({ ok: false, name: `machine ${sfwPath()}`, detail: `not installed; office up installs sfw ${defaultPins.sfw.version}, and until then the wrappers refuse to run downloads` });
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

test("turning the firewall off removes sfw and its wrappers and rewrites the environment file; leaving host mode removes the rest", async () => {
  makeOffice();
  grantConsent(loadOffice(office));
  await sync(loadOffice(office));

  const { bytes, pin } = fakeSfw("1.16.0");

  await installSfw(loadOffice(office), pin, async () => bytes);
  makeOffice({ firewall: false });

  const changes = await sync(loadOffice(office));

  expect(changes).toContain(`removed ${sfwPath()}, as office.yaml sets socket_firewall: false`);
  expect(changes).toContain(`removed ${join(hostWrappers(), "npm")}, as office.yaml sets socket_firewall: false`);
  expect(changes).toContain(`rewrote ${envFilePath()}, the office's environment file`);
  expect(existsSync(join(data(), "sfw"))).toBe(false);
  expect(readFileSync(envFilePath(), "utf8")).not.toContain(hostWrappers());
  expect(readMachine()?.files.map((file) => file.path)).toEqual([join(globalConfD(), "office-t-0-office.toml"), envFilePath()]);

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

  expect(sourced).toBe(`${hostWrappers()}:${join(process.env.MISE_DATA_DIR || join(dir, "home/.local/share/mise"), "shims")}:${join(dir, "home/.opencode/bin")}:${join(office, "packages/demo/bin")}:${join(dir, "home/.local/bin")}:/opt/demo/bin:/usr/bin:/bin|it's on`);

  write(join(office, "office.yaml"), `${readFileSync(join(office, "office.yaml"), "utf8")}  - name: other\n`);
  write(join(office, "packages/other/package.yaml"), "name: other\ndescription: Another.\nhost:\n  env:\n    DEMO_MODE: off\n");

  expect(await sync(loadOffice(office))).toContain(`FAILED packages demo and other both set DEMO_MODE in their host block, so ${envFilePath()} sets neither; remove it from one`);
  expect(readFileSync(envFilePath(), "utf8")).not.toContain("DEMO_MODE");
});

test("a host block's folders and variables are plain: no shell code, PATH separators or variables office sets", () => {
  const errors = (host: string) => {
    const result = check(v.safeParse(packageManifestSchema, Bun.YAML.parse(`name: bad\ndescription: Bad.\nhost:\n${host}`)));

    return result.ok ? [] : result.errors;
  };

  expect(errors("  path: [\"$HOME/bin\"]\n")).toEqual([expect.stringContaining("host.path[0]: must be a folder such as ~/.local/bin")]);
  expect(errors("  path: [\"a:b\"]\n")).toHaveLength(1);
  expect(errors("  path: [../elsewhere]\n")).toEqual(["host.path[0]: must not climb out with .."]);
  expect(errors("  env:\n    PATH: /bin\n")).toEqual([expect.stringContaining("is set by office itself")]);
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
