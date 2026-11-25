import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compile } from "./build.ts";
import { applyOfficeTools, definitionText, fakeRegistry, sharedToolsLock, writePackage } from "./test-package.ts";

// An end-to-end test spawns the compiled office many times; under a parallel run it gets 30s, not Bun's 5s.
setDefaultTimeout(30_000);

// A user manager that keeps each started unit's PID in a file, loads each unit from its file in the
// unit folder, and logs every other call. While manager/broken exists, a started unit fails.
const systemctl = (root: string) => `#!/bin/sh
PATH=/usr/bin:/bin
state='${root}/manager'
shift
mkdir -p "$state"
for unit; do :; done
case "$1" in
  show)
    case "$*" in *--value*) exit 0;; esac
    [ -f "$OFFICE_SYSTEMD_USER_DIR/$unit" ] && echo "FragmentPath=$OFFICE_SYSTEMD_USER_DIR/$unit"
    printf 'DropInPaths=\\nNeedDaemonReload=no\\n'
    if [ -f "$state/$unit.failed" ]; then printf 'ActiveState=failed\\nMainPID=0\\nUnitFileState=enabled\\n'
    elif [ -f "$state/$unit" ]; then n=$(cat "$state/$unit"); printf 'ActiveState=active\\nMainPID=%s\\nInvocationID=run-%s\\nUnitFileState=enabled\\n' "$n" "$n"; else printf 'ActiveState=inactive\\nMainPID=0\\n'; fi
    exit 0;;
  start|restart)
    rm -f "$state/$unit.failed"
    if [ -f "$state/broken" ]; then rm -f "$state/$unit"; : > "$state/$unit.failed"; else n=$(( $(cat "$state/counter" 2>/dev/null || echo 100) + 1 )); echo "$n" > "$state/counter"; echo "$n" > "$state/$unit"; fi;;
  disable) rm -f "$state/$unit" "$state/$unit.failed";;
esac
echo "$*" >> '${root}/calls'
`;

const shipped = "[Unit]\nDescription=Greeter\nAfter=network-online.target\n\n[Service]\nExecStart=/usr/bin/env sleep infinity\nRestart=always\n\n[Install]\nWantedBy=default.target\n";

test("office up installs a package's native unit, holds it unchanged, check sees it without containers, upgrades it explicitly, leaves it running when a tool it needs fails to stage, records the containers' pins when it fails to start, and down removes it", async () => {
  const root = mkdtempSync(join(tmpdir(), "office-user-units-e2e-"));
  const bin = join(root, "bin");
  const dir = join(root, "office");
  const home = join(root, "home");
  const state = join(root, "state");
  const pkg = join(dir, "packages/greeter");
  const unit = join(home, "units/office-demo-pkg-greeter.greeter.service");
  const exe = join(bin, "office");

  const env = {
    HOME: home, PATH: bin, TMPDIR: root, OFFICE_MACHINE_DIR: join(home, "machine"), OFFICE_MACHINE_RECORD: join(home, "machine.json"),
    OFFICE_MISE_CONFIG_DIR: join(home, "mise"), OFFICE_SYSTEMD_USER_DIR: join(home, "units"),
    OFFICE_APP_CONFIG_DIR: join(home, "app"), OFFICE_APP_PANELS_DIR: join(home, "panels"),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${home}/no-bus`, DOCKER_HOST: `unix://${home}/no-docker`,
  };

  const cli = (...args: string[]) => {
    const result = Bun.spawnSync([exe, "--office", dir, ...args], { env, cwd: root });

    expect(result.exitCode, result.stderr.toString()).toBe(0);

    return `${result.stdout.toString()}${result.stderr.toString()}`;
  };

  const calls = () => {
    const path = join(root, "calls");
    const text = existsSync(path) ? readFileSync(path, "utf8") : "";

    rmSync(path, { force: true });

    return text.split("\n").filter(line => line !== "");
  };

  try {
    for (const path of [bin, home, state, join(pkg, "units")]) mkdirSync(path, { recursive: true });
    await compile(exe);

    for (const tool of ["docker", "mise"]) writeFileSync(join(bin, tool), `#!/bin/sh\n${tool === "mise" ? fakeRegistry : ""}[ "$1" != --version ] || echo 2026.11.7\n`, { mode: 0o700 });
    writeFileSync(join(bin, "systemctl"), systemctl(root), { mode: 0o700 });
    writeFileSync(join(dir, "office.lock"), sharedToolsLock());
    applyOfficeTools(state);
    writeFileSync(join(state, "secrets.env"), "OPENCODE_PASSWORD=fixture-only\n", { mode: 0o600 });
    writeFileSync(join(dir, "office.yaml"), JSON.stringify({ name: "demo", state, opencode: { mode: "host", url: "http://127.0.0.1:1" }, tools: { sfw: { enabled: false } }, packages: [{ name: "systemd" }, { name: "greeter" }, { name: "cron", settings: { overrides: { "package.office.update-references": { enabled: false }, "package.office.upgrade-tools": { enabled: false } } } }] }));
    writePackage(join(pkg, "office.ts"), definitionText(`{ setup(ctx) { systemd.userUnits.add(ctx, { id: "greeter", file: "units/greeter.service" }); } }`, `import { systemd } from "@office/systemd";`), { dependencies: ["systemd"] });
    writeFileSync(join(pkg, "units/greeter.service"), shipped);
    cli("sync", "--packages");

    expect(cli("up")).toContain("office-demo-pkg-greeter.greeter.service: started with its new definition, ready as PID 101");
    expect(readFileSync(unit, "utf8")).toBe(shipped);
    expect(calls()).toEqual(["enable --no-reload office-demo-pkg-greeter.greeter.service", "daemon-reload", "start office-demo-pkg-greeter.greeter.service"]);

    expect(cli("up")).toContain("office-demo-pkg-greeter.greeter.service: unchanged, ready as PID 101");
    expect(calls()).toEqual([]);

    // check reports the unit on the host though no container runs.
    const checked = Bun.spawnSync([exe, "--office", dir, "check"], { env, cwd: root });

    expect(`${checked.stdout.toString()}${checked.stderr.toString()}`).toMatch(/office-demo-pkg-greeter\.greeter\.service.*active and ready as PID 101/);
    expect(calls()).toEqual([]);

    writeFileSync(join(pkg, "units/greeter.service"), shipped.replace("Restart=always", "Restart=on-failure"));
    cli("sync", "--packages");
    expect(cli("up")).toContain("pending: office-demo-pkg-greeter.greeter.service: its definition changed while it runs as PID 101; office up --upgrade applies them");
    expect(calls()).toEqual([]);
    expect(readFileSync(unit, "utf8")).toBe(shipped);

    expect(cli("up", "--upgrade")).toContain("restarted with its new definition, ready as PID 102");
    expect(calls()).toEqual(["daemon-reload", "restart office-demo-pkg-greeter.greeter.service"]);
    expect(readFileSync(unit, "utf8")).toContain("Restart=on-failure");

    // A tool the unit now restarts with can't be staged: up stops at the shared tools, before any unit changes.
    writePackage(join(pkg, "office.ts"), definitionText(`{ setup(ctx) { const cli = tools.require(ctx, { name: "npm:absent-fixture", minimum: "1.0.0", bin: "absent" }); systemd.userUnits.add(ctx, { id: "greeter", file: "units/greeter.service", restartWhenChanged: cli }); } }`, `import { systemd } from "@office/systemd";\nimport { tools } from "@office/tools";`), { dependencies: ["systemd", "tools"] });
    cli("sync", "--packages");
    const failed = Bun.spawnSync([exe, "--office", dir, "up", "--upgrade"], { env, cwd: root });

    expect(failed.exitCode).toBe(1);
    expect(failed.stderr.toString()).toContain("shared tools");
    expect(calls()).toEqual([]);
    expect(readFileSync(join(root, "manager/office-demo-pkg-greeter.greeter.service"), "utf8").trim()).toBe("102");
    expect(readFileSync(unit, "utf8")).toContain("Restart=on-failure");
    writePackage(join(pkg, "office.ts"), definitionText(`{ setup(ctx) { systemd.userUnits.add(ctx, { id: "greeter", file: "units/greeter.service" }); } }`, `import { systemd } from "@office/systemd";`), { dependencies: ["systemd"] });
    cli("sync", "--packages");

    // An upgrade moves Executor, then a stopped unit fails to start: up fails, but the containers' new pins stay recorded.
    const record = join(state, "applied.json");
    const applied = JSON.parse(readFileSync(record, "utf8"));
    const executor = applied.pins.executor.version;

    applied.pins.executor.version = "0.0.1";
    applied.highest.executor = "0.0.1";
    writeFileSync(record, JSON.stringify(applied));
    rmSync(join(root, "manager/office-demo-pkg-greeter.greeter.service"));
    writeFileSync(join(root, "manager/broken"), "");
    const broken = Bun.spawnSync([exe, "--office", dir, "up", "--upgrade"], { env, cwd: root });

    expect(broken.exitCode).toBe(1);
    expect(broken.stderr.toString()).toContain("office up stopped there, before the packages' up functions");
    expect(JSON.parse(readFileSync(record, "utf8")).pins.executor.version).toBe(executor);
    rmSync(join(root, "manager/broken"));
    calls();
    const retried = cli("up");

    expect(retried).not.toContain("applies executor");
    expect(retried).toContain("office-demo-pkg-greeter.greeter.service: started, ready as PID 103");
    expect(JSON.parse(readFileSync(record, "utf8")).pins.executor.version).toBe(executor);
    calls();

    cli("down");
    expect(calls()).toEqual(["disable --now office-demo-pkg-greeter.greeter.service", "daemon-reload"]);
    expect(existsSync(unit)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 60_000);
