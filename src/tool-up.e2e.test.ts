// office up and the packages' shared tools, end to end: a refusal office can tell from this
// machine's files stops up before any service starts, and a tool up can't install (here, with
// Socket Firewall off, which no shared tool installs without) stops it after the containers, before
// anything that would use the tools, with a failing exit status either way. Native stage failures
// are the unit tests' and the compiled acceptance's.
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { hostMode, mode, rig, take } from "./office-up.fixture.ts";
import { definitionFixture } from "./package-definition.fixture.ts";
import { definitionText, fakeRegistry, writePackage } from "./test-package.ts";

const { write, read, fixture } = definitionFixture({ second: false });

test("a refusal office sees in its own files stops up before any service; a tool it can't install with Socket Firewall off stops it after the containers, before installs, timers and package up hooks", () => {
  const f = fixture("toolsup");
  const config = join(f.dir, "office.yaml");
  const settings = '{type:"object",additionalProperties:false,properties:{version:{type:"string",default:"1.0.0"}}}';

  write(config, `${read(config)}  - name: needsbat\n  - name: widget\n`);
  rig(f, write);
  mode(f, write, hostMode);
  writePackage(join(f.dir, "packages/needsbat/office.ts"), definitionText('{setup(ctx){tools.require(ctx,{name:"aqua:sharkdp/bat",minimum:"0.26.1",bin:"bat"})}, up(){ writeFileSync(process.env.HOME + "/up-ran", ""); return [] }}', 'import { tools } from "@office/tools";\nimport { writeFileSync } from "node:fs";'), { dependencies: ["tools"] });
  // A provider whose own list doesn't have the version its setting asks for.
  writePackage(join(f.dir, "packages/widget/office.ts"), definitionText(`{settings:${settings},setup(ctx){tools.provide(ctx,{name:"widget",versionSetting:"version",install:mise.task("stage"),releases:()=>[],bin:"widget"})}}`, 'import { tools } from "@office/tools";\nimport { mise } from "@office/mise-integration/claims";'), { dependencies: ["tools", "mise-integration"] });
  write(join(f.dir, "packages/widget/mise.toml"), '[tasks.stage]\nrun = "true"\n');
  write(join(f.dir, "office.lock"), `${read(join(f.dir, "office.lock"))}  aqua:sharkdp/bat: { version: 0.26.1 }\n`);
  // mise logs each call, so the test can tell that it installed nothing.
  write(join(f.home, "bin/mise"), `#!/bin/sh\n${fakeRegistry}case "$1" in --version) echo 2026.11.7 ;; *) echo "mise $*" >> "$HOME/calls" ;; esac\n`, 0o755);
  f.cli(0, "sync", "--packages");
  take(f);

  const refused = f.cli(1, "up");

  expect(refused).toContain("tool widget 1.0.0 isn't among the releases its provider lists");
  expect(take(f).filter(line => line.startsWith("docker") || line.startsWith("systemctl"))).toEqual([]);
  expect(existsSync(join(f.home, "up-ran"))).toBe(false);

  write(config, read(config).replace("  - name: widget\n", ""));
  f.cli(0, "sync", "--packages");
  take(f);
  const failed = f.cli(1, "up");
  const calls = take(f);

  expect(failed).toContain("the packages' shared tools stopped office up: Socket Firewall is off for this office (sfw enabled: false in office.yaml), and office selects and installs shared tools only behind it; turn it on, then run office up; no shared tool was selected, installed or switched");
  expect(calls.some(line => / up -d /.test(line))).toBe(true);
  expect(calls.filter(line => /^mise (install|upgrade|use) /.test(line))).toEqual([]);
  // No host timer is enabled after the failure.
  expect(calls.some(line => /^systemctl .*\benable\b/.test(line))).toBe(false);
  expect(existsSync(join(f.home, "up-ran"))).toBe(false);
  // The containers it started are recorded as running, so the next up doesn't take them for pending.
  expect(JSON.parse(readFileSync(join(f.dir, "state/applied.json"), "utf8")).pins).toBeDefined();
}, 60_000);
