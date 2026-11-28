import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { machineFixture, makeOffice, reportMachine as report } from "../../../../test/support/machine.fixture.ts";
import { syncLines as sync } from "../../../../test/support/sync.fixture.ts";
import { loadOffice, readConfig } from "../../../office.ts";
import { grantConsent, readMachine } from "../../machine/record.ts";

const fixture = machineFixture();
const links = () => (existsSync(fixture.confD) ? readdirSync(fixture.confD).sort() : []);

test("with consent, sync links machine.packages.toml first, each fragment, machine.toml last, records them, and a second sync changes nothing", async () => {
  const { office, dir, confD } = fixture;

  makeOffice(office);
  grantConsent(loadOffice(office), "");

  const changes = await sync(loadOffice(office));

  expect(changes).toContain(`linked ${confD}/office-t-1-demo.toml to .office/mise/demo.toml (package demo), so its setup applies in every folder on this machine`);
  expect(changes).toContain(`linked ${confD}/office-t-2-machine.toml to machine.toml (the office's own), so its tools apply in every folder on this machine`);
  // mise loads conf.d by name and the last wins: the packages' tools first, then their setup, and machine.toml last, so it wins over the packages' versions.
  expect(changes).toContain(`linked ${confD}/office-t-0-packages.toml to machine.packages.toml (the packages' tools), so its tools apply in every folder on this machine`);
  expect(links()).toEqual(["office-t-0-packages.toml", "office-t-1-demo.toml", "office-t-2-machine.toml"]);
  expect(readlinkSync(join(confD, "office-t-2-machine.toml"))).toBe(join(office, "machine.toml"));
  // The office package has tools only, so no fragment of its own.
  expect(existsSync(join(office, ".office/mise/office.toml"))).toBe(false);
  expect(readMachine()).toEqual({
    office: { name: "t", dir: office },
    consented: expect.any(String),
    files: [
      { kind: "link", path: join(confD, "office-t-0-packages.toml"), package: null, target: join(office, "machine.packages.toml") },
      { kind: "link", path: join(confD, "office-t-1-demo.toml"), package: "demo", target: join(office, ".office/mise/demo.toml") },
      { kind: "link", path: join(confD, "office-t-2-machine.toml"), package: null, target: join(office, "machine.toml") },
      { kind: "file", path: join(dir, "data/env.sh"), package: null, sha256: expect.stringMatching(/^[0-9a-f]{64}$/), contributions: [] },
    ],
  });
  expect(await sync(loadOffice(office))).toEqual([]);
  expect((await report(office)).map((line) => line.ok)).toEqual([true, true, true, true, true]);
});

test("removing a package removes its link; leaving host mode removes them all and the record", async () => {
  const { office, dir, confD } = fixture;

  makeOffice(office);
  grantConsent(loadOffice(office), "");
  await sync(loadOffice(office));
  makeOffice(office, { packages: "" });

  expect(await sync(loadOffice(office))).toContain(`removed ${confD}/office-t-1-demo.toml, as package demo no longer has a fragment`);
  // The office package's tools are shared tools, so with demo gone no package has a tool in machine.packages.toml.
  expect(links()).toEqual(["office-t-2-machine.toml"]);
  expect(readMachine()?.files.map((file) => file.package)).toEqual([null, null]);

  makeOffice(office, { opencode: "opencode: container\n" });

  const changes = await sync(loadOffice(office));

  expect(changes).toContain(`removed ${confD}/office-t-2-machine.toml, as the office now runs OpenCode in its container`);
  expect(changes).toContain(`removed ${join(dir, "data/env.sh")}, as the office now runs OpenCode in its container`);
  expect(changes).toEqual(expect.arrayContaining([expect.stringMatching(/^office t no longer manages this machine/)]));
  expect(links()).toEqual([]);
  expect(readMachine()).toBeUndefined();
  expect(await report(office)).toEqual([]);
});

test("sync never replaces a path the record doesn't list, and check reports dangling and hand-edited links", async () => {
  const { office, dir, confD } = fixture;

  makeOffice(office);
  grantConsent(loadOffice(office), "");
  mkdirSync(confD, { recursive: true });
  writeFileSync(join(confD, "office-t-1-demo.toml"), "# someone else's\n");

  expect(await sync(loadOffice(office))).toContain(`FAILED to link .office/mise/demo.toml (package demo): ${confD}/office-t-1-demo.toml exists and ${join(dir, "record/machine.json")} doesn't list it, so office leaves it; move it away and run office sync`);
  expect(readFileSync(join(confD, "office-t-1-demo.toml"), "utf8")).toBe("# someone else's\n");
  expect((await report(office)).find((line) => line.name.endsWith("office-t-1-demo.toml"))?.detail).toStartWith("exists but isn't in the record");

  rmSync(join(confD, "office-t-1-demo.toml"));
  await sync(loadOffice(office));

  // Hand-edited: the link points somewhere else. Dangling: its target is gone.
  unlinkSync(join(confD, "office-t-1-demo.toml"));
  symlinkSync(join(dir, "elsewhere.toml"), join(confD, "office-t-1-demo.toml"));
  rmSync(join(office, "machine.toml"));

  const lines = await report(office);

  expect(lines.find((line) => line.name.endsWith("office-t-1-demo.toml"))).toEqual({ ok: false, name: `machine ${confD}/office-t-1-demo.toml`, detail: `changed since office wrote it to ${join(office, ".office/mise/demo.toml")}; office leaves it: delete it, then office sync` });
  expect(lines.find((line) => line.name.endsWith("office-t-2-machine.toml"))?.detail).toStartWith(`dangling: ${join(office, "machine.toml")} is gone, so mise skips it silently; office sync removes it`);

  const changes = await sync(loadOffice(office));

  expect(changes).toContain(`removed ${confD}/office-t-2-machine.toml, as machine.toml is gone`);
  expect(changes).toEqual(expect.arrayContaining([expect.stringMatching(/^FAILED to link .office\/mise\/demo.toml \(package demo\): .* changed since office wrote it/)]));
  expect(lstatSync(join(confD, "office-t-1-demo.toml")).isSymbolicLink() && readlinkSync(join(confD, "office-t-1-demo.toml"))).toBe(join(dir, "elsewhere.toml"));
});

test("machine, config and mise are reserved package names", () => {
  const { office } = fixture;

  for (const name of ["machine", "config", "mise"]) {
    makeOffice(office, { packages: `packages:\n  - name: ${name}\n` });

    expect(() => readConfig(office)).toThrow("is reserved: machine.toml at the office root is the office's own machine-wide mise file, and mise would load .office/mise/config.toml or mise.toml by itself");
  }
});
