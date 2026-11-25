import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Entries, Host, Registry, RegistryEntry, Timer, TimerState } from "@office/sdk";
import definition from "../office.ts";
import { type GivenSettings, type Job, jobs } from "../handles.ts";

let root: string;
let cwd: string;
let state: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "office-cron-definition-"));
  cwd = process.cwd();
  state = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "xdg-state");
});

afterEach(() => {
  process.chdir(cwd);

  if (state === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = state;
  process.exitCode = 0;
  rmSync(root, { recursive: true, force: true });
});

function write(relative: string, text: string): void {
  const path = join(root, relative);

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

type Mode = "host" | "managed-host" | "container";

/** A host whose timers are a list: `set` records what it was given, `status` returns `installed`. */
function fakeHost(installed: TimerState[] = []) {
  const calls: (readonly Timer[] | "clear")[] = [];

  const host: Host = { timers: {
    set(timers) { calls.push(timers);

 return ["set"]; },
    clear() { calls.push("clear");

 return ["cleared"]; },
    status: () => installed,
  } };

  return { host, calls };
}

/** The inputs of package demo's jobs in an office of `mode`, with `settings` for the cron package. */
function inputs(mode: Mode, list: Job[], settings: GivenSettings = {}, args: string[] = []) {
  const entries: Entries = <Value extends RegistryEntry>(registry: Registry<Value>) => list.flatMap(job => (registry.id === jobs.id ? [{ value: registry.parse(job), owner: "demo", namespace: "demo", settings: {}, folder: join(root, "packages/demo"), root: join(root, "packages/demo") }] : []));
  const refuse = () => { throw new Error("not in these tests"); };

  return { office: { dir: root, name: "test", mode, launcher: "/bin/false" }, entries, settings, args, replaceSetting: refuse, exclude: refuse, updateExcluded: refuse, ...fakeHost() };
}

const digest: Job = { name: "digest", schedule: "15 6 * * *", script: "digest.sh" };

const inContainer: Job = { name: "box", schedule: "@hourly", script: "digest.sh", when: "container" };

async function command(name: string, given: ReturnType<typeof inputs>): Promise<string[]> {
  const out = spyOn(console, "log").mockImplementation(() => undefined);
  const run = definition.commands?.[name]?.run;

  try {
    if (run === undefined) throw new Error(`no command ${name}`);
    await run(given);

    return out.mock.calls.map(call => String(call[0]));
  } finally {
    out.mockRestore();
  }
}

/** A result command's returned text. */
async function text(name: string, given: ReturnType<typeof inputs>): Promise<string> {
  const result = definition.commands?.[name]?.result;

  if (result === undefined) throw new Error(`no result command ${name}`);

  return result(given);
}

test("up sets one timer per job that applies, running cron run <id>; in the container it sets none; down clears", async () => {
  write("packages/demo/digest.sh", "true");
  const host = inputs("host", [digest, inContainer]);

  expect(await definition.up?.(host)).toEqual(["set"]);
  expect(host.calls).toEqual([[{ id: "package.demo.digest", calendar: "*-*-* 06:15:00 UTC", run: ["cron", "run", "package.demo.digest"] }]]);

  const container = inputs("container", [digest, inContainer]);

  expect(await definition.up?.(container)).toEqual([]);
  expect(container.calls).toEqual([]);
  expect(await definition.down?.(container)).toEqual(["cleared"]);
  expect(container.calls).toEqual(["clear"]);
});

test("sync checks every job and returns nothing; a missing script throws naming the job", async () => {
  write("packages/demo/digest.sh", "true");
  expect(await definition.sync?.(inputs("host", [digest]))).toBeUndefined();
  expect(() => definition.sync?.(inputs("host", [{ ...digest, script: "absent.sh" }]))).toThrow("cron package.demo.digest: absent.sh must be an existing regular script");
});

test("check names a timer missing, inactive, with another schedule or no longer wanted, and reports nothing when they match", async () => {
  write("packages/demo/digest.sh", "true");
  const timer = (id: string, change: Partial<TimerState> = {}): TimerState => ({ id, files: "pair", active: true, calendar: "*-*-* 06:15:00 UTC", persistent: true, ...change });
  const checked = (installed: TimerState[], settings: GivenSettings = {}) => definition.check?.({ ...inputs("host", [digest], settings), host: fakeHost(installed).host });

  expect(await checked([timer("package.demo.digest")])).toEqual([]);
  expect(await checked([])).toEqual([{ level: "failed", message: "office-test-cron-package.demo.digest.timer is missing (run office up)" }]);
  expect(await checked([timer("package.demo.digest", { active: false })])).toEqual([{ level: "failed", message: "office-test-cron-package.demo.digest.timer is inactive (run office up)" }]);
  expect(await checked([timer("package.demo.digest", { calendar: "*-*-* 05:00:00 UTC" })])).toEqual([{ level: "failed", message: "office-test-cron-package.demo.digest.timer: its installed schedule differs from *-*-* 06:15:00 UTC (run office up)" }]);
  expect(await checked([timer("package.demo.digest")], { overrides: { "package.demo.digest": { enabled: false } } })).toEqual([
    { level: "failed", message: "office-test-cron-package.demo.digest.timer is no longer wanted: no job package.demo.digest applies (office up removes it)" },
    { level: "failed", message: "office-test-cron-package.demo.digest.service is no longer wanted: no job package.demo.digest applies (office up removes it)" },
  ]);
  // A job whose service was left without its timer: the timer is missing, not inactive.
  const serviceOnly = { files: "service", active: false, calendar: "", persistent: false } as const;

  expect(await checked([timer("package.demo.digest", serviceOnly)])).toEqual([{ level: "failed", message: "office-test-cron-package.demo.digest.timer is missing (run office up)" }]);
  expect(await checked([timer("package.demo.digest", { files: "timer" })])).toEqual([{ level: "failed", message: "office-test-cron-package.demo.digest.service is missing (run office up)" }]);
  // A lone timer or service no job wants is named as the file that is there.
  expect(await checked([timer("package.demo.digest"), timer("package.demo.gone", serviceOnly), timer("package.demo.left", { files: "timer" })])).toEqual([
    { level: "failed", message: "office-test-cron-package.demo.gone.service is no longer wanted: no job package.demo.gone applies (office up removes it)" },
    { level: "failed", message: "office-test-cron-package.demo.left.timer is no longer wanted: no job package.demo.left applies (office up removes it)" },
  ]);
  // The container's scheduler is the office CLI's to check.
  expect(await definition.check?.({ ...inputs("container", [digest]), host: fakeHost([timer("x")]).host })).toEqual([]);
});

test("list returns ids only; supercronic returns only crontab lines, nothing with no job, and refuses on a host", async () => {
  write("packages/demo/digest.sh", "true");
  expect(await text("cron list", inputs("host", [digest, inContainer]))).toBe("package.demo.digest");
  expect(await text("cron list", inputs("host", []))).toBe("");
  expect(await text("cron supercronic", inputs("container", [digest, inContainer]))).toBe("15 6 * * * office cron run package.demo.digest\n0 * * * * office cron run package.demo.box");
  expect(await text("cron supercronic", inputs("container", []))).toBe("");
  expect(text("cron supercronic", inputs("host", [digest]))).rejects.toThrow("office cron supercronic runs only in the OpenCode container");
  expect(command("cron catch-up", inputs("managed-host", [digest]))).rejects.toThrow("office cron catch-up runs only in the OpenCode container");
  expect(text("cron list", inputs("host", [digest], {}, ["extra"]))).rejects.toThrow("usage: office cron list");
});

test("run exits with the script's status, and refuses an id not declared, disabled or for another mode, running nothing", async () => {
  write("packages/demo/digest.sh", "echo ran >> runs; exit 23");
  expect(await command("cron run", inputs("host", [digest], {}, ["package.demo.digest"]))).toEqual(["office cron: package.demo.digest exited 23"]);
  expect(process.exitCode).toBe(23);

  for (const [settings, id] of [
    [{}, "package.demo.nope"],
    [{ overrides: { "package.demo.digest": { enabled: false } } }, "package.demo.digest"],
    [{}, "package.demo.box"],
  ] as const) {
    expect(command("cron run", inputs("host", [digest, inContainer], settings, [id]))).rejects.toThrow(`cron ${id}: not enabled for this office`);
  }

  expect(command("cron run", inputs("host", [digest], {}, []))).rejects.toThrow("usage: office cron run <job-id>");
});

test("catch-up-job does nothing unless started for this office, from its folder, in its container", async () => {
  write("packages/demo/digest.sh", "echo ran >> runs");
  const job = ["test", "package.demo.digest"];

  process.chdir(root);
  expect(await command("cron catch-up-job", inputs("host", [digest], {}, job))).toEqual([]);
  expect(await command("cron catch-up-job", inputs("container", [digest], {}, ["other", "package.demo.digest"]))).toEqual([]);
  process.chdir(tmpdir());
  expect(await command("cron catch-up-job", inputs("container", [digest], {}, job))).toEqual([]);
  process.chdir(root);
  expect((await command("cron catch-up-job", inputs("container", [digest], {}, job)))[0]).toStartWith("office cron: catching up package.demo.digest");
});
