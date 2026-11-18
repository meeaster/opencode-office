import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { sync } from "./commands/sync.ts";
import { claim, grantConsent, machineRecordVariable, machineReport, miseConfigVariable, readMachine, releaseMachine, syncMachine } from "./machine.ts";
import { loadOffice, OfficeError, readConfig } from "./office.ts";

let dir: string;

let office: string;

let confD: string;

const saved = { record: process.env[machineRecordVariable], mise: process.env[miseConfigVariable], state: process.env.MISE_STATE_DIR };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-machine-"));
  office = join(dir, "office");
  confD = join(dir, "mise-config/conf.d");
  process.env[machineRecordVariable] = join(dir, "record/machine.json");
  process.env[miseConfigVariable] = join(dir, "mise-config");
  // Sync trusts a fragment with a hook through this machine's mise: keep that out of its real state.
  process.env.MISE_STATE_DIR = join(dir, "mise-state");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });

  for (const [key, value] of [[machineRecordVariable, saved.record], [miseConfigVariable, saved.mise], ["MISE_STATE_DIR", saved.state]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const host = "opencode:\n  mode: host\n  url: http://127.0.0.1:49999\n";

/** An office `name` at `at` in `mode`, with a local package `demo` that declares jq, and the office's own machine.toml. */
function makeOffice(at: string, { name = "t", opencode = host, packages = "packages:\n  - name: demo\n" } = {}): void {
  write(join(at, "office.yaml"), `name: ${name}\n${opencode}${packages}`);
  write(join(at, "packages/demo/package.yaml"), 'name: demo\ndescription: A demo package.\ntools:\n  jq: "1.7.1"\n');
  write(join(at, ".mise/conf.d/machine.toml"), '# The office\'s own.\n[tools]\njq = "1.8.0"\n');
}

const links = () => (existsSync(confD) ? readdirSync(confD).sort() : []);

test("without consent, sync writes nothing outside the office and says what to run; check warns", async () => {
  makeOffice(office);

  const changes = await sync(loadOffice(office));

  expect(changes).toContain(`not linking .mise/conf.d/ into ${confD} yet: office writes outside its folder only once you agree; run office setup (unattended: office setup --manage-machine)`);
  expect(existsSync(confD)).toBe(false);
  expect(readMachine()).toBeUndefined();
  expect(machineReport(loadOffice(office))).toEqual([{ ok: "warn", name: "machine", detail: expect.stringContaining("no consent for this office to manage this machine") }]);
});

test("with consent, sync links each fragment, machine.toml last, records them, and a second sync changes nothing", async () => {
  makeOffice(office);
  grantConsent(loadOffice(office));

  const changes = await sync(loadOffice(office));

  expect(changes).toContain(`linked ${confD}/office-t-1-demo.toml to .mise/conf.d/demo.toml (package demo), so its tools apply in every folder on this machine`);
  expect(changes).toContain(`linked ${confD}/office-t-2-machine.toml to .mise/conf.d/machine.toml (the office's own), so its tools apply in every folder on this machine`);
  // mise loads conf.d by name and the last wins: after ordinary fragments, and machine.toml after the packages'.
  expect(["10-loose.toml", ...links()].sort()).toEqual(["10-loose.toml", "office-t-1-demo.toml", "office-t-2-machine.toml"]);
  expect(readlinkSync(join(confD, "office-t-2-machine.toml"))).toBe(join(office, ".mise/conf.d/machine.toml"));
  expect(readMachine()).toEqual({
    office: { name: "t", dir: office },
    consented: expect.any(String),
    files: [
      { kind: "link", path: join(confD, "office-t-1-demo.toml"), package: "demo", target: join(office, ".mise/conf.d/demo.toml") },
      { kind: "link", path: join(confD, "office-t-2-machine.toml"), package: null, target: join(office, ".mise/conf.d/machine.toml") },
    ],
  });
  expect(await sync(loadOffice(office))).toEqual([]);
  expect(machineReport(loadOffice(office)).map((line) => line.ok)).toEqual([true, true, true]);
});

test("removing a package removes its link; leaving host mode removes them all and the record", async () => {
  makeOffice(office);
  grantConsent(loadOffice(office));
  await sync(loadOffice(office));
  makeOffice(office, { packages: "" });

  expect(await sync(loadOffice(office))).toContain(`removed ${confD}/office-t-1-demo.toml, as package demo no longer has a fragment`);
  expect(links()).toEqual(["office-t-2-machine.toml"]);
  expect(readMachine()?.files.map((file) => file.package)).toEqual([null]);

  makeOffice(office, { opencode: "opencode: container\n" });

  const changes = await sync(loadOffice(office));

  expect(changes).toContain(`removed ${confD}/office-t-2-machine.toml, as the office now runs OpenCode in its container`);
  expect(changes).toEqual(expect.arrayContaining([expect.stringMatching(/^office t no longer manages this machine/)]));
  expect(links()).toEqual([]);
  expect(readMachine()).toBeUndefined();
  expect(machineReport(loadOffice(office))).toEqual([]);
});

test("office sync --release-machine removes everything and the consent, keeping a file changed by hand", async () => {
  makeOffice(office);
  grantConsent(loadOffice(office));
  await sync(loadOffice(office));
  unlinkSync(join(confD, "office-t-1-demo.toml"));
  writeFileSync(join(confD, "office-t-1-demo.toml"), "# mine now\n");

  const first = releaseMachine(loadOffice(office));

  expect(first).toContain(`FAILED to remove ${confD}/office-t-1-demo.toml: it changed since office wrote it, so it stays; delete it yourself`);
  expect(links()).toEqual(["office-t-1-demo.toml"]);
  expect(readMachine()?.files.length).toBe(1);

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
  expect(machineReport(loadOffice(other))).toEqual([{ ok: false, name: "machine", detail: expect.stringContaining("managed by office t") }]);
  expect(links()).toEqual(["office-t-1-demo.toml", "office-t-2-machine.toml"]);

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

  expect(machineReport(loadOffice(moved)).map((line) => [line.ok, line.detail.split(";")[0]])).toEqual([
    [false, `the record names ${office}, where this office was`],
    [false, `dangling: ${join(office, ".mise/conf.d/demo.toml")} is gone, so mise skips it silently`],
    [false, `dangling: ${join(office, ".mise/conf.d/machine.toml")} is gone, so mise skips it silently`],
  ]);

  const changes = await sync(loadOffice(moved));

  expect(changes).toContain(`office t moved from ${office}; ${join(dir, "record/machine.json")} now names ${moved}`);
  expect(changes).toContain(`relinked ${confD}/office-t-1-demo.toml to .mise/conf.d/demo.toml (package demo)`);
  expect(readlinkSync(join(confD, "office-t-2-machine.toml"))).toBe(join(moved, ".mise/conf.d/machine.toml"));
  expect(readMachine()?.office).toEqual({ name: "t", dir: moved });
  expect(machineReport(loadOffice(moved)).every((line) => line.ok === true)).toBe(true);
});

test("sync never replaces a path the record doesn't list, and check reports dangling and hand-edited links", async () => {
  makeOffice(office);
  grantConsent(loadOffice(office));
  mkdirSync(confD, { recursive: true });
  writeFileSync(join(confD, "office-t-1-demo.toml"), "# someone else's\n");

  expect(await sync(loadOffice(office))).toContain(`FAILED to link .mise/conf.d/demo.toml (package demo): ${confD}/office-t-1-demo.toml exists and ${join(dir, "record/machine.json")} doesn't list it, so office leaves it; move it away and run office sync`);
  expect(readFileSync(join(confD, "office-t-1-demo.toml"), "utf8")).toBe("# someone else's\n");
  expect(machineReport(loadOffice(office)).find((line) => line.name.endsWith("office-t-1-demo.toml"))?.detail).toStartWith("exists but isn't in the record");

  rmSync(join(confD, "office-t-1-demo.toml"));
  await sync(loadOffice(office));

  // Hand-edited: the link points somewhere else. Dangling: its target is gone.
  unlinkSync(join(confD, "office-t-1-demo.toml"));
  symlinkSync(join(dir, "elsewhere.toml"), join(confD, "office-t-1-demo.toml"));
  rmSync(join(office, ".mise/conf.d/machine.toml"));
  mkdirSync(join(office, ".mise/conf.d"), { recursive: true });

  const report = machineReport(loadOffice(office));

  expect(report.find((line) => line.name.endsWith("office-t-1-demo.toml"))).toEqual({ ok: false, name: `machine ${confD}/office-t-1-demo.toml`, detail: `changed since office wrote it to ${join(office, ".mise/conf.d/demo.toml")}; office leaves it: delete it, then office sync` });
  expect(report.find((line) => line.name.endsWith("office-t-2-machine.toml"))?.detail).toStartWith(`dangling: ${join(office, ".mise/conf.d/machine.toml")} is gone, so mise skips it silently; office sync removes it`);

  const changes = await sync(loadOffice(office));

  expect(changes).toContain(`removed ${confD}/office-t-2-machine.toml, as its file left .mise/conf.d/`);
  expect(changes).toEqual(expect.arrayContaining([expect.stringMatching(/^FAILED to link .mise\/conf.d\/demo.toml \(package demo\): .* changed since office wrote it/)]));
  expect(lstatSync(join(confD, "office-t-1-demo.toml")).isSymbolicLink() && readlinkSync(join(confD, "office-t-1-demo.toml"))).toBe(join(dir, "elsewhere.toml"));
});

test("syncMachine does nothing for a container-mode office that doesn't manage the machine", () => {
  makeOffice(office, { opencode: "opencode: container\n" });

  expect(syncMachine(loadOffice(office))).toEqual([]);
  expect(machineReport(loadOffice(office))).toEqual([]);
});

test("machine is a reserved package name", () => {
  makeOffice(office, { packages: "packages:\n  - name: machine\n" });

  expect(() => readConfig(office)).toThrow("is reserved: .mise/conf.d/machine.toml is the office's own machine-wide mise file");
});
