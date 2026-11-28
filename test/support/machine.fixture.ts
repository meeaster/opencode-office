import { afterEach, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { gatherPackages } from "../../src/gather.ts";
import { machineReport } from "../../src/features/machine/owned-files.ts";
import { machineDirVariable, machineRecordVariable } from "../../src/features/machine/paths.ts";
import { machineReconciliation } from "../../src/features/machine/plan.ts";
import { miseConfigVariable } from "../../src/features/mise-integration/machine-files.ts";
import { loadOffice } from "../../src/office.ts";
import { sharedToolsLock, writePackage } from "./test-package.ts";

export function machineFixture({ scratchHome = false } = {}) {
  const fixture = { dir: "", office: "", confD: "" };
  const variables = [machineRecordVariable, miseConfigVariable, machineDirVariable];

  if (scratchHome) variables.push("HOME", "ZDOTDIR", "OFFICE_ENV_FILE", "XDG_DATA_HOME");

  const saved = new Map(variables.map(name => [name, process.env[name]]));

  beforeEach(() => {
    const dir = mkdtempSync(join(tmpdir(), "office-machine-"));

    Object.assign(fixture, { dir, office: join(dir, "office"), confD: join(dir, "mise-config/conf.d") });
    process.env[machineRecordVariable] = join(dir, "record/machine.json");
    process.env[miseConfigVariable] = join(dir, "mise-config");
    process.env[machineDirVariable] = join(dir, "data");

    if (scratchHome) {
      process.env.HOME = join(dir, "home");
      delete process.env.ZDOTDIR;
      delete process.env.OFFICE_ENV_FILE;
      delete process.env.XDG_DATA_HOME;
    }
  });

  afterEach(() => {
    rmSync(fixture.dir, { recursive: true, force: true });

    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  return fixture;
}

export function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export async function reportMachine(at: string) {
  const config = loadOffice(at);
  const gathered = await gatherPackages(config, { machine: true });

  return machineReport(config, machineReconciliation, gathered.complete ? gathered : undefined);
}

export const host = "opencode:\n  mode: host\n  url: http://127.0.0.1:49999\n";

/** A local package demo with a mise fragment, and an owner machine.toml. */
export function makeOffice(at: string, { name = "t", opencode = host, packages = "packages:\n  - name: demo\n", firewall = false } = {}): void {
  write(join(at, "office.yaml"), `name: ${name}\n${opencode}${firewall ? "" : "tools:\n  sfw: { enabled: false }\n"}${packages}`);
  writePackage(join(at, "packages/demo/package.yaml"), '# A demo package.\ntools:\n  jq: "1.7.1"\nhost:\n  install:\n    description: Demo\n    creates: ~/.local/bin/demo\n    script: scripts/install.ts\n');
  write(join(at, "machine.toml"), '# The office\'s own.\n[tools]\njq = "1.8.0"\n');
  write(join(at, "office.lock"), sharedToolsLock());
}

/** A host-mode office with an optional demo host block and no demo tools. */
export function makeEnvironmentOffice(office: string, { firewall = true, host = "", tools = "" } = {}): void {
  write(join(office, "office.yaml"), `name: t\nopencode:\n  mode: host\n  url: http://127.0.0.1:49999\n${firewall ? tools : `tools:\n${tools.replace(/^tools:\n/, "")}  sfw: { enabled: false }\n`}packages:\n  - name: demo\n`);
  writePackage(join(office, "packages/demo/package.yaml"), host || "{}\n");
  write(join(office, "office.lock"), sharedToolsLock());
}
