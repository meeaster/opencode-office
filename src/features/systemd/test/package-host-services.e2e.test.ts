import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "../../../build.ts";
import { applyOfficeTools, fakeRegistry, sharedToolsLock, writePackage } from "../../../../test/support/test-package.ts";

// An end-to-end test spawns the compiled office many times; under a parallel run it gets 30s, not Bun's 5s.
setDefaultTimeout(30_000);

// The emitted unit quotes each argument separately; decode the subset emitted by argument()
// without interpreting its shell script in the test runner.
function words(line: string) {
  return Array.from(line.matchAll(/"(?:\\.|[^"\\])*"/g), ([word]) => {
    const value: string = JSON.parse(word);

    return value.replaceAll("%%", "%");
  });
}

test("the installed unit keeps its installer identity and no-install policy across profile changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "office-applied-unit-"));
  const bin = join(root, "bin");
  const dir = join(root, "original");
  const home = join(root, "home");
  const state = join(root, "state");
  const record = join(home, "machine.json");
  const pkg = join(dir, "packages/probe");
  const config = join(dir, "office.yaml");
  const unit = join(home, "units/office-original-pkg-probe.observe.service");
  const exe = join(bin, "office");

  const env = {
    HOME: home, PATH: bin, TMPDIR: root, OFFICE_MACHINE_DIR: join(home, "machine"), OFFICE_MACHINE_RECORD: record,
    OFFICE_MISE_CONFIG_DIR: join(home, "mise"), OFFICE_SYSTEMD_USER_DIR: join(home, "units"),
    OFFICE_APP_CONFIG_DIR: join(home, "app"), OFFICE_APP_PANELS_DIR: join(home, "panels"),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${home}/no-bus`, DOCKER_HOST: `unix://${home}/no-docker`,
  };

  const configure = (name: string) => writeFileSync(config, JSON.stringify({ name, state, opencode: { mode: "host", url: "http://127.0.0.1:1" }, tools: { sfw: { enabled: false } }, packages: [{ name: "probe" }] }));
  const run = (...args: string[]) => Bun.spawnSync([exe, "--office", dir, ...args], { env, cwd: root });

  const cli = (...args: string[]) => {
    const result = run(...args);

    expect(result.exitCode, result.stderr.toString()).toBe(0);
  };

  try {
    for (const path of [bin, home, state, pkg]) mkdirSync(path, { recursive: true });
    await compile(exe);

    for (const tool of ["docker", "systemctl", "mise"]) writeFileSync(join(bin, tool), `#!/bin/sh\n${tool === "mise" ? fakeRegistry : ""}[ "$1" != --version ] || echo 2026.11.7\n`, { mode: 0o700 });
    // The office package's shared tools recorded, so sync asks mise for no release, and applied, so up installs none.
    writeFileSync(join(dir, "office.lock"), sharedToolsLock());
    applyOfficeTools(state);
    writeFileSync(join(state, "secrets.env"), "OPENCODE_PASSWORD=fixture-only\n", { mode: 0o600 });
    writePackage(join(pkg, "package.yaml"), "# test\nhost:\n  services: {observe: {description: Observe, script: start.sh}}\n  env: { FROM_CLAIM: visible, MISE_AUTO_INSTALL: '1', MISE_NOT_FOUND_AUTO_INSTALL: '1' }\n");
    writeFileSync(join(pkg, "start.sh"), 'printf "%s\\n" "${FROM_CLAIM-none}:$MISE_AUTO_INSTALL/$MISE_NOT_FOUND_AUTO_INSTALL:$CODEX_HOME"');
    configure("original");
    cli("sync", "--packages");
    cli("up");

    // Retain the actual argv and profile from the compiled executable. Do not re-render after
    // changing YAML, removing it, or transferring the machine record to its replacement.
    const lines = readFileSync(unit, "utf8").split("\n");
    const exec = lines.find(line => line.startsWith("ExecStart="));

    if (!exec) throw Error("unit has no command");
    const argv = words(exec).map(word => word.replaceAll("$$", "$"));
    const manager: NodeJS.ProcessEnv = { HOME: home, PATH: bin, CODEX_HOME: "manager-profile" };

    for (const line of lines) {
      if (!line.startsWith("Environment=")) continue;
      const [assignment] = words(line);

      if (!assignment) throw Error("missing environment assignment");
      const at = assignment.indexOf("=");

      manager[assignment.slice(0, at)] = assignment.slice(at + 1);
    }

    const observe = () => {
      const result = Bun.spawnSync(argv, { env: manager, cwd: home });

      expect(result.exitCode, result.stderr.toString()).toBe(0);

      return result.stdout.toString().trim();
    };

    expect(observe()).toBe("none:0/0:manager-profile");
    writeFileSync(config, "name: original\npackages: not-a-list\n");
    expect(observe()).toBe("none:0/0:manager-profile");
    configure("original");
    writeFileSync(record, JSON.stringify({ office: { name: "original", dir }, consented: "fixture", files: [] }));
    cli("sync", "--packages");
    expect(observe()).toBe("visible:0/0:manager-profile");
    writeFileSync(config, "name: original\npackages: not-a-list\n");
    expect(observe()).toBe("visible:0/0:manager-profile");
    configure("replacement");
    cli("sync", "--packages");
    expect(run("env", "host-service", "replacement").stdout.toString()).toContain("FROM_CLAIM");
    expect(observe()).toBe("none:0/0:manager-profile");

    rmSync(config);
    mkdirSync(join(root, "packages/parent-profile"), { recursive: true });
    writePackage(join(root, "packages/parent-profile/package.yaml"), "# parent marker\nhost: {env: {FROM_CLAIM: ancestor}}\n");
    writeFileSync(join(root, "office.yaml"), "name: ancestor\nopencode: {mode: host, url: 'http://localhost:1'}\ntools: {sfw: {enabled: false}}\npackages: [{name: parent-profile}]\n");
    writeFileSync(join(root, "office.lock"), sharedToolsLock());
    rmSync(join(env.OFFICE_MACHINE_DIR, "env.sh"));
    writeFileSync(record, JSON.stringify({ office: { name: "ancestor", dir: root }, consented: "fixture", files: [] }));
    const ancestor = Bun.spawnSync([exe, "--office", root, "sync", "--packages"], { env, cwd: root });

    expect(ancestor.exitCode, ancestor.stderr.toString()).toBe(0);
    expect(readFileSync(join(env.OFFICE_MACHINE_DIR, "env.sh"), "utf8")).toContain("export FROM_CLAIM='ancestor'");
    expect(observe()).toBe("none:0/0:manager-profile");

    // Without its name and office, the form is refused with its usage.
    const bare = run("env", "host-service");

    expect(bare.exitCode).toBe(1);
    expect(bare.stdout.toString()).toBe("");
    expect(bare.stderr.toString()).toContain("usage: office env host-service <name> --office <absolute-dir>");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
