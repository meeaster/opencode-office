import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { host, machineFixture, makeOffice, write } from "../../../../test/support/machine.fixture.ts";
import { fakeManager } from "../../../../test/support/user-units.fixture.ts";
import { down } from "../../../commands/compose.ts";
import { gatherPackages } from "../../../gather.ts";
import { changeText } from "../../../lib/change.ts";
import { loadOffice } from "../../../office.ts";
import { releaseMachine, syncMachine } from "../../machine/owned-files.ts";
import { machineReconciliation } from "../../machine/plan.ts";
import { grantConsent, readMachine } from "../../machine/record.ts";
import { unitDir } from "../../systemd/systemd.ts";
import { serverUnit, serverUnitPath, updatePeer } from "../host-server.ts";
import { matchesServerUnit, writeServerUnit } from "../server-units.ts";

const fixture = machineFixture();

test("the managed server unit goes through the unit writer: consent and a recorded env.sh first, held while it runs, never over a file office didn't write", async () => {
  const { office } = fixture;

  makeOffice(office, { name: "test-server-record", opencode: `${host}  managed: true\n` });

  const config = loadOffice(office);
  const fake = fakeManager();
  const receipt = () => readMachine()?.files.find(file => file.path === plan.path);

  const manager = {
    state: fake.manager.state,
    run(args: readonly string[]) {
      if (args[0] === "daemon-reload") {
        const bytes = readFileSync(plan.path);

        expect(receipt()).toMatchObject({ sha256: createHash("sha256").update(bytes).digest("hex") });
      }

      return fake.manager.run(args);
    },
  };

  const place = (unit: typeof plan, upgrade = false) => writeServerUnit(config, unit, { upgrade, manager });

  const plan = {
    unit: serverUnit(config), path: serverUnitPath(config),
    program: "/path/to/opencode", revision: "test", text: "# managed unit fixture\n", hasSecrets: false,
  };

  expect(() => place(plan)).toThrow("requires consent");
  grantConsent(config, "");
  expect(() => place(plan)).toThrow("recorded environment file");
  syncMachine(config, machineReconciliation, await gatherPackages(config, { machine: true }));
  write(plan.path, "# somebody else's unit\n");
  expect(() => place(plan)).toThrow(`${plan.path} exists and office didn't write it`);
  unlinkSync(plan.path);

  expect(place(plan)).toBe("written");
  expect(fake.calls).toEqual(["daemon-reload"]);
  fake.reset();
  expect(place(plan, true)).toBe("unchanged");
  expect(fake.calls).toEqual([]);
  expect(matchesServerUnit(config, plan)).toBe("current");

  const programOnly = { ...plan, program: "/different/opencode" };

  expect(place(programOnly)).toBe("unchanged");
  expect(receipt()).toMatchObject({ program: programOnly.program });
  expect(fake.calls).toEqual([]);
  expect(readFileSync(plan.path, "utf8")).toBe(plan.text);

  expect(syncMachine(config, machineReconciliation, await gatherPackages(config, { machine: true }))).toEqual([]);
  expect(matchesServerUnit(config, plan)).toBe("current");

  // A changed definition waits while the unit runs, and --upgrade writes and reloads it; restarting is startServer's.
  const next = { ...plan, revision: "next", text: "# managed unit fixture, next revision\n" };

  fake.manager.run(["start", plan.unit]);
  fake.reset();
  expect(place(next)).toBe("held");
  expect(fake.calls).toEqual([]);
  expect(readFileSync(plan.path, "utf8")).toBe(plan.text);
  expect(matchesServerUnit(config, next)).toBe("pending");
  expect(place(next, true)).toBe("written");
  expect(fake.calls).toEqual(["daemon-reload"]);
  expect(matchesServerUnit(config, next)).toBe("current");

  fake.overrides.set(plan.unit, { dropIns: `${plan.path}.d/override.conf` });
  expect(() => place(plan, true)).toThrow("has drop-ins");
  fake.overrides.set(plan.unit, { fragment: "/etc/systemd/user/shadow.service" });
  expect(() => place(plan, true)).toThrow("is loaded from /etc/systemd/user/shadow.service");
  fake.overrides.clear();

  writeFileSync(plan.path, "# edited\n");
  expect(matchesServerUnit(config, next)).toBe("different");
  expect(() => place(next, true)).toThrow("changed since office wrote it");
  expect(releaseMachine(config, machineReconciliation).map(changeText).join("\n")).toContain(`FAILED to remove ${plan.path}`);
  expect(readFileSync(plan.path, "utf8")).toBe("# edited\n");
  unlinkSync(plan.path);
});

test("down stops managed OpenCode and removes its wanted marker even when it refuses an edited package unit, so the updater leaves it stopped", async () => {
  const { office, dir } = fixture;

  makeOffice(office, { opencode: `${host}  managed: true\n` });
  const config = loadOffice(office);
  const plan = { unit: serverUnit(config), path: serverUnitPath(config), program: "/path/to/opencode", revision: "test", text: "# managed unit fixture\n", hasSecrets: false };
  const native = "office-t-pkg-demo.greeter.service";
  const edited = "[Service]\nExecStart=/bin/true\n# edited\n";
  const marker = join(config.state, "managed-opencode.wanted");
  const path = process.env.PATH;

  grantConsent(config, "");
  syncMachine(config, machineReconciliation, await gatherPackages(config, { machine: true }));
  writeServerUnit(config, plan, { upgrade: false, manager: fakeManager().manager });
  write(marker, "");
  write(join(config.state, "systemd", `${native}.json`), JSON.stringify({ owner: "demo", sha256: createHash("sha256").update("[Service]\nExecStart=/bin/true\n").digest("hex") }));
  write(join(unitDir(), native), edited);
  write(join(dir, "bin/systemctl"), `#!/bin/sh
echo "$*" >> '${dir}/systemctl.calls'
case "$2 $4" in
  "show --value") echo '${unitDir()}/'"$5";;
  "show "*) printf 'FragmentPath=%s/%s\\nDropInPaths=\\nActiveState=active\\nUnitFileState=enabled\\nMainPID=4242\\nInvocationID=run-4242\\nNeedDaemonReload=no\\n' '${unitDir()}' "$4";;
esac
`);
  chmodSync(join(dir, "bin/systemctl"), 0o755);
  process.env.PATH = `${join(dir, "bin")}:${path}`;

  try {
    expect(() => down(config)).toThrow(`${join(unitDir(), native)} changed since office wrote it`);
    expect(readFileSync(join(unitDir(), native), "utf8")).toBe(edited);
    expect(existsSync(join(config.state, "systemd", `${native}.json`))).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(dir, "systemctl.calls"), "utf8")).toContain(`--user stop ${plan.unit}\n`);
    expect(await updatePeer(config)).toBeUndefined();
  } finally {
    process.env.PATH = path;
    rmSync(plan.path, { force: true });
    rmSync(join(unitDir(), native), { force: true });
  }
});
