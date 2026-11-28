import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { restartStaleServer, type ServerPlan, serverReport, staleServer, startServer } from "../host-server.ts";
import { loadOffice } from "../../../office.ts";
import { shellQuote } from "../../tools/sfw.ts";

let root: string;

let server: ReturnType<typeof Bun.serve>;

const savedPath = process.env.PATH;

const savedUnits = process.env.OFFICE_SYSTEMD_USER_DIR;

const unit = "office-stale-opencode.service";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "office-server-test-"));
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname !== "/api/info" || request.headers.get("authorization") !== `Basic ${btoa("opencode:fixture-password")}`) return new Response(null, { status: 401 });

      return new Response(readFileSync(join(root, "info.json"), "utf8"), { headers: { "content-type": "application/json" } });
    },
  });
});

afterEach(() => {
  process.env.PATH = savedPath;
  process.env.OFFICE_SYSTEMD_USER_DIR = savedUnits;

  for (const name of ["pid", "new-pid"]) {
    try {
      process.kill(Number(readFileSync(join(root, name), "utf8")));
    } catch {
      // Already gone.
    }
  }

  server.stop(true);
  rmSync(root, { recursive: true, force: true });
});

function write(path: string, text: string, mode = 0o644): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text, { mode });
}

/** A process standing for OpenCode, started under `revision`, as the unit starts it. */
function serve(revision: string): number {
  const child = Bun.spawn(["sleep", "60"], { env: { OFFICE_SERVER_REVISION: revision }, stdio: ["ignore", "ignore", "ignore"] });

  child.unref();

  return child.pid;
}

function status(pid: number, active = true): void {
  write("unit-status", `FragmentPath=${join(root, "units", unit)}\nDropInPaths=\nUnitFileState=enabled\nActiveState=${active ? "active" : "inactive"}\nMainPID=${active ? pid : 0}\n`);
  write("info.json", JSON.stringify({ pid, version: "2.3.0" }));
}

/** An office with a managed server whose unit runs a process started under `revision`, and a fake systemctl. */
function fixture(revision: string) {
  const place = shellQuote(root);

  write("office.yaml", `name: stale\nstate: runtime\nopencode: {mode: host, managed: true, url: '${server.url.origin}'}\n`);
  write("runtime/secrets.env", "OPENCODE_PASSWORD=fixture-password\n");
  write(
    "bin/systemctl",
    `#!/bin/sh
set -eu
r=${place}
test "$1" = --user
case "$2" in
  is-active) test "$4" = ${unit} && grep -qx 'ActiveState=active' "$r/unit-status" ;;
  show-environment) ;;
  show) sed -n "s/^\${3#--property=}=//p" "$r/unit-status" ;;
  restart)
    test "$3" = ${unit}
    printf 'restart\\n' >> "$r/calls"
    kill "$(cat "$r/pid")" 2>/dev/null || true
    OFFICE_SERVER_REVISION="$(cat "$r/next-revision")" nohup sleep 60 >/dev/null 2>&1 &
    echo $! > "$r/new-pid"
    sed -i "s/^MainPID=.*/MainPID=$!/" "$r/unit-status"
    printf '{"pid":%s,"version":"2.3.0"}' "$!" > "$r/info.json"
    ;;
  *) exit 9 ;;
esac
`,
    0o755,
  );
  write("bin/systemd-run", `#!/bin/sh\nprintf 'systemd-run %s\\n' "$*" >> ${place}/calls\n`, 0o755);
  process.env.PATH = `${join(root, "bin")}:${savedPath}`;

  const pid = serve(revision);

  write("pid", String(pid));
  status(pid);

  const plan: ServerPlan = { unit, path: join(root, "units", unit), program: "opencode", text: "", revision: "current", hasSecrets: false };

  return { office: loadOffice(root), plan, pid };
}

test.skipIf(process.platform !== "linux")("a unit process started under an older revision is stale; a current, stopped or foreign one is not", async () => {
  const { office, plan, pid } = fixture("older");

  expect(await staleServer(office, plan)).toEqual({ unit, pid, inside: false });
  expect(await staleServer(office, { ...plan, revision: "older" })).toBeUndefined();

  // The address answers with a process that isn't the unit's: not the office's to restart.
  write("info.json", JSON.stringify({ pid: pid + 100000, version: "2.3.0" }));

  expect(await staleServer(office, plan)).toBeUndefined();

  status(pid, false);

  expect(await staleServer(office, plan)).toBeUndefined();

  status(pid);

  expect(await staleServer(office, { ...plan, path: join(root, "elsewhere") })).toBeUndefined();
});

test.skipIf(process.platform !== "linux")("restarting restarts the unit alone and waits for a new process with the current revision", async () => {
  const { office, plan, pid } = fixture("older");

  write("next-revision", "current");

  const stale = await staleServer(office, plan);

  if (stale === undefined) throw new Error("the fixture's server isn't stale");

  const fresh = await restartStaleServer(office, plan, stale);

  expect(fresh).toBe(Number(readFileSync(join(root, "new-pid"), "utf8")));
  expect(fresh).not.toBe(pid);
  expect(readFileSync(join(root, "calls"), "utf8")).toBe("restart\n");
  expect(await staleServer(office, plan)).toBeUndefined();

  await expect(restartStaleServer(office, plan, { ...stale, inside: true })).rejects.toThrow("queue the restart instead");
});

test.skipIf(process.platform !== "linux")("a restart that comes back with other settings fails rather than claiming the change applied", async () => {
  const { office, plan } = fixture("older");

  write("next-revision", "older");

  const stale = await staleServer(office, plan);

  if (stale === undefined) throw new Error("the fixture's server isn't stale");

  await expect(restartStaleServer(office, plan, stale)).rejects.toThrow("but not with the current settings");
});

/** What `startServer` said and asked systemd to do, for a server running under `revision`. */
async function started(revision: string, upgrade: boolean, written: "unchanged" | "written" | "held") {
  const { office, plan } = fixture(revision);
  const said = spyOn(console, "log").mockImplementation(() => undefined);

  process.env.OFFICE_SYSTEMD_USER_DIR = join(root, "units");

  let lines: string[] = [];

  try {
    await startServer(office, plan, upgrade, written);
  } finally {
    lines = said.mock.calls.map(([line]) => String(line));
    said.mockRestore();
  }

  const calls = join(root, "calls");

  return { said: lines, calls: existsSync(calls) ? readFileSync(calls, "utf8") : "" };
}

test.skipIf(process.platform !== "linux")("an unchanged running server is verified by its authenticated PID and revision, and --upgrade doesn't restart it", async () => {
  const { said, calls } = await started("current", true, "unchanged");

  expect(calls).toBe("");
  expect(said.at(-1)).toContain("verified OpenCode at systemd PID");
});

test.skipIf(process.platform !== "linux")("a held definition or older revision is pending on plain up, never verified, and nothing restarts", async () => {
  const { said, calls } = await started("older", false, "held");

  expect(calls).toBe("");
  expect(said.at(-1)).toContain("under its previous settings and unit definition; office setup offers the restart");
  expect(said.join("\n")).not.toContain("verified");
});

test.skipIf(process.platform !== "linux")("a held definition is pending even when the running process has the current revision", async () => {
  const { said, calls } = await started("current", false, "held");

  expect(calls).toBe("");
  expect(said.at(-1)).toContain("with the current settings, but its installed unit definition differs; office up --upgrade installs it");
  expect(said.join("\n")).not.toContain("verified");
});

test.skipIf(process.platform !== "linux")("--upgrade queues a restart of a stale server in a job of its own, which an explicit stop still prevents, and doesn't claim it healthy", async () => {
  const { said, calls } = await started("older", true, "written");

  expect(calls).toStartWith(`systemd-run --user --collect --no-block --quiet --unit office-stale-opencode-restart.service /bin/sh -c set -eu\ntest -f '${join(root, "runtime/managed-opencode.wanted")}' || exit 0\n`);
  expect(calls).toContain(`exec systemctl --user restart ${unit}`);
  expect(calls).not.toContain("\nrestart\n");
  expect(said.join("\n")).not.toContain("verified");
  expect(said.at(-1)).toContain("queueing OpenCode restart independently of this terminal");
});

test.skipIf(process.platform !== "linux")("check reports a held unit definition as pending, never as matching and current", async () => {
  const { office, plan, pid } = fixture("current");

  expect(await serverReport(office, plan, "current")).toEqual({ ok: true, detail: expect.stringContaining(`unit matches; enabled; active; opencode; server and unit PID ${pid}; no server secrets`) });
  expect(await serverReport(office, plan, "pending")).toEqual({ ok: "warn", detail: expect.stringContaining("unit definition pending; enabled; active; opencode; server and unit PID") });
  expect((await serverReport(office, plan, "pending")).detail).toContain("restart pending");
  expect((await serverReport(office, plan, "different")).ok).toBe(false);
});
