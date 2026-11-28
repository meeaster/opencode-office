import { expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { machineFixture, makeOffice, reportMachine as report, write } from "../../../../test/support/machine.fixture.ts";
import { syncLines as sync } from "../../../../test/support/sync.fixture.ts";
import { changeText } from "../../../lib/change.ts";
import { loadOffice, OfficeError } from "../../../office.ts";
import { releaseMachine, syncMachine } from "../owned-files.ts";
import { machineReconciliation } from "../plan.ts";
import { envFilePath, machineRecordPath } from "../paths.ts";
import { claim, grantConsent, readMachine, serviceEnvironment } from "../record.ts";

const fixture = machineFixture();
const links = () => (existsSync(fixture.confD) ? readdirSync(fixture.confD).sort() : []);

test("without consent, sync writes nothing outside the office and says what to run; check fails, as the office's tools apply nowhere", async () => {
  const { office, dir, confD } = fixture;

  makeOffice(office);

  const changes = await sync(loadOffice(office));

  expect(changes).toContain(`not linking machine.toml, machine.packages.toml and .office/mise/ into ${confD} or writing ${join(dir, "data/env.sh")} yet, so the office's tools apply nowhere: office writes outside its folder only once you agree; run office setup (unattended: office setup --manage-machine)`);
  expect(existsSync(join(dir, "data"))).toBe(false);
  expect(existsSync(confD)).toBe(false);
  expect(readMachine()).toBeUndefined();
  expect(await report(office)).toEqual([{ ok: false, name: "machine", detail: expect.stringContaining(`no consent for this office to manage this machine, so machine.toml and the packages' tools in machine.packages.toml apply nowhere and ${join(dir, "data/env.sh")} isn't written; run office setup`) }]);
});

test("office sync --release-machine removes everything and the consent, keeping a file changed by hand", async () => {
  const { office, confD } = fixture;

  makeOffice(office);
  grantConsent(loadOffice(office), "");
  await sync(loadOffice(office));
  unlinkSync(join(confD, "office-t-1-demo.toml"));
  writeFileSync(join(confD, "office-t-1-demo.toml"), "# mine now\n");

  const first = releaseMachine(loadOffice(office), machineReconciliation).map(changeText);

  expect(first).toContain(`FAILED to remove ${confD}/office-t-1-demo.toml: it changed since office wrote it, so it stays; delete it yourself`);
  expect(links()).toEqual(["office-t-1-demo.toml"]);
  expect(readMachine()?.files.map((file) => file.path)).toEqual([join(confD, "office-t-1-demo.toml")]);

  rmSync(join(confD, "office-t-1-demo.toml"));

  expect(releaseMachine(loadOffice(office), machineReconciliation)).toEqual([expect.stringMatching(/^office t no longer manages this machine/)]);
  expect(readMachine()).toBeUndefined();
  expect(await sync(loadOffice(office))).toEqual(expect.arrayContaining([expect.stringMatching(/^not linking/)]));
  expect(links()).toEqual([]);
});

test("a second host-mode office is refused, naming the one that manages the machine", async () => {
  const { office, dir } = fixture;

  makeOffice(office);
  grantConsent(loadOffice(office), "");
  await sync(loadOffice(office));

  const other = join(dir, "other");

  makeOffice(other, { name: "u" });

  expect(() => grantConsent(loadOffice(other), "")).toThrow(OfficeError);
  expect(await sync(loadOffice(other))).toEqual(expect.arrayContaining([expect.stringContaining(`FAILED to link this office's tools on the machine: this machine is managed by office t in ${office}`)]));
  expect(await report(other)).toEqual([{ ok: false, name: "machine", detail: expect.stringContaining("managed by office t") }]);
  expect(links()).toEqual(["office-t-1-demo.toml", "office-t-2-machine.toml"]);

  // A copy of the same office beside it is another office too.
  const copy = join(dir, "copy");

  makeOffice(copy);

  expect(claim(loadOffice(copy)).kind).toBe("other");
});

test("an office that moved takes its record along and relinks its tools", async () => {
  const { office, dir, confD } = fixture;

  makeOffice(office);
  grantConsent(loadOffice(office), "");
  await sync(loadOffice(office));

  const moved = join(dir, "moved");

  renameSync(office, moved);

  expect((await report(moved)).map((line) => [line.ok, line.detail.split(";")[0]])).toEqual([
    [false, `the record names ${office}, where this office was`],
    [false, `dangling: ${join(office, ".office/mise/demo.toml")} is gone, so mise skips it silently`],
    [false, `dangling: ${join(office, "machine.toml")} is gone, so mise skips it silently`],
    [true, "written: the office's environment file"],
  ]);

  const changes = await sync(loadOffice(moved));

  expect(changes).toContain(`office t moved from ${office}; ${join(dir, "record/machine.json")} now names ${moved}`);
  expect(changes).toContain(`relinked ${confD}/office-t-1-demo.toml to .office/mise/demo.toml (package demo)`);
  expect(readlinkSync(join(confD, "office-t-2-machine.toml"))).toBe(join(moved, "machine.toml"));
  expect(readMachine()?.office).toEqual({ name: "t", dir: moved });
  expect((await report(moved)).every((line) => line.ok === true)).toBe(true);
});

test("syncMachine does nothing for a container-mode office that doesn't manage the machine", async () => {
  const { office } = fixture;

  makeOffice(office, { opencode: "opencode: container\n" });

  expect(syncMachine(loadOffice(office), machineReconciliation)).toEqual([]);
  expect(await report(office)).toEqual([]);
});

test("a service can load only the verified environment of the office that installed it", () => {
  const { office: dir } = fixture;

  makeOffice(dir);
  const office = loadOffice(dir);
  const record = machineRecordPath();
  const file = envFilePath();

  write(file, "echo foreign");
  expect(serviceEnvironment(office)).toBe("");
  grantConsent(office, "");
  expect(statSync(record).mode & 0o777).toBe(0o600);
  expect(() => serviceEnvironment(office)).toThrow("unrecorded");
  rmSync(file);
  syncMachine(office, machineReconciliation, { unread: new Set(), packages: [] });
  expect(serviceEnvironment(office)).toContain("export MISE_MINIMUM_RELEASE_AGE=");
  expect(serviceEnvironment({ ...office, dir: join(dir, "other") })).toBe("");

  for (const path of [record, file]) {
    chmodSync(path, 0o660);
    expect(() => serviceEnvironment(office)).toThrow("permission");
    chmodSync(path, 0o600);
    renameSync(path, `${path}.saved`);
    symlinkSync(`${path}.saved`, path);
    expect(() => serviceEnvironment(office)).toThrow("symlinks");
    renameSync(`${path}.saved`, path);
  }

  const original = readFileSync(record, "utf8");

  writeFileSync(record, "broken record");
  expect(() => serviceEnvironment(office)).toThrow("not JSON");
  writeFileSync(record, original.replace(/"sha256": "[a-f0-9]{64}"/g, `"sha256": "${"0".repeat(64)}"`));
  expect(() => serviceEnvironment(office)).toThrow("changed");
  writeFileSync(record, original);
  writeFileSync(file, "echo replaced");
  expect(() => serviceEnvironment(office)).toThrow("changed");
});
