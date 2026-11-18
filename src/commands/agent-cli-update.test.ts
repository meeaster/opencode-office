import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

import { cronTimers } from "../cron/host.ts";
import { requireJobs } from "../cron/jobs.ts";
import { hostEnvironment } from "../host-env.ts";
import { loadOffice } from "../office.ts";
import { shellQuote } from "../sfw.ts";
import { agentUpdateJob } from "./agent-cli-update.ts";

let root: string;
let server: ReturnType<typeof Bun.serve>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "office-updater-test-"));
  server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== "/api/info" || request.headers.get("authorization") !== `Basic ${btoa("opencode:fixture-password")}`) return new Response(null, { status: 401 });

      return new Response(readFileSync(join(root, "info.json"), "utf8"), { headers: { "content-type": "application/json" } });
    },
  });
});

afterEach(() => {
  server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, text: string, mode = 0o644): void {
  const absolute = join(root, path);

  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text, { mode });
}

const unit = "office-updater-opencode.service";

function state(pid: number, version: string, active = true): void {
  const file = join(root, `units/${unit}`);
  const status = `FragmentPath=${file}\nDropInPaths=\nNeedDaemonReload=no\nUnitFileState=enabled\nActiveState=${active ? "active" : "inactive"}\nSubState=${active ? "running" : "dead"}\nMainPID=${active ? pid : 0}\nExecMainPID=${pid}\nExecMainCode=1\nExecMainStatus=${active ? 0 : 143}\n`;
  const registration = { pid, url: server.url.origin };

  write("unit-status", status);
  write("info.json", JSON.stringify({ pid, version }));
  write("xdg-state/opencode/service.json", JSON.stringify(registration));
}

function fixture(): void {
  write("office.yaml", `name: updater\nstate: runtime\nopencode: {mode: host, managed: true, url: '${server.url.origin}'}\n`);
  write(`units/${unit}`, "# A recorded unit fixture\n");
  write("runtime/secrets.env", "OPENCODE_PASSWORD=fixture-password\n");
  write("runtime/managed-opencode.wanted", "");
  write("installed", "2.3.1\n");
  write("machine/env.sh", "export OPENCODE_DISABLE_AUTOUPDATE=1 DISABLE_AUTOUPDATER=1 NO_PROXY='*'\n");

  const pkg = join(root, ".office/packages/office");

  mkdirSync(join(pkg, "scripts"), { recursive: true });
  copyFileSync(join(import.meta.dir, "../../packages/office/package.yaml"), join(pkg, "package.yaml"));
  copyFileSync(join(import.meta.dir, "../../packages/office/scripts/update-agent-clis.sh"), join(pkg, "scripts/update-agent-clis.sh"));

  const place = shellQuote(root);

  write("home/.opencode/bin/opencode", `#!/bin/sh\nset -eu\nr=${place}
if [ "$1" = "--version" ]; then cat "$r/installed"; exit; fi
test "$1" = upgrade
test "$OPENCODE_DISABLE_AUTOUPDATE" = 1
test -z "\${NO_PROXY-}"
test -z "\${PROVIDER_FIXTURE-}"
printf 'opencode upgrade\\n' >> "$r/calls"
if [ -f "$r/fail-open" ]; then exit 5; fi
if [ -f "$r/next" ]; then cp "$r/next" "$r/installed"; fi
`, 0o755);
  write("xdg-data/claude/versions/2.1.325", `#!/bin/sh\nset -eu\nr=${place}
test "$1" = update
test "$DISABLE_AUTOUPDATER" = 1
printf 'claude update\\n' >> "$r/calls"
if [ -f "$r/hold-claude" ]; then
  touch "$r/claude-entered"
  for i in $(seq 1 100); do test -f "$r/hold-claude" || break; sleep .05; done
fi
if [ -f "$r/fail-claude" ]; then exit 4; fi
if [ -f "$r/claude-next" ]; then ln -sfn "$r/xdg-data/claude/versions/2.1.327" "$r/home/.local/bin/claude"; fi
`, 0o755);
  copyFileSync(join(root, "xdg-data/claude/versions/2.1.325"), join(root, "xdg-data/claude/versions/2.1.327"));
  mkdirSync(join(root, "home/.local/bin"), { recursive: true });
  symlinkSync(join(root, "xdg-data/claude/versions/2.1.325"), join(root, "home/.local/bin/claude"));
  write("machine/sfw/sfw", `#!/bin/sh
test "$#" = 2 && test "$1" = opencode && test "$2" = upgrade || exit 9
printf 'screened\\n' >> ${place}/calls
exec "$@"
`, 0o755);
  write("bin/systemctl", `#!/bin/sh\nset -eu\nr=${place}
test "$1" = "--user"
case "$2" in
  show) cat "$r/unit-status" ;;
  try-restart)
    test "$3" = ${unit}
    printf 'try-restart\\n' >> "$r/calls"
    sed -i 's/PID=2200$/PID=3300/' "$r/unit-status"
    printf '{"pid":3300,"version":"%s"}' "$(cat "$r/installed")" > "$r/info.json"
    printf '{"pid":3300,"url":"${server.url.origin}"}' > "$r/xdg-state/opencode/service.json"
    ;;
  *) exit 9 ;;
esac
`, 0o755);

  state(2200, "2.3.1");

  const record = (relative: string) => {
    const path = join(root, relative);

    return { path, kind: "file", package: null, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") };
  };

  write("record.json", JSON.stringify({
    office: { dir: root, name: "updater" }, consented: "fixture",
    files: [
      { ...record(`units/${unit}`), service: "opencode", program: join(root, "home/.opencode/bin/opencode") },
      record("machine/env.sh"), record("machine/sfw/sfw"),
    ],
  }));
}

function job(...args: string[]) {
  return Bun.spawn([process.execPath, join(import.meta.dir, "../cli.ts"), "--office", root, "cron", ...args], {
    stdout: "pipe", stderr: "pipe",
    env: {
      HOME: join(root, "home"), PATH: `${join(root, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`,
      XDG_CACHE_HOME: join(root, "xdg-cache"), XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_DATA_HOME: join(root, "xdg-data"),
      XDG_STATE_HOME: join(root, "xdg-state"), XDG_RUNTIME_DIR: join(root, "xdg-runtime"), TMPDIR: root,
      OFFICE_MACHINE_DIR: join(root, "machine"), OFFICE_MACHINE_RECORD: join(root, "record.json"),
      OFFICE_SYSTEMD_USER_DIR: join(root, "units"), OFFICE_MISE_CONFIG_DIR: join(root, "mise-config"),
      MISE_CONFIG_DIR: join(root, "mise-config"), MISE_DATA_DIR: join(root, "mise-data"), MISE_STATE_DIR: join(root, "mise-state"), MISE_CACHE_DIR: join(root, "mise-cache"),
      OFFICE_APP_CONFIG_DIR: join(root, "app-config"), OFFICE_APP_PANELS_DIR: join(root, "app-panels"),
      BUN_CONFIG_NO_INSTALL: "1", PROVIDER_FIXTURE: "not sent to updaters", NO_PROXY: "*",
    },
  });
}

async function result(child = job("run", agentUpdateJob)) {
  const [code, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);

  return { code, out, error };
}

function calls(): string[] {
  const path = join(root, "calls");

  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
}

test.skipIf(process.platform !== "linux")("manual package job screens the native update, restarts only for changed OpenCode and verifies the new PID", async () => {
  fixture();
  expect((await result(job("list"))).out.trim()).toBe(agentUpdateJob);
  const office = loadOffice(root);
  const vars = Object.fromEntries(hostEnvironment(office, []).environment.variables);

  expect(vars).toMatchObject({ DISABLE_AUTOUPDATER: "1", OPENCODE_DISABLE_AUTOUPDATE: "1", NPM_CONFIG_MIN_RELEASE_AGE: "3" });
  expect(cronTimers(office, requireJobs(office))[0].calendar).toBe("*-*-* 07:30:00 UTC");
  write("claude-next", "");
  const unchanged = await result();

  expect(unchanged).toMatchObject({ code: 0, out: expect.stringContaining("already current at PID 2200") });
  expect(calls()).toEqual(["claude update", "screened", "opencode upgrade"]);

  write("next", "2.3.2\n");
  const changed = await result();

  expect(changed).toMatchObject({ code: 0, out: expect.stringContaining("2.3.2 verified at systemd PID 3300") });
  expect(calls().filter((call) => call === "try-restart")).toHaveLength(1);
});

test.skipIf(process.platform !== "linux")("the package schedule can change, but its predicate and managed-only environment policy stay fixed", async () => {
  fixture();
  const yaml = readFileSync(join(root, "office.yaml"), "utf8");
  const override = "packages: [{name: office, cron: {update-agent-clis: {schedule: '15 9 * * *'}}}]\n";

  write("office.yaml", yaml + override);

  const office = loadOffice(root);

  expect(cronTimers(office, requireJobs(office))[0].calendar).toBe("*-*-* 09:15:00 UTC");
  write("office.yaml", yaml.replace(", managed: true", "") + override);
  expect((await result(job("list"))).out.trim()).toBe("");
  expect(Object.fromEntries(hostEnvironment(loadOffice(root), []).environment.variables)).not.toHaveProperty("DISABLE_AUTOUPDATER");
  expect(calls()).toEqual([]);
});

test.skipIf(process.platform !== "linux")("CLI failures are independent and missing or failing sfw never falls back to a raw upgrade", async () => {
  fixture();
  write("fail-claude", "");
  write("next", "2.3.2\n");
  const claude = await result();

  expect(claude).toMatchObject({ code: 1, error: expect.stringContaining("Claude Code update failed"), out: expect.stringContaining("2.3.2 verified") });

  rmSync(join(root, "fail-claude"));
  write("fail-open", "");
  const open = await result();

  expect(open).toMatchObject({ code: 1, error: expect.stringContaining("OpenCode update failed") });
  expect(calls().slice(-3)).toEqual(["claude update", "screened", "opencode upgrade"]);

  rmSync(join(root, "machine/sfw/sfw"));
  const unavailable = await result();

  expect(unavailable).toMatchObject({ code: 1, error: expect.stringContaining("not upgraded without screening") });
  expect(calls().slice(-4)).toEqual(["claude update", "screened", "opencode upgrade", "claude update"]);
});

test.skipIf(process.platform !== "linux")("stopped office, unregistered listener, and disabled override do not run either updater", async () => {
  fixture();
  state(2200, "2.3.1", false);
  expect(await result()).toMatchObject({ code: 0, out: expect.stringContaining("OpenCode is stopped") });

  state(2200, "2.3.1");
  rmSync(join(root, "runtime/managed-opencode.wanted"));
  expect(await result()).toMatchObject({ code: 0, out: expect.stringContaining("OpenCode is stopped") });

  write("runtime/managed-opencode.wanted", "");
  rmSync(join(root, "xdg-state/opencode/service.json"));
  expect(await result()).toMatchObject({ code: 1, error: expect.stringContaining("cannot verify the registered OpenCode listener") });

  const yaml = readFileSync(join(root, "office.yaml"), "utf8");

  write("office.yaml", `${yaml}packages: [{name: office, cron: {update-agent-clis: {enabled: false}}}]\n`);
  expect(await result()).toMatchObject({ code: 1, error: expect.stringContaining("not enabled for this office") });
  expect(calls()).toEqual([]);
});

test.skipIf(process.platform !== "linux")("overlapping manual runs share one OS lock", async () => {
  fixture();
  write("hold-claude", "");
  const first = result();

  try {
    for (let i = 0; i < 80 && !existsSync(join(root, "claude-entered")); i++) await Bun.sleep(50);

    expect(existsSync(join(root, "claude-entered"))).toBe(true);
    expect(await result()).toMatchObject({ code: 0, out: expect.stringContaining("already running") });
  } finally {
    rmSync(join(root, "hold-claude"));
    await first;
  }

  expect((await first).code).toBe(0);
  expect(calls()).toEqual(["claude update", "screened", "opencode upgrade"]);
}, 10_000);
