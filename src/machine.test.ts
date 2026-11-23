import { changeText } from "./change.ts";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { syncLines as sync } from "./sync.fixture.ts";
import { machineDirVariable } from "./host-env.ts";
import { serverUnit, serverUnitPath } from "./host-server.ts";
import { claim, grantConsent, machineRecordVariable, machineReport, matchesServerUnit, miseConfigVariable, readMachine, releaseMachine, syncMachine, writeServerUnit } from "./machine.ts";
import { gatherPackages } from "./gather.ts";
import { loadOffice, OfficeError, readConfig } from "./office.ts";
import { writePackage } from "./test-package.ts";

let dir: string;

let office: string;

let confD: string;

const saved = { record: process.env[machineRecordVariable], mise: process.env[miseConfigVariable], data: process.env[machineDirVariable] };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-machine-"));
  office = join(dir, "office");
  confD = join(dir, "mise-config/conf.d");
  process.env[machineRecordVariable] = join(dir, "record/machine.json");
  process.env[miseConfigVariable] = join(dir, "mise-config");
  process.env[machineDirVariable] = join(dir, "data");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });

  for (const [key, value] of [[machineRecordVariable, saved.record], [miseConfigVariable, saved.mise], [machineDirVariable, saved.data]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
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

const host = "opencode:\n  mode: host\n  url: http://127.0.0.1:49999\n";

/**
 * An office `name` at `at` in `mode`, with a local package `demo` that declares jq and, in host mode,
 * a host install (so it has a fragment), and the office's own machine.toml. Socket Firewall is off unless `firewall`, so tests of the links see only them
 * and the environment file.
 */
function makeOffice(at: string, { name = "t", opencode = host, packages = "packages:\n  - name: demo\n", firewall = false } = {}): void {
  write(join(at, "office.yaml"), `name: ${name}\n${opencode}${firewall ? "" : "tools:\n  sfw: { enabled: false }\n"}${packages}`);
  writePackage(join(at, "packages/demo/package.yaml"), '# A demo package.\ntools:\n  jq: "1.7.1"\nhost:\n  install:\n    description: Demo\n    creates: ~/.local/bin/demo\n    script: scripts/install.ts\n');
  write(join(at, "machine.toml"), '# The office\'s own.\n[tools]\njq = "1.8.0"\n');
}

const links = () => (existsSync(confD) ? readdirSync(confD).sort() : []);

test("the managed server unit needs consent and a recorded env.sh, and is not overwritten when edited", async () => {
  makeOffice(office, { name: "test-server-record", opencode: `${host}  managed: true\n` });

  const config = loadOffice(office);

  const plan = {
    unit: serverUnit(config), path: serverUnitPath(config),
    program: "/path/to/opencode", revision: "test", text: "# managed unit fixture\n", hasSecrets: false,
  };

  expect(() => writeServerUnit(config, plan)).toThrow("requires consent");
  grantConsent(config);
  expect(() => writeServerUnit(config, plan)).toThrow("recorded environment file");
  syncMachine(config, await gatherPackages(config, { machine: true }));
  write(plan.path, "# somebody else's unit\n");
  expect(() => writeServerUnit(config, plan)).toThrow("not in the machine record");
  unlinkSync(plan.path);

  expect(writeServerUnit(config, plan)).toBe(true);
  expect(writeServerUnit(config, plan)).toBe(false);
  expect(matchesServerUnit(config, plan)).toBe(true);
  expect(syncMachine(config, await gatherPackages(config, { machine: true }))).toEqual([]);
  expect(matchesServerUnit(config, plan)).toBe(true);

  write(plan.path, "# edited\n");
  expect(matchesServerUnit(config, plan)).toBe(false);
  expect(() => writeServerUnit(config, plan)).toThrow("changed since office wrote it");
  expect(releaseMachine(config).map(changeText).join("\n")).toContain(`FAILED to remove ${plan.path}`);
  expect(readFileSync(plan.path, "utf8")).toBe("# edited\n");
  unlinkSync(plan.path);
});

test("without consent, sync writes nothing outside the office and says what to run; check fails, as the office's tools apply nowhere", async () => {
  makeOffice(office);

  const changes = await sync(loadOffice(office));

  expect(changes).toContain(`not linking machine.toml, machine.packages.toml and .office/mise/ into ${confD} or writing ${join(dir, "data/env.sh")} yet, so the office's tools apply nowhere: office writes outside its folder only once you agree; run office setup (unattended: office setup --manage-machine)`);
  expect(existsSync(join(dir, "data"))).toBe(false);
  expect(existsSync(confD)).toBe(false);
  expect(readMachine()).toBeUndefined();
  expect(await report(office)).toEqual([{ ok: false, name: "machine", detail: expect.stringContaining(`no consent for this office to manage this machine, so machine.toml and the packages' tools in machine.packages.toml apply nowhere and ${join(dir, "data/env.sh")} isn't written; run office setup`) }]);
});

test("with consent, sync links machine.packages.toml first, each fragment, machine.toml last, records them, and a second sync changes nothing", async () => {
  makeOffice(office);
  grantConsent(loadOffice(office));

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
  makeOffice(office);
  grantConsent(loadOffice(office));
  await sync(loadOffice(office));
  makeOffice(office, { packages: "" });

  expect(await sync(loadOffice(office))).toContain(`removed ${confD}/office-t-1-demo.toml, as package demo no longer has a fragment`);
  expect(links()).toEqual(["office-t-0-packages.toml", "office-t-2-machine.toml"]);
  expect(readMachine()?.files.map((file) => file.package)).toEqual([null, null, null]);

  makeOffice(office, { opencode: "opencode: container\n" });

  const changes = await sync(loadOffice(office));

  expect(changes).toContain(`removed ${confD}/office-t-2-machine.toml, as the office now runs OpenCode in its container`);
  expect(changes).toContain(`removed ${join(dir, "data/env.sh")}, as the office now runs OpenCode in its container`);
  expect(changes).toEqual(expect.arrayContaining([expect.stringMatching(/^office t no longer manages this machine/)]));
  expect(links()).toEqual([]);
  expect(readMachine()).toBeUndefined();
  expect(await report(office)).toEqual([]);
});

test("office sync --release-machine removes everything and the consent, keeping a file changed by hand", async () => {
  makeOffice(office);
  grantConsent(loadOffice(office));
  await sync(loadOffice(office));
  unlinkSync(join(confD, "office-t-1-demo.toml"));
  writeFileSync(join(confD, "office-t-1-demo.toml"), "# mine now\n");

  const first = releaseMachine(loadOffice(office)).map(changeText);

  expect(first).toContain(`FAILED to remove ${confD}/office-t-1-demo.toml: it changed since office wrote it, so it stays; delete it yourself`);
  expect(links()).toEqual(["office-t-1-demo.toml"]);
  expect(readMachine()?.files.map((file) => file.path)).toEqual([join(confD, "office-t-1-demo.toml")]);

  rmSync(join(confD, "office-t-1-demo.toml"));

  expect(releaseMachine(loadOffice(office))).toEqual([expect.stringMatching(/^office t no longer manages this machine/)]);
  expect(readMachine()).toBeUndefined();
  expect(await sync(loadOffice(office))).toEqual(expect.arrayContaining([expect.stringMatching(/^not linking/)]));
  expect(links()).toEqual([]);
});

test("a second host-mode office is refused, naming the one that manages the machine", async () => {
  makeOffice(office);
  grantConsent(loadOffice(office));
  await sync(loadOffice(office));

  const other = join(dir, "other");

  makeOffice(other, { name: "u" });

  expect(() => grantConsent(loadOffice(other))).toThrow(OfficeError);
  expect(await sync(loadOffice(other))).toEqual(expect.arrayContaining([expect.stringContaining(`FAILED to link this office's tools on the machine: this machine is managed by office t in ${office}`)]));
  expect(await report(other)).toEqual([{ ok: false, name: "machine", detail: expect.stringContaining("managed by office t") }]);
  expect(links()).toEqual(["office-t-0-packages.toml", "office-t-1-demo.toml", "office-t-2-machine.toml"]);

  // A copy of the same office beside it is another office too.
  const copy = join(dir, "copy");

  makeOffice(copy);

  expect(claim(loadOffice(copy)).kind).toBe("other");
});

test("an office that moved takes its record along and relinks its tools", async () => {
  makeOffice(office);
  grantConsent(loadOffice(office));
  await sync(loadOffice(office));

  const moved = join(dir, "moved");

  renameSync(office, moved);

  expect((await report(moved)).map((line) => [line.ok, line.detail.split(";")[0]])).toEqual([
    [false, `the record names ${office}, where this office was`],
    [false, `dangling: ${join(office, "machine.packages.toml")} is gone, so mise skips it silently`],
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

test("sync never replaces a path the record doesn't list, and check reports dangling and hand-edited links", async () => {
  makeOffice(office);
  grantConsent(loadOffice(office));
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

test("syncMachine does nothing for a container-mode office that doesn't manage the machine", async () => {
  makeOffice(office, { opencode: "opencode: container\n" });

  expect(syncMachine(loadOffice(office))).toEqual([]);
  expect(await report(office)).toEqual([]);
});

test("machine, config and mise are reserved package names", () => {
  for (const name of ["machine", "config", "mise"]) {
    makeOffice(office, { packages: `packages:\n  - name: ${name}\n` });

    expect(() => readConfig(office)).toThrow("is reserved: machine.toml at the office root is the office's own machine-wide mise file, and mise would load .office/mise/config.toml or mise.toml by itself");
  }
});

