import { expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { machineFixture, makeEnvironmentOffice as makeOffice, reportMachine as report, write } from "../../../../test/support/machine.fixture.ts";
import { syncLines as sync } from "../../../../test/support/sync.fixture.ts";
import { definitionText, writePackage } from "../../../../test/support/test-package.ts";
import { gatherPackages } from "../../../gather.ts";
import { sha256 } from "../../../lib/hash.ts";
import { loadOffice } from "../../../office.ts";
import { defaultPins, hostPlatform } from "../../../versions.ts";
import { machineReport, releaseMachine } from "../../machine/owned-files.ts";
import { envFilePath } from "../../machine/paths.ts";
import { machineReconciliation } from "../../machine/plan.ts";
import { grantConsent, readMachine } from "../../machine/record.ts";
import { installSfw } from "../firewall.ts";
import { hostWrappers, wrappedCommands } from "../sfw.ts";

const fixture = machineFixture({ scratchHome: true });
const data = () => join(fixture.dir, "data");
const sfwPath = () => join(data(), "sfw/sfw");

test.skipIf(hostPlatform() === undefined)("with the firewall on, sync writes the wrappers and the environment file, records each, and says sfw comes with office up", async () => {
  const { office } = fixture;

  makeOffice(office);
  grantConsent(loadOffice(office), "");

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
  const digest = `sha256:${sha256(bytes)}`;

  return { bytes, pin: { version, digest, platforms: { "linux-x64": digest, "linux-arm64": digest, "darwin-x64": digest, "darwin-arm64": digest } } };
}

test("office up installs sfw checked against the lock, records it, and leaves it on the next run", async () => {
  const { office } = fixture;

  makeOffice(office);
  grantConsent(loadOffice(office), "");
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
  const { office } = fixture;

  makeOffice(office);
  grantConsent(loadOffice(office), "");
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
  const lines = machineReport(config, machineReconciliation, gathered.complete ? gathered : undefined);
  const line = (path: string) => lines.find((entry) => entry.name === `machine ${path}`);

  expect(line(envFilePath())).toEqual({ ok: false, name: `machine ${envFilePath()}`, detail: "missing since office wrote it; office sync settles it once every package loads" });
  expect(line(script)?.detail).toBe("changed since office wrote it; office leaves it: delete it, then office sync");
  expect(line(sfwPath())?.detail).toBe(`missing, so the wrappers refuse to run downloads; office up installs sfw ${defaultPins.sfw.version}`);
  expect(line(join(hostWrappers(), "npm"))).toEqual({ ok: true, name: `machine ${join(hostWrappers(), "npm")}`, detail: `links to ${join(data(), "sfw/package-manager.sh")}, as office wrote it` });
});

test("turning the firewall off removes sfw and its wrappers and rewrites the environment file; leaving host mode removes the rest", async () => {
  const { office } = fixture;

  makeOffice(office);
  grantConsent(loadOffice(office), "");
  await sync(loadOffice(office));

  const { bytes, pin } = fakeSfw("1.16.0");

  await installSfw(loadOffice(office), pin, async () => bytes);
  makeOffice(office, { firewall: false });

  const changes = await sync(loadOffice(office));

  expect(changes).toContain(`removed ${sfwPath()}, as office.yaml turns Socket Firewall off`);
  expect(changes).toContain(`removed ${join(hostWrappers(), "npm")}, as office.yaml turns Socket Firewall off`);
  expect(changes).toContain(`rewrote ${envFilePath()}, the office's environment file`);
  expect(existsSync(join(data(), "sfw"))).toBe(false);
  expect(readFileSync(envFilePath(), "utf8")).not.toContain(hostWrappers());
  // demo declares no tool, and the office package's are shared tools: no machine.packages.toml to link.
  expect(readMachine()?.files.map((file) => file.path)).toEqual([envFilePath()]);

  makeOffice(office, { firewall: true });
  await sync(loadOffice(office));
  await installSfw(loadOffice(office), pin, async () => bytes);

  expect(releaseMachine(loadOffice(office), machineReconciliation)).toEqual(expect.arrayContaining([`removed ${sfwPath()}, as office sync --release-machine asked`, expect.stringMatching(/^office t no longer manages this machine/)]));
  expect(existsSync(join(data(), "sfw"))).toBe(false);
  expect(existsSync(envFilePath())).toBe(false);
  expect(readMachine()).toBeUndefined();
});
