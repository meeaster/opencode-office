import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { sync } from "../../../commands/sync.ts";
import { envFilePath } from "../../machine/paths.ts";
import { gatherPackages } from "../../../gather.ts";
import { grantConsent } from "../../machine/record.ts";
import { loadOffice } from "../../../office.ts";
import { systemPlatformVariable } from "../system.ts";
import { offerRestart, type Run, type RunResult, systemStep, verifySystems } from "../system-setup.ts";
import { sharedToolsLock, writePackage } from "../../../../test/support/test-package.ts";

let dir: string;

let office: string;

let printed: string[];

let logged: ReturnType<typeof spyOn>;

const savedPlatform = process.env[systemPlatformVariable];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-system-setup-"));
  office = join(dir, "office");
  process.env[systemPlatformVariable] = "ubuntu-24.04-amd64-wsl";
  printed = [];
  logged = spyOn(console, "log").mockImplementation((line: string) => void printed.push(line));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  process.env[systemPlatformVariable] = savedPlatform;
  logged.mockRestore();
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const ready = () => join(dir, "root/usr/bin/demo-browser");

/** A host-mode office with a local package `demo` whose system block is on, and a machine.toml with `machine`. */
function makeOffice({ demo = true, machine = "", mode = "host" } = {}): void {
  const opencode = mode === "host" ? "opencode:\n  mode: host\n  url: http://127.0.0.1:49999\n" : "opencode: container\n";

  write(join(office, "office.yaml"), `name: t\n${opencode}packages:\n${demo ? "  - name: demo\n    settings:\n      on: true\n" : "  []\n"}`);
  write(join(office, "machine.toml"), `[tools]\n${machine}`);
  write(join(office, "office.lock"), sharedToolsLock());
  writePackage(
    join(office, "packages/demo/package.yaml"),
    `# A demo package.
settings: {type: object, additionalProperties: false, properties: {on: {type: boolean, default: false}}}
system:
  setting: on
  description: Demo Browser
  platforms: [ubuntu-24.04-amd64-wsl]
  prepare: scripts/prepare.sh
  verify: scripts/verify.sh
  bootstrap: system/bootstrap.toml
  ready: [${ready()}]
  env:
    DEMO_BROWSER: /usr/bin/demo-browser
`,
  );
  write(join(office, "packages/demo/system/bootstrap.toml"), '[bootstrap.packages]\n"apt:demo-browser" = "latest"\n');
}

async function prepare(consent = true) {
  if (consent) grantConsent(loadOffice(office), "");

  await sync(loadOffice(office));

  const loaded = loadOffice(office);

  return { loaded, installed: (await gatherPackages(loaded, { machine: true })).packages };
}

const plan = (actions: Record<string, string>) =>
  JSON.stringify({ resources: Object.entries(actions).map(([name, action]) => ({ id: { kind: "package", name }, action, current: action === "noop" ? "installed" : "missing" })), summary: { unchanged: Object.values(actions).filter((action) => action === "noop").length } });

type Call = { command: string[]; cwd?: string; terminal?: boolean; links: string[] };

/**
 * A fake machine: the prepare check, mise's plan and its apply answer from `state`, which an apply
 * moves to `after`. It records each call, with the links of the scoped mise config it saw.
 */
function machine(state: { check: RunResult; plan: RunResult }, after?: { check: RunResult; plan: RunResult }) {
  const calls: Call[] = [];
  let current = state;

  const run: Run = (command, { env, cwd, terminal }) => {
    const conf = env?.MISE_CONFIG_DIR === undefined ? undefined : join(env.MISE_CONFIG_DIR, "conf.d");

    calls.push({ command, cwd, terminal, links: conf === undefined ? [] : readdirSync(conf).sort().map((name) => readlinkSync(join(conf, name))) });

    if (command.at(-1) === "--check") return current.check;

    if (command.includes("plan")) return current.plan;

    if (command.includes("--only")) {
      current = after ?? current;

      return { status: 0, stdout: "", stderr: "" };
    }

    return { status: 0, stdout: "verified it\n", stderr: "" };
  };

  return { run, calls };
}

const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });

const pendingCheck: RunResult = { status: 100, stdout: "add Google's repository\n", stderr: "" };

// These tests share one synced office: none changes it but for the ready path, which each removes.
describe("in a synced host-mode office whose demo system block is on", () => {
  let shared: string;
  let fresh: string;
  let synced: Awaited<ReturnType<typeof prepare>>;

  beforeAll(async () => {
    dir = shared = mkdtempSync(join(tmpdir(), "office-system-setup-shared-"));
    office = join(dir, "office");
    process.env[systemPlatformVariable] = "ubuntu-24.04-amd64-wsl";
    makeOffice();
    synced = await prepare();
    process.env[systemPlatformVariable] = savedPlatform;
  });

  // The file's hooks give each test a folder of its own; these point it at the shared office instead.
  beforeEach(() => {
    fresh = dir;
    dir = shared;
    office = join(dir, "office");
  });

  afterEach(() => {
    rmSync(ready(), { force: true });
    dir = fresh;
    office = join(dir, "office");
  });

  // Gone, as the other tests' offices are, so their offices can manage the machine next.
  afterAll(() => {
    rmSync(shared, { recursive: true, force: true });
  });

  test("with nothing pending, setup asks nothing and runs no apply", async () => {
    const { loaded, installed } = synced;

    write(ready(), "");

    const { run, calls } = machine({ check: ok(), plan: ok(plan({ "apt:demo-browser": "noop" })) });
    const ask = () => Promise.reject(new Error("asked"));

    expect(await systemStep(loaded, installed, { mise: "mise", ask, run })).toBe("ready");
    expect(calls.some((call) => call.command.includes("--only"))).toBe(false);
    expect(printed).toContain("System setup: nothing to do; the 1 packages and files this office declares are in place");
  });

  test("a hook mise lists as run is no change, but a ready path nothing accounts for is", async () => {
    const { loaded, installed } = synced;
    const withHook = JSON.stringify({ resources: [{ id: { kind: "hook", name: "pre-packages:1" }, action: "run", current: "not run" }, { id: { kind: "package", name: "apt:demo-browser" }, action: "noop" }], summary: { unchanged: 1 } });
    const { run } = machine({ check: ok(), plan: ok(withHook) });

    expect(await systemStep(loaded, installed, { mise: "mise", ask: undefined, run })).toBe("deferred");
    expect(printed[0]).toBe(`System setup: the office's packages and machine.toml declare system packages and files this machine lacks:\n  - package demo: ${ready()} is missing, though mise has nothing left to install`);

    write(ready(), "");

    expect(await systemStep(loaded, installed, { mise: "mise", ask: undefined, run })).toBe("ready");
  });

  test("declined, or without a terminal, setup applies nothing, even though the machine record holds unattended consent", async () => {
    const { loaded, installed } = synced;
    const { run, calls } = machine({ check: pendingCheck, plan: ok(plan({ "apt:demo-browser": "create" })) });

    expect(await systemStep(loaded, installed, { mise: "mise", ask: () => Promise.resolve("no"), run })).toBe("deferred");
    expect(await systemStep(loaded, installed, { mise: "mise", ask: undefined, run })).toBe("deferred");
    expect(calls.some((call) => call.command.includes("--only"))).toBe(false);
    expect(printed).toContain("System setup: not applied without a terminal, as it needs sudo; rerun office setup in a terminal to apply it. Tools that build against these packages can fail to install until then");
  });

  test("an apply that leaves something pending, or a check that fails, fails setup", async () => {
    const { loaded, installed } = synced;
    const stuck = machine({ check: ok(), plan: ok(plan({ "apt:demo-browser": "create" })) });

    await expect(systemStep(loaded, installed, { mise: "mise", ask: () => Promise.resolve("yes"), run: stuck.run })).rejects.toThrow("System setup: applied, but these are still pending:");

    const broken = machine({ check: { status: 1, stdout: "", stderr: "not an apt machine" }, plan: ok(plan({})) });

    await expect(systemStep(loaded, installed, { mise: "mise", ask: () => Promise.resolve("yes"), run: broken.run })).rejects.toThrow("package demo's scripts/prepare.sh --check failed: not an apt machine");
    expect(broken.calls.some((call) => call.command.includes("--only"))).toBe(false);
  });

  test("verification runs each block's verify script in a fresh shell holding only the office's environment file", async () => {
    const { loaded, installed } = synced;
    const { run, calls } = machine({ check: ok(), plan: ok(plan({})) });

    expect(verifySystems(loaded, installed, run)).toEqual({ ok: true, lines: ["package demo: not verified, as its system setup isn't applied"] });

    write(ready(), "");

    expect(verifySystems(loaded, installed, run)).toEqual({ ok: true, lines: ["package demo: verified: verified it"] });

    const command = calls.at(-1)?.command ?? [];

    expect(command.slice(0, 2)).toEqual(["env", "-i"]);
    expect(command).toContain("PATH=/usr/bin:/bin");
    expect(command.slice(-5)).toEqual(["-c", '. "$1" && exec bash "$2"', "sh", envFilePath(), join(office, "packages/demo/scripts/verify.sh")]);

    const failing: Run = () => ({ status: 1, stdout: "", stderr: "launched something else\n" });

    expect(verifySystems(loaded, installed, failing)).toEqual({ ok: false, lines: ["package demo: FAILED: launched something else"] });
  });
});

test("a fresh machine: setup lists what is pending, applies it in the office's scope on yes, and checks that nothing is left", async () => {
  makeOffice({ machine: "", demo: true });
  write(join(office, "machine.toml"), '[tools]\n\n[bootstrap.packages]\n"apt:libclang-dev" = { os = "linux" }\n');

  const { loaded, installed } = await prepare();
  const { run, calls } = machine({ check: pendingCheck, plan: ok(plan({ "apt:demo-browser": "create", "apt:libclang-dev": "create" })) }, { check: ok(), plan: ok(plan({ "apt:demo-browser": "noop", "apt:libclang-dev": "noop" })) });
  const questions: string[] = [];

  // The apply installs what the ready path stands for.
  const applying: Run = (command, options) => {
    if (command.includes("--only")) write(ready(), "");

    return run(command, options);
  };

  expect(await systemStep(loaded, installed, { mise: "/opt/mise", ask: (text) => (questions.push(text), Promise.resolve("yes")), run: applying })).toBe("applied");
  expect(printed[0]).toBe(`System setup: the office's packages and machine.toml declare system packages and files this machine lacks:\n  - package demo: add Google's repository\n  - package apt:demo-browser: create (now missing)\n  - package apt:libclang-dev: create (now missing)`);
  expect(questions).toHaveLength(1);

  const apply = calls.find((call) => call.command.includes("--only"));

  // No package declares a tool in machine.packages.toml: the office package's are shared tools.
  expect(apply).toEqual({ command: ["/opt/mise", "bootstrap", "--only", "packages,files", "--yes"], cwd: "/", terminal: true, links: [join(office, ".office/mise/demo.toml"), join(office, "machine.toml")] });
  // mise read only the office's files when it planned, too.
  expect(calls.filter((call) => call.command.includes("plan")).every((call) => call.links.every((link) => link.startsWith(office)))).toBe(true);
  expect(printed.at(-1)).toBe("System setup: applied, and nothing is left to do");
});

test("machine.toml's packages alone are offered, without any package's system block", async () => {
  makeOffice({ demo: false });
  write(join(office, "machine.toml"), '[tools]\n\n[bootstrap.packages]\n"apt:nasm" = { os = "linux" }\n');

  const { loaded, installed } = await prepare();
  const { run, calls } = machine({ check: ok(), plan: ok(plan({ "apt:nasm": "create" })) });

  expect(await systemStep(loaded, installed, { mise: "mise", ask: undefined, run })).toBe("deferred");
  expect(calls.map((call) => call.command[0])).toEqual(["mise"]);
});

test("setup leaves the machine alone in a container-mode office, without consent, or with nothing declared", async () => {
  const { run, calls } = machine({ check: pendingCheck, plan: ok(plan({ x: "create" })) });

  makeOffice({ mode: "container" });

  let state = await prepare(false);

  expect(await systemStep(state.loaded, state.installed, { mise: "mise", ask: undefined, run })).toBe("skipped");

  makeOffice();
  state = await prepare(false);

  expect(await systemStep(state.loaded, state.installed, { mise: "mise", ask: undefined, run })).toBe("skipped");

  makeOffice({ demo: false });
  state = await prepare();

  expect(await systemStep(state.loaded, state.installed, { mise: "mise", ask: undefined, run })).toBe("skipped");
  expect(calls).toEqual([]);
  expect(printed).toEqual(["System setup: none here (the office runs OpenCode in its container)", "System setup: none here (this office doesn't manage this machine)", "System setup: none here (the office declares none)"]);
});

test("a stale managed server is offered a restart: accepted outside it restarts, inside it queues, declined or unattended it keeps serving", async () => {
  const stale = { unit: "office-t-opencode.service", pid: 42, inside: false };
  const restarted: number[] = [];
  const ops = (inside: boolean) => ({ stale: () => Promise.resolve({ ...stale, inside }), restart: (server: typeof stale) => (restarted.push(server.pid), Promise.resolve(43)) });

  expect(await offerRestart(() => Promise.reject(new Error("asked")), { stale: () => Promise.resolve(undefined), restart: () => Promise.reject(new Error("restarted")) })).toBeUndefined();

  expect(await offerRestart(undefined, ops(false))).toBeUndefined();
  expect(await offerRestart(() => Promise.resolve("no"), ops(false))).toBeUndefined();
  expect(restarted).toEqual([]);
  expect(printed.at(-1)).toBe("OpenCode: restart deferred; rerun office setup to restart it; until then it keeps serving as before (office check shows the restart as pending, not as a failure)");

  expect(await offerRestart(() => Promise.resolve("yes"), ops(false))).toBeUndefined();
  expect(restarted).toEqual([42]);
  expect(printed.at(-1)).toBe("OpenCode: restarted; PID 43 serves with the current settings");

  const questions: string[] = [];

  expect(await offerRestart((text) => (questions.push(text), Promise.resolve("yes")), ops(true))).toBe("queue");
  expect(restarted).toEqual([42]);
  expect(questions[0]).toContain("This terminal runs inside it, so the restart is queued as setup's last step");
});
