import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Entries, Registry, RegistryEntry, SetupContext } from "@office/sdk";

import { type Office, loadOffice } from "../../../src/office.ts";
import { reconcileHostServices } from "../../../src/features/systemd/package-host-services.ts";
import { unitDir } from "../../../src/features/systemd/systemd.ts";
import { fakeManager } from "../../../test/support/user-units.fixture.ts";
import type { UnitManager, UnitState } from "../../../src/features/systemd/user-units.ts";
import { precheckUnits, readReceipts, reconcileUnits, removeUnits, type UnitInputs, type UnitPackage, unitStatus } from "../../../src/features/systemd/units.ts";
import { systemd, type UnitFacts, type UserUnitOptions } from "../handles.ts";

const quick = { attempts: 3, interval: 1 };

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

/** A host-mode office in a scratch folder, with its own unit folder until `done`. */
function scratchOffice() {
  const root = mkdtempSync(join(tmpdir(), "office-user-units-"));
  const units = process.env.OFFICE_SYSTEMD_USER_DIR;

  process.env.OFFICE_SYSTEMD_USER_DIR = join(root, "units");
  write(join(root, "office.yaml"), `name: test\nstate: ${join(root, "state")}\nopencode: { mode: host, url: http://localhost:4096 }\ntools: { sfw: { enabled: false } }\n`);

  const done = () => {
    process.env.OFFICE_SYSTEMD_USER_DIR = units;
    rmSync(root, { recursive: true, force: true });
  };

  return { root, office: loadOffice(root), done };
}

/** What a package's setup added, read back through the registry's parser as office reads it. */
function inputs(root: string, declared: Record<string, UserUnitOptions[]>, packages: Partial<Record<string, Partial<UnitPackage>>> = {}): UnitInputs {
  const added: { owner: string; id: string; value: RegistryEntry }[] = [];

  for (const [owner, units] of Object.entries(declared)) {
    const ctx: Pick<SetupContext, "add"> = { add: (handle, value) => void added.push({ owner, id: handle.id, value: structuredClone(value) }) };

    for (const unit of units) systemd.userUnits.add(ctx, unit);
  }

  const entries: Entries = <Value extends RegistryEntry>(registry: Registry<Value>) => added.flatMap(({ owner, id, value }) => id === registry.id ? [{ value: registry.parse(value), owner, namespace: owner, settings: {}, folder: join(root, "packages", owner), root: join(root, "packages", owner) }] : []);
  const names = new Set([...Object.keys(declared), ...Object.keys(packages)]);

  return { entries, packages: [...names].map(name => ({ entry: { name }, dir: join(root, "packages", name), manifest: {}, claims: { required: [], provided: [] }, ...packages[name] })) };
}

const greeter = { name: "npm:greeter", minimum: "1.0.0", bin: ["greeter"] } as const;

/** Activates `version` of the greeter tool in the office's tools folder, as office up records a generation. */
function activate(office: Office, version: string) {
  const folder = join(office.state, "tools");
  const generation = `g-${version}`;
  const text = `#!/bin/sh\necho greeter ${version}\n`;
  const sha256 = `sha256:${createHash("sha256").update(text).digest("hex")}`;

  write(join(folder, "generations", generation, "bin/greeter"), text);
  write(join(folder, "generations", generation, "applied.json"), JSON.stringify({ tools: { [greeter.name]: { version, identity: `greeter ${sha256}`, names: [greeter.name], bin: { greeter: { path: join(folder, "current/bin/greeter"), sha256 } } } }, highest: { [greeter.name]: version } }));
  rmSync(join(folder, "current"), { force: true });
  symlinkSync(join("generations", generation), join(folder, "current"));
}

const shipped = `[Unit]
Description=Greeter %i
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment="GREETING=hello %%h"
ExecStart=/usr/bin/env sleep infinity
Restart=always
RestartSec=3

[Install]
WantedBy=default.target
`;

test("a shipped unit is installed byte for byte, held while running, and an unchanged up neither reloads nor restarts", async () => {
  const { root, office, done } = scratchOffice();
  const fake = fakeManager();
  const name = "office-test-pkg-demo.greeter.service";

  try {
    write(join(root, "packages/demo/units/greeter.service"), shipped);
    const declared = inputs(root, { demo: [{ id: "greeter", file: "units/greeter.service" }] });

    expect((await reconcileUnits(office, declared, { upgrade: false, manager: fake.manager, patience: quick })).lines).toEqual([`${name}: started with its new definition, ready as PID 101`]);
    expect(readFileSync(join(unitDir(), name), "utf8")).toBe(shipped);
    expect(fake.calls).toEqual([`enable --no-reload ${name}`, "daemon-reload", `start ${name}`]);
    expect(fake.manager.state(name).stale).toBe(false);
    expect(fake.units.get(name)?.ran).toBe(shipped);
    expect(readReceipts(office).get(name)?.owner).toBe("demo");

    fake.reset();
    expect((await reconcileUnits(office, declared, { upgrade: false, manager: fake.manager, patience: quick })).lines).toEqual([`${name}: unchanged, ready as PID 101`]);
    expect(fake.calls).toEqual([]);

    // A changed definition waits for --upgrade, which installs and reloads it before the restart.
    write(join(root, "packages/demo/units/greeter.service"), shipped.replace("RestartSec=3", "RestartSec=5"));
    expect((await reconcileUnits(office, declared, { upgrade: false, manager: fake.manager, patience: quick })).pending).toEqual([`${name}: its definition changed while it runs as PID 101; office up --upgrade applies them`]);
    expect(fake.calls).toEqual([]);
    expect(readFileSync(join(unitDir(), name), "utf8")).toBe(shipped);

    expect((await reconcileUnits(office, declared, { upgrade: true, manager: fake.manager, patience: quick })).lines).toEqual([`${name}: restarted with its new definition, ready as PID 102`]);
    expect(fake.calls).toEqual(["daemon-reload", `restart ${name}`]);
    expect(fake.units.get(name)?.ran).toContain("RestartSec=5");

    fake.reset();
    await reconcileUnits(office, declared, { upgrade: true, manager: fake.manager, patience: quick });
    expect(fake.calls).toEqual([]);
    expect(fake.units.get(name)?.pid).toBe(102);
  } finally {
    done();
  }
});

test("a tool change restarts only the dependent unit, without rewriting or reloading; an unapplied tool holds it", async () => {
  const { root, office, done } = scratchOffice();
  const fake = fakeManager();
  const worker = "office-test-pkg-demo.worker.service";
  const other = "office-test-pkg-demo.other.service";

  try {
    write(join(root, "packages/demo/units/other.service"), shipped);
    write(join(root, "packages/demo/start.sh"), "exec greeter\n");
    activate(office, "1.0.0");
    const render = (facts: UnitFacts) => `[Unit]\nDescription=Worker\n\n[Service]\nType=exec\nExecStart=${facts.executable(greeter)} --serve\nRestart=on-failure\n\n[Install]\nWantedBy=default.target\n`;
    const declared = inputs(root, { demo: [{ id: "worker", render, restartWhenChanged: greeter }, { id: "other", file: "units/other.service" }] }, { demo: { claims: { required: [{ ...greeter, bin: [...greeter.bin] }], provided: [] } } });

    await reconcileUnits(office, declared, { upgrade: false, manager: fake.manager, patience: quick });
    const bytes = readFileSync(join(unitDir(), worker), "utf8");

    expect(bytes).toContain(`ExecStart=${join(office.state, "tools/current/bin/greeter")} --serve`);
    expect(fake.units.get(other)?.pid).toBe(102);

    activate(office, "1.1.0");
    fake.reset();
    expect(await reconcileUnits(office, declared, { upgrade: false, manager: fake.manager, patience: quick })).toEqual({ lines: [`${other}: unchanged, ready as PID 102`], pending: [`${worker}: its launch inputs changed while it runs as PID 101; office up --upgrade applies them`], failed: [] });
    expect(fake.calls).toEqual([]);

    expect((await reconcileUnits(office, declared, { upgrade: true, manager: fake.manager, patience: quick })).lines).toEqual([`${worker}: restarted, ready as PID 103`, `${other}: unchanged, ready as PID 102`]);
    expect(fake.calls).toEqual([`restart ${worker}`]);
    expect(readFileSync(join(unitDir(), worker), "utf8")).toBe(bytes);
    expect(fake.units.get(other)?.pid).toBe(102);

    // A tool that isn't the verified applied release leaves the running unit alone.
    writeFileSync(join(office.state, "tools/generations/g-1.1.0/bin/greeter"), "#!/bin/sh\necho tampered\n");
    fake.reset();
    const held = await reconcileUnits(office, declared, { upgrade: true, manager: fake.manager, patience: quick });

    expect(held.pending[0]).toContain(`${worker}: held at its running process, as user unit worker of package demo: tool npm:greeter 1.1.0`);
    expect(fake.calls).toEqual([]);
    expect(fake.units.get(worker)?.pid).toBe(103);

    // Stopped, it can't start on a tool office didn't verify.
    fake.units.set(worker, { active: "inactive", enabled: "enabled", pid: 0, invocation: "" });
    expect((await reconcileUnits(office, declared, { upgrade: true, manager: fake.manager, patience: quick })).failed[0]).toContain("tool npm:greeter 1.1.0");
    expect(fake.calls).toEqual([]);
  } finally {
    done();
  }
});

test("launch inputs alone restart a rendered launcher unit, and a unit that doesn't serve isn't recorded as applied", async () => {
  const { root, office, done } = scratchOffice();
  const fake = fakeManager();
  const name = "office-test-pkg-bridge.bridge.service";
  let serving = true;

  try {
    write(join(root, "packages/bridge/start.sh"), "exec bun dist/main.js\n");
    write(join(root, "packages/bridge/dist/main.js"), "console.log(1)\n");
    const render = (facts: UnitFacts) => `[Unit]\nDescription=Bridge\n\n[Service]\nType=exec\n${facts.launch("start.sh")}\nUMask=0077\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`;
    const declared = inputs(root, { bridge: [{ id: "bridge", render, restartWhenChanged: ["start.sh", "dist/main.js"], ready: () => serving }] });

    await reconcileUnits(office, declared, { upgrade: false, manager: fake.manager, patience: quick });
    const bytes = readFileSync(join(unitDir(), name), "utf8");

    expect(bytes).toContain('cd -- \\"$$5\\"');
    expect(bytes).toContain(join(root, "packages/bridge"));

    write(join(root, "packages/bridge/dist/main.js"), "console.log(2)\n");
    fake.reset();
    expect((await reconcileUnits(office, declared, { upgrade: true, manager: fake.manager, patience: quick })).lines).toEqual([`${name}: restarted, ready as PID 102`]);
    expect(fake.calls).toEqual([`restart ${name}`]);
    expect(readFileSync(join(unitDir(), name), "utf8")).toBe(bytes);

    fake.reset();
    await reconcileUnits(office, declared, { upgrade: true, manager: fake.manager, patience: quick });
    expect(fake.calls).toEqual([]);

    // Systemd says active, but the probe never answers: not ready, and the receipt no longer vouches for any process.
    serving = false;
    write(join(root, "packages/bridge/dist/main.js"), "console.log(3)\n");
    const result = await reconcileUnits(office, declared, { upgrade: true, manager: fake.manager, patience: quick });

    expect(result).toEqual({ lines: [], pending: [], failed: [`${name} is active as PID 103 but not ready; its change stays pending; see journalctl --user -u ${name}`] });
    expect(fake.units.get(name)?.active).toBe("active");
    expect(readReceipts(office).get(name)).toEqual({ owner: "bridge", sha256: createHash("sha256").update(bytes).digest("hex") });
    const reports: [boolean | "warn", string, string][] = [];
    const unverified = (pid: number) => `it runs as PID ${pid}, a process office didn't start and verify; office up --upgrade restarts and verifies it`;

    await unitStatus(office, declared, (...line) => void reports.push(line), { manager: fake.manager });
    expect(reports).toEqual([["warn", name, unverified(103)]]);

    // The unverified process is pending on a plain up, and a retry with the same inputs isn't healthy either.
    fake.reset();
    expect((await reconcileUnits(office, declared, { upgrade: false, manager: fake.manager, patience: quick })).pending).toEqual([`${name}: ${unverified(103)}`]);
    expect(fake.calls).toEqual([]);
    expect((await reconcileUnits(office, declared, { upgrade: true, manager: fake.manager, patience: quick })).failed).toEqual([`${name} is active as PID 104 but not ready; its change stays pending; see journalctl --user -u ${name}`]);

    // Back to the last verified inputs, PID 104 still runs bundle 3: it is never blessed as bundle 2, even once its probe answers.
    write(join(root, "packages/bridge/dist/main.js"), "console.log(2)\n");
    serving = true;
    fake.reset();
    expect((await reconcileUnits(office, declared, { upgrade: false, manager: fake.manager, patience: quick })).pending).toEqual([`${name}: ${unverified(104)}`]);
    reports.splice(0);
    await unitStatus(office, declared, (...line) => void reports.push(line), { manager: fake.manager });
    expect(reports).toEqual([["warn", name, unverified(104)]]);
    expect(fake.calls).toEqual([]);
    expect((await reconcileUnits(office, declared, { upgrade: true, manager: fake.manager, patience: quick })).lines).toEqual([`${name}: restarted, ready as PID 105`]);
    expect(fake.calls).toEqual([`restart ${name}`]);
    expect(readReceipts(office).get(name)?.invocation).toBe("run-105");

    // Restarted outside office (systemd's Restart=, a reboot, a manual restart): the same inputs, but not a process office verified.
    fake.units.set(name, { active: "active", enabled: "enabled", pid: 200, invocation: "run-200" });
    fake.reset();
    expect((await reconcileUnits(office, declared, { upgrade: false, manager: fake.manager, patience: quick })).pending).toEqual([`${name}: ${unverified(200)}`]);
    expect(fake.calls).toEqual([]);
  } finally {
    done();
  }
});

test("check takes up's look: the recorded fragment, no pending reload, and the same process before and after the probe", async () => {
  const { root, office, done } = scratchOffice();
  const fake = fakeManager();
  const name = "office-test-pkg-bridge.bridge.service";
  let replace = false;

  try {
    write(join(root, "packages/bridge/units/bridge.service"), shipped);

    const ready = () => {
      // systemd replaces the process while the probe asks the old one.
      if (replace) fake.units.set(name, { active: "active", enabled: "enabled", pid: 300, invocation: "run-300" });

      return true;
    };

    const declared = inputs(root, { bridge: [{ id: "bridge", file: "units/bridge.service", ready }] });
    const reports: [boolean | "warn", string, string][] = [];

    const look = async () => {
      reports.splice(0);
      await unitStatus(office, declared, (...line) => void reports.push(line), { manager: fake.manager });

      return reports;
    };

    await reconcileUnits(office, declared, { upgrade: false, manager: fake.manager, patience: quick });
    expect(await look()).toEqual([[true, name, "active and ready as PID 101"]]);

    fake.overrides.set(name, { stale: true });
    expect(await look()).toEqual([["warn", name, "systemd needs a reload of its unchanged definition while it runs as PID 101; office up --upgrade reloads it and checks it again"]]);
    fake.overrides.clear();

    replace = true;
    expect((await look())[0][0]).toBe(false);
  } finally {
    done();
  }
});

test("a destination office doesn't own is refused before anything changes", async () => {
  const { root, office, done } = scratchOffice();
  const fake = fakeManager();
  const name = "office-test-pkg-demo.greeter.service";
  const path = join(unitDir(), name);

  try {
    write(join(root, "packages/demo/units/greeter.service"), shipped);
    const declared = inputs(root, { demo: [{ id: "greeter", file: "units/greeter.service" }] });

    // The user's own file, or one the legacy host.services reconciler wrote, at the destination.
    for (const foreign of ["[Service]\nExecStart=/bin/true\n", `# office package services: ${office.dir}\n[Service]\nExecStart=/bin/true\n`]) {
      write(path, foreign);
      expect(() => precheckUnits(office, declared, { manager: fake.manager })).toThrow(`${path} exists and office didn't write it`);
      expect((await reconcileUnits(office, declared, { upgrade: true, manager: fake.manager }).catch((error: Error) => error)).toString()).toContain("office leaves it alone");
      expect(readFileSync(path, "utf8")).toBe(foreign);
    }

    rmSync(path);
    await reconcileUnits(office, declared, { upgrade: false, manager: fake.manager, patience: quick });
    fake.reset();

    // A unit loaded from a file that shadows the destination, or with a drop-in.
    fake.overrides.set(name, { fragment: join(root, "elsewhere", name) });
    expect(() => precheckUnits(office, declared, { manager: fake.manager })).toThrow(`is loaded from ${join(root, "elsewhere", name)}`);
    fake.overrides.set(name, { dropIns: `${path}.d/override.conf` });
    expect(() => precheckUnits(office, declared, { manager: fake.manager })).toThrow("has drop-ins");
    fake.overrides.clear();

    // An edited file stays as edited, even when no package wants it any more.
    writeFileSync(path, `${shipped}# edited\n`);
    expect(() => precheckUnits(office, declared, { manager: fake.manager })).toThrow(`${path} changed since office wrote it`);
    expect(() => removeUnits(office, { manager: fake.manager })).toThrow("changed since office wrote it");
    expect(fake.calls).toEqual([]);
    expect(readFileSync(path, "utf8")).toEndWith("# edited\n");
  } finally {
    done();
  }
});

test("declarations office can't use are named", () => {
  const { root, office, done } = scratchOffice();
  const fake = fakeManager();

  try {
    const declared = inputs(root, { demo: [{ id: "bridge", file: "units/bridge.service", restartWhenChanged: greeter }] }, { demo: { manifest: { host: { services: { bridge: { script: "start.sh" } } } } } });

    expect(() => precheckUnits(office, declared, { manager: fake.manager })).toThrow("user unit bridge and host.services.bridge both want office-test-pkg-demo.bridge.service; keep one");
    expect(() => precheckUnits(office, declared, { manager: fake.manager })).toThrow("restarts with tool npm:greeter, which the package doesn't require or provide");
    expect(() => inputs(root, { demo: [{ id: "Bad", file: "x.service" }] }).entries(systemd.userUnits)).toThrow("id must be lowercase");
    expect(() => inputs(root, { demo: [{ id: "up", file: "../x.service" }] }).entries(systemd.userUnits)).toThrow("must be a relative path to a file in the package");
  } finally {
    done();
  }
});

test("units go when no package wants them and on down, and the legacy host.services sweep leaves them alone", async () => {
  const { root, office, done } = scratchOffice();
  const fake = fakeManager();
  const name = "office-test-pkg-demo.greeter.service";
  const path = join(unitDir(), name);
  const previous = process.env.PATH;

  try {
    write(join(root, "packages/demo/units/greeter.service"), shipped);
    const declared = inputs(root, { demo: [{ id: "greeter", file: "units/greeter.service" }] });

    await reconcileUnits(office, declared, { upgrade: false, manager: fake.manager, patience: quick });

    // The former reconciler's sweep finds no unit of its own here: it neither stops nor deletes this one.
    write(join(root, "bin/systemctl"), `#!/bin/sh\necho "$*" >> '${root}/legacy-calls'\n`);
    chmodSync(join(root, "bin/systemctl"), 0o755);
    process.env.PATH = `${join(root, "bin")}:${previous}`;
    reconcileHostServices(office, "down");
    expect(readFileSync(path, "utf8")).toBe(shipped);
    expect(existsSync(join(root, "legacy-calls"))).toBe(false);
    process.env.PATH = previous;

    fake.reset();
    expect((await reconcileUnits(office, inputs(root, {}), { upgrade: false, manager: fake.manager })).lines).toEqual([`${name}: removed, as no package wants it`]);
    expect(fake.calls).toEqual([`disable --now ${name}`, "daemon-reload"]);
    expect(existsSync(path)).toBe(false);
    expect(readReceipts(office).size).toBe(0);

    await reconcileUnits(office, declared, { upgrade: false, manager: fake.manager, patience: quick });
    fake.reset();
    expect(removeUnits(office, { manager: fake.manager })).toEqual([`${name}: removed`]);
    expect(fake.calls).toEqual([`disable --now ${name}`, "daemon-reload"]);
    expect(existsSync(path)).toBe(false);
    expect(removeUnits(office, { manager: fake.manager })).toEqual([]);
  } finally {
    process.env.PATH = previous;
    done();
  }
});

test("a receipt outside the office's package namespace, or not a regular file, stops up and down before any unit is touched", async () => {
  const { root, office, done } = scratchOffice();
  const fake = fakeManager();
  const receipts = join(office.state, "systemd");

  try {
    write(join(root, "packages/demo/units/greeter.service"), shipped);
    const declared = inputs(root, { demo: [{ id: "greeter", file: "units/greeter.service" }] });

    await reconcileUnits(office, declared, { upgrade: false, manager: fake.manager, patience: quick });
    const valid = readFileSync(join(receipts, "office-test-pkg-demo.greeter.service.json"), "utf8");

    for (const [file, make] of [
      ["office-test-opencode.service.json", () => write(join(receipts, "office-test-opencode.service.json"), valid)],
      ["office-other-pkg-demo.greeter.service.json", () => write(join(receipts, "office-other-pkg-demo.greeter.service.json"), valid)],
      ["office-test-pkg-else.greeter.service.json", () => write(join(receipts, "office-test-pkg-else.greeter.service.json"), valid)],
      ["office-test-pkg-demo.linked.service.json", () => symlinkSync(join(receipts, "office-test-pkg-demo.greeter.service.json"), join(receipts, "office-test-pkg-demo.linked.service.json"))],
    ] as const) {
      make();
      fake.reset();
      expect(() => precheckUnits(office, declared, { manager: fake.manager })).toThrow(join(receipts, file));
      await expect(reconcileUnits(office, declared, { upgrade: true, manager: fake.manager })).rejects.toThrow(join(receipts, file));
      expect(() => removeUnits(office, { manager: fake.manager })).toThrow(join(receipts, file));
      expect(fake.calls).toEqual([]);
      rmSync(join(receipts, file));
    }

    expect(fake.units.get("office-test-pkg-demo.greeter.service")?.pid).toBe(101);
  } finally {
    done();
  }
});

test("enabling is followed by one reload, so no unit is left needing one, and a write that fails afterwards stays office's", async () => {
  const { root, office, done } = scratchOffice();
  const fake = fakeManager();
  const name = "office-test-pkg-demo.greeter.service";

  try {
    write(join(root, "packages/demo/units/greeter.service"), shipped);
    const declared = inputs(root, { demo: [{ id: "greeter", file: "units/greeter.service" }] });
    let refuse = "";

    const failing: UnitManager = {
      state: unit => fake.manager.state(unit),
      run(args) {
        if (args.join(" ") !== refuse) return fake.manager.run(args);
        fake.calls.push(`failed ${refuse}`);
        throw new Error(`systemctl --user ${refuse} failed`);
      },
    };

    // The enablement after a first write fails: the receipt already names the bytes, so nothing is foreign next time.
    refuse = `enable --no-reload ${name}`;
    expect((await reconcileUnits(office, declared, { upgrade: false, manager: failing, patience: quick })).failed).toEqual([`systemctl --user ${refuse} failed`]);
    expect(fake.calls).toEqual([`failed ${refuse}`]);
    expect(readReceipts(office).get(name)).toEqual({ owner: "demo", sha256: createHash("sha256").update(shipped).digest("hex") });
    refuse = "";
    fake.reset();
    expect((await reconcileUnits(office, declared, { upgrade: false, manager: fake.manager, patience: quick })).lines).toEqual([`${name}: started, ready as PID 101`]);
    expect(fake.calls).toEqual([`enable --no-reload ${name}`, "daemon-reload", `start ${name}`]);
    expect(fake.manager.state(name).stale).toBe(false);

    // Disabled behind office's back while running: re-enabled and reloaded once, not restarted.
    fake.units.set(name, { active: "active", enabled: "disabled", pid: 101, invocation: "run-101" });
    fake.reset();
    expect((await reconcileUnits(office, declared, { upgrade: true, manager: fake.manager, patience: quick })).lines).toEqual([`${name}: unchanged, ready as PID 101`]);
    expect(fake.calls).toEqual([`enable --no-reload ${name}`, "daemon-reload"]);
    expect(fake.manager.state(name).stale).toBe(false);

    // Stopped and disabled with an unchanged definition: enabled, reloaded once, started.
    fake.units.set(name, { active: "inactive", enabled: "disabled", pid: 0, invocation: "" });
    fake.reset();
    await reconcileUnits(office, declared, { upgrade: false, manager: fake.manager, patience: quick });
    expect(fake.calls).toEqual([`enable --no-reload ${name}`, "daemon-reload", `start ${name}`]);

    // A unit still needing a reload isn't reported ready, and nothing restarts it.
    fake.overrides.set(name, { stale: true });
    fake.reset();
    expect((await reconcileUnits(office, declared, { upgrade: false, manager: fake.manager, patience: quick })).pending).toEqual([`${name}: systemd needs a reload of its unchanged definition while it runs as PID 102; office up --upgrade reloads it and checks it again`]);
    expect(fake.calls).toEqual([]);
    fake.overrides.clear();

    // The reload after a written definition fails: the retry, with the bytes already in place, reloads before it restarts.
    write(join(root, "packages/demo/units/greeter.service"), shipped.replace("RestartSec=3", "RestartSec=7"));
    refuse = "daemon-reload";
    expect((await reconcileUnits(office, declared, { upgrade: true, manager: failing, patience: quick })).failed).toEqual(["systemctl --user daemon-reload failed"]);
    expect(fake.manager.state(name).stale).toBe(true);
    refuse = "";
    fake.reset();
    expect((await reconcileUnits(office, declared, { upgrade: true, manager: fake.manager, patience: quick })).lines).toEqual([`${name}: restarted, ready as PID 103`]);
    expect(fake.calls).toEqual(["daemon-reload", `restart ${name}`]);
    expect(fake.units.get(name)?.ran).toContain("RestartSec=7");
  } finally {
    done();
  }
});

test("a unit whose install section reaches other units is refused, running or not, and nothing is written", async () => {
  const { root, office, done } = scratchOffice();
  const fake = fakeManager();
  const name = "office-test-pkg-demo.greeter.service";

  try {
    write(join(root, "packages/demo/units/greeter.service"), shipped);
    const declared = inputs(root, { demo: [{ id: "greeter", file: "units/greeter.service" }] });

    await reconcileUnits(office, declared, { upgrade: false, manager: fake.manager, patience: quick });

    for (const line of ["Also=unrelated.service", "  Alias = other.service"]) {
      write(join(root, "packages/demo/units/greeter.service"), `${shipped}${line}\n`);
      fake.reset();
      const result = await reconcileUnits(office, declared, { upgrade: true, manager: fake.manager, patience: quick });

      expect(result.failed).toEqual([expect.stringContaining(`its [Install] ${line.trim().split(/ *=/)[0]}= would enable or link units beyond its own`)]);
      expect(result.pending).toEqual([]);
      expect(fake.calls).toEqual([]);
      expect(readFileSync(join(unitDir(), name), "utf8")).toBe(shipped);
    }

    fake.units.set(name, { active: "inactive", enabled: "enabled", pid: 0, invocation: "" });
    expect((await reconcileUnits(office, declared, { upgrade: false, manager: fake.manager, patience: quick })).failed[0]).toContain("Alias=");
    expect(fake.calls).toEqual([]);
  } finally {
    done();
  }
});

test("a drop-in or shadowing file that only the reload brings in stops the activation after it", async () => {
  const { root, office, done } = scratchOffice();
  const fake = fakeManager();
  const name = "office-test-pkg-demo.greeter.service";
  let latent: Partial<UnitState> | undefined;

  const manager: UnitManager = {
    state: unit => fake.manager.state(unit),
    run(args) {
      const out = fake.manager.run(args);

      if (args[0] === "daemon-reload" && latent !== undefined) fake.overrides.set(name, latent);

      return out;
    },
  };

  try {
    write(join(root, "packages/demo/units/greeter.service"), shipped);
    const declared = inputs(root, { demo: [{ id: "greeter", file: "units/greeter.service" }] });

    await reconcileUnits(office, declared, { upgrade: false, manager, patience: quick });

    for (const [found, override] of [["has drop-ins", { dropIns: `${join(unitDir(), name)}.d/override.conf` }], ["is loaded from /etc/systemd/user/", { fragment: `/etc/systemd/user/${name}` }]] as const) {
      write(join(root, "packages/demo/units/greeter.service"), shipped.replace("RestartSec=3", `RestartSec=${found.length}`));
      latent = override;
      fake.reset();
      expect((await reconcileUnits(office, declared, { upgrade: true, manager, patience: quick })).failed).toEqual([expect.stringContaining(found)]);
      expect(fake.calls).toEqual(["daemon-reload"]);
      expect(fake.units.get(name)?.pid).toBe(101);
      latent = undefined;
      fake.overrides.clear();
      fake.manager.run(["daemon-reload"]);
    }
  } finally {
    done();
  }
});

test("a unit whose file is gone while systemd still runs it keeps its receipt, on up and on down", async () => {
  const { root, office, done } = scratchOffice();
  const fake = fakeManager();
  const name = "office-test-pkg-demo.greeter.service";

  try {
    write(join(root, "packages/demo/units/greeter.service"), shipped);
    await reconcileUnits(office, inputs(root, { demo: [{ id: "greeter", file: "units/greeter.service" }] }), { upgrade: false, manager: fake.manager, patience: quick });
    rmSync(join(unitDir(), name));
    fake.reset();

    expect((await reconcileUnits(office, inputs(root, {}), { upgrade: false, manager: fake.manager })).failed).toEqual([expect.stringContaining(`is gone, but systemd still has ${name} running as PID 101; office keeps its record`)]);
    expect(() => removeUnits(office, { manager: fake.manager })).toThrow("office keeps its record");
    expect(fake.calls).toEqual([]);
    expect(readReceipts(office).has(name)).toBe(true);

    // Stopped and unloaded, its enablement link is all that's left: a link systemctl didn't make for it stops the removal.
    fake.manager.run(["stop", name]);
    fake.manager.run(["daemon-reload"]);
    const link = join(unitDir(), "default.target.wants", name);

    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(root, "elsewhere", name), link);
    fake.reset();
    expect(() => removeUnits(office, { manager: fake.manager })).toThrow(`${link} isn't the link systemctl enable made for it; office keeps its record`);
    expect(readReceipts(office).has(name)).toBe(true);
    expect(fake.calls).toEqual([]);

    rmSync(link);
    symlinkSync(join(unitDir(), name), link);
    expect(removeUnits(office, { manager: fake.manager })).toEqual([`${name}: removed`]);
    expect(fake.calls).toEqual(["daemon-reload"]);
    expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
    expect(readReceipts(office).size).toBe(0);
  } finally {
    done();
  }
});

test("a verified unit whose only change is systemd's stale view is pending on plain up, and --upgrade reloads it without a restart; a live drop-in still refuses", async () => {
  const { root, office, done } = scratchOffice();
  const fake = fakeManager();
  const name = "office-test-pkg-demo.greeter.service";
  const dropIn = join(unitDir(), `${name}.d/override.conf`);
  let onReload: Partial<UnitState> | undefined;

  // The view the next reload gives systemd; until then, `fake.overrides` is what it still has loaded.
  const manager: UnitManager = {
    state: unit => fake.manager.state(unit),
    run(args) {
      const out = fake.manager.run(args);

      if (args[0] === "daemon-reload") {
        fake.overrides.clear();

        if (onReload !== undefined) fake.overrides.set(name, onReload);
      }

      return out;
    },
  };

  try {
    write(join(root, "packages/demo/units/greeter.service"), shipped);
    const declared = inputs(root, { demo: [{ id: "greeter", file: "units/greeter.service" }] });
    const pending = `${name}: systemd needs a reload of its unchanged definition while it runs as PID 101; office up --upgrade reloads it and checks it again`;

    await reconcileUnits(office, declared, { upgrade: false, manager, patience: quick });

    // The file touched with the same bytes, or a refused drop-in the user since removed that systemd still lists.
    for (const stale of [{ stale: true }, { stale: true, dropIns: dropIn }]) {
      fake.overrides.set(name, stale);
      fake.reset();
      expect(await reconcileUnits(office, declared, { upgrade: false, manager, patience: quick })).toEqual({ lines: [], pending: [pending], failed: [] });
      expect(fake.calls).toEqual([]);
      expect((await reconcileUnits(office, declared, { upgrade: true, manager, patience: quick })).lines).toEqual([`${name}: unchanged, ready as PID 101`]);
      expect(fake.calls).toEqual(["daemon-reload"]);
      fake.reset();
      await reconcileUnits(office, declared, { upgrade: true, manager, patience: quick });
      expect(fake.calls).toEqual([]);
    }

    // A drop-in still on disk refuses, loaded already or brought in by the reload.
    write(dropIn, "[Service]\nEnvironment=X=1\n");
    fake.overrides.set(name, { stale: true, dropIns: dropIn });
    fake.reset();
    await expect(reconcileUnits(office, declared, { upgrade: true, manager, patience: quick })).rejects.toThrow("has drop-ins");
    fake.overrides.set(name, { stale: true });
    onReload = { dropIns: dropIn };
    expect((await reconcileUnits(office, declared, { upgrade: true, manager, patience: quick })).failed).toEqual([expect.stringContaining("has drop-ins")]);
    expect(fake.calls).toEqual(["daemon-reload"]);
    expect(fake.units.get(name)?.pid).toBe(101);
  } finally {
    done();
  }
});
