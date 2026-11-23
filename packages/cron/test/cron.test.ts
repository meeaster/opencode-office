import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { RegistryEntry } from "@office/sdk";
import { crontab, effectiveJobs, type GivenSettings, type Job, jobs } from "../handles.ts";
import { catchUp, catchUpJob, missedRun, runJob } from "../runner.ts";

let root: string;
let state: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "office-cron-package-"));
  state = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = join(root, "xdg-state");
});

afterEach(() => {
  if (state === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = state;
  rmSync(root, { recursive: true, force: true });
});

function write(relative: string, text: string): void {
  const path = join(root, relative);

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

type Mode = "host" | "managed-host" | "container";

const office = (mode: Mode = "host", dir = root) => ({ dir, name: "test", mode, launcher: join(root, "bin/office") });

/** Entries as `entries(jobs)` returns them: each parsed by the registry, owned by `owner` in packages/<owner>. */
function declared(owner: string, ...list: Job[]) {
  return list.map(job => ({ value: jobs.parse(job), owner, folder: join(root, "packages", owner) }));
}

/** Packages demo and office with their scripts, and the office's own script. */
function scripts(): void {
  write("packages/demo/digest.sh", "printf '%s\\n' \"$PWD\" >> package-runs");
  write("packages/office/updater.sh", "true");
  write("cron/office.sh", "printf '%s\\n' \"$PWD\" >> office-runs");
}

const demo = () => declared("demo",
  { name: "digest", schedule: "15 6 * * *", script: "digest.sh" },
  { name: "container", schedule: "@daily", script: "digest.sh", when: "container" },
  { name: "host", schedule: "*/20 * * * MON", script: "digest.sh", when: "host" });

const updater = () => declared("office", { name: "update", schedule: "30 7 * * *", script: "updater.sh", when: "managed-host" });

const own = { jobs: { digest: { schedule: "0 6 * * *", script: "cron/office.sh" } } };

const ids = (list: { id: string }[]) => list.map(job => job.id);

test("the registry's parser keeps every check of a declared job, on plain values, and names the job", () => {
  const job = { name: "digest", schedule: "@daily", script: "scripts/digest.sh" };

  expect(jobs.parse(job)).toEqual(job);
  expect(jobs.parse({ ...job, when: "managed-host" })).toEqual({ ...job, when: "managed-host" });

  const refused: [RegistryEntry, string][] = [
    [{ ...job, schedule: "every tuesday" }, "cron job digest: schedule must be"],
    [{ ...job, schedule: "*/0 * * * *" }, "schedule must be"],
    [{ ...job, schedule: "0 99 * * *" }, "schedule must be"],
    [{ ...job, schedule: "@reboot" }, "schedule must be"],
    [{ ...job, schedule: "0 0 * * *\n* * * * * touch x" }, "schedule must be"],
    [{ ...job, schedule: 6 }, "schedule must be"],
    [{ ...job, script: "../outside.sh" }, "cron job digest: script must be a relative .sh path"],
    [{ ...job, script: "/tmp/run.sh" }, "script must be a relative .sh path"],
    [{ ...job, script: "run.sh; id" }, "script must be a relative .sh path"],
    [{ ...job, script: "scripts/./run.sh" }, "script must be a relative .sh path"],
    [{ ...job, script: "run.txt" }, "script must be a relative .sh path"],
    [{ ...job, name: "a".repeat(49) }, "must be at most 48 lowercase letters"],
    [{ ...job, name: "constructor" }, "must be at most 48"],
    [{ ...job, name: "Digest" }, "must be at most 48"],
    [{ ...job, name: 7 }, "must be at most 48"],
    [{ ...job, when: "external" }, "cron job digest: when must be host, managed-host or container"],
    [{ ...job, enabled: false }, "cron job digest: unknown key enabled"],
  ];

  expect(jobs.parse({ ...job, name: "a".repeat(48) }).name).toBe("a".repeat(48));

  for (const [input, message] of refused) expect(() => jobs.parse(input)).toThrow(message);
  // A name is unique within the package that adds it, not across packages.
  expect(jobs.key?.(job)).toBe("digest");
  expect(jobs.keyScope).toBe("package");
});

test("effective jobs: the office's own first, then packages'; when decides by mode, and host covers a managed host", () => {
  scripts();
  const entries = [...updater(), ...demo()];

  expect(ids(effectiveJobs(office("container"), entries, own))).toEqual(["office.digest", "package.demo.digest", "package.demo.container"]);
  expect(ids(effectiveJobs(office("host"), entries, own))).toEqual(["office.digest", "package.demo.digest", "package.demo.host"]);
  expect(effectiveJobs(office("managed-host"), entries, own).map(job => [job.id, job.owner, job.calendar])).toEqual([
    ["office.digest", "office", "*-*-* 06:00:00 UTC"],
    ["package.office.update", "office", "*-*-* 07:30:00 UTC"],
    ["package.demo.digest", "demo", "*-*-* 06:15:00 UTC"],
    ["package.demo.host", "demo", "Mon *-*-* *:00,20,40:00 UTC"],
  ]);
  expect(effectiveJobs(office(), declared("demo", { name: "digest", schedule: "@daily", script: "digest.sh" }), {})[0].script).toBe(join(root, "packages/demo/digest.sh"));
  // No settings at all: the packages' jobs on their own schedules.
  expect(ids(effectiveJobs(office("host"), entries, {}))).toEqual(["package.demo.digest", "package.demo.host"]);
});

test("overrides disable or reschedule a package's job; one for a job of another mode is accepted, and enabled: true doesn't force it", () => {
  scripts();
  const entries = [...updater(), ...demo()];

  const settings = { ...own, overrides: {
    "package.demo.digest": { enabled: false },
    "package.demo.host": { schedule: "0 5 * * *" },
    "package.demo.container": { enabled: true },
    "package.office.update": { enabled: true, schedule: "15 9 * * *" },
  } };

  expect(effectiveJobs(office("host"), entries, settings).map(job => [job.id, job.schedule, job.calendar])).toEqual([
    ["office.digest", "0 6 * * *", "*-*-* 06:00:00 UTC"],
    ["package.demo.host", "0 5 * * *", "*-*-* 05:00:00 UTC"],
  ]);
  expect(ids(effectiveJobs(office("managed-host"), entries, { overrides: { "package.office.update": { enabled: false } } }))).toEqual(["package.demo.digest", "package.demo.host"]);
});

test("an override naming no declared job is an error: an unknown id, a deselected package's, one of the office's own; and one whose schedule isn't one", () => {
  scripts();
  const entries = [...updater(), ...demo()];
  const fails = (overrides: GivenSettings, message: string) => expect(() => effectiveJobs(office(), entries, { ...own, overrides })).toThrow(message);

  fails({ "package.demo.nope": { enabled: false } }, "cron override package.demo.nope: no selected package declares this job");
  fails({ "package.tracks.digest": { schedule: "@daily" } }, "cron override package.tracks.digest: no selected package declares this job");
  fails({ "office.digest": { enabled: false } }, "cron override office.digest: the office's own jobs have no overrides");
  fails({ "package.demo.digest": { schedule: "every tuesday" } }, "cron override package.demo.digest: schedule must be");
  // Five fields whose hour is out of range: named by the override's id, not a bare field error.
  fails({ "package.demo.digest": { schedule: "0 99 * * *" } }, 'cron override package.demo.digest: schedule must be five UTC cron fields or a macro such as @daily, not "0 99 * * *"');
  fails({ "package.demo.digest": { enabled: "false" } }, "cron override package.demo.digest: enabled must be true or false");
  fails({ "package.demo.digest": { when: "host" } }, "cron override package.demo.digest: can only set schedule and enabled");
});

test("every script is checked on disk, a disabled job's and another mode's too: a regular file in its folder, reached through no symlink", () => {
  scripts();
  write("outside.sh", "true");
  symlinkSync(join(root, "outside.sh"), join(root, "packages/demo/linked.sh"));
  const disabled = { overrides: { "package.demo.gone": { enabled: false } } };

  expect(() => effectiveJobs(office(), declared("demo", { name: "gone", schedule: "@daily", script: "absent.sh" }), disabled))
    .toThrow("cron package.demo.gone: absent.sh must be an existing regular script inside package demo's folder, with no symlink");
  expect(() => effectiveJobs(office(), declared("demo", { name: "linked", schedule: "@daily", script: "linked.sh", when: "container" }), {}))
    .toThrow("cron package.demo.linked: linked.sh must be an existing regular script");
  expect(() => effectiveJobs(office(), [], { jobs: { mine: { schedule: "@daily", script: "cron/absent.sh" } } }))
    .toThrow("cron office.mine: cron/absent.sh must be an existing regular script inside the office folder");

  // The office's own jobs are checked as declared ones are, as plain values.
  for (const [jobs, message] of [
    [{ mine: { schedule: "@daily", script: "../outside.sh" } }, "cron office.mine: script must be a relative .sh path"],
    [{ mine: { schedule: "every tuesday", script: "cron/office.sh" } }, "cron office.mine: schedule must be"],
    [{ mine: { schedule: "@daily" } }, "cron office.mine: script must be"],
    [{ mine: { schedule: "@daily", script: "cron/office.sh", when: "host" } }, "cron office.mine: must have a schedule and a script, and nothing else"],
    [{ Mine: { schedule: "@daily", script: "cron/office.sh" } }, "cron office.Mine: job name"],
    [[], "cron settings: jobs must map job names"],
  ] as const) {
    expect(() => effectiveJobs(office(), [], { jobs })).toThrow(message);
  }
});

test("in host mode a schedule restricting both day fields is refused for a job that runs, as is a unit name too long; the container takes both", () => {
  scripts();
  const both = declared("demo", { name: "digest", schedule: "0 1 1 * MON", script: "digest.sh" });

  expect(() => effectiveJobs(office("host"), both, {})).toThrow("cron package.demo.digest: \"0 1 1 * MON\" restricts both the day of the month and the weekday");
  expect(() => effectiveJobs(office("managed-host"), both, {})).toThrow("restricts both");
  expect(ids(effectiveJobs(office("container"), both, {}))).toEqual(["package.demo.digest"]);
  expect(effectiveJobs(office("host"), both, { overrides: { "package.demo.digest": { enabled: false } } })).toEqual([]);

  const long = { ...office("host"), name: "o".repeat(230) };

  expect(() => effectiveJobs(long, declared("demo", { name: "digest", schedule: "@daily", script: "digest.sh" }), {})).toThrow("cron package.demo.digest: its systemd unit name is too long");
});

test("the same name twice in one package is an error naming both; two packages may each use it", () => {
  scripts();
  write("packages/other/digest.sh", "true");
  const job = { name: "digest", schedule: "@daily", script: "digest.sh" };

  expect(() => effectiveJobs(office(), declared("demo", job, job), {})).toThrow("package demo: declares the job digest twice");
  expect(ids(effectiveJobs(office(), [...declared("demo", job), ...declared("other", job)], {}))).toEqual(["package.demo.digest", "package.other.digest"]);
});

test("the crontab has one numeric UTC line per job and no path, so its text is the same wherever the office is mounted", () => {
  scripts();
  const host = effectiveJobs(office("container"), [...updater(), ...demo()], own);

  expect(crontab(host)).toBe([
    "0 6 * * * office cron run office.digest",
    "15 6 * * * office cron run package.demo.digest",
    "0 0 * * * office cron run package.demo.container",
  ].join("\n"));
  expect(crontab([])).toBe("");

  // The same office at another path, as the container mounts it.
  const mounted = join(root, "mount");

  for (const file of ["packages/demo/digest.sh", "packages/office/updater.sh", "cron/office.sh"]) write(`mount/${file}`, "true");
  const relocated = (owner: string, list: ReturnType<typeof declared>) => list.map(entry => ({ ...entry, folder: join(mounted, "packages", owner) }));
  const inContainer = effectiveJobs(office("container", mounted), [...relocated("office", updater()), ...relocated("demo", demo())], own);

  expect(inContainer[0].script).toBe(join(mounted, "cron/office.sh"));
  expect(crontab(inContainer)).toBe(crontab(host));
});

test("a run executes the script from the office folder with the launcher, and returns its status; only the container stamps a success", async () => {
  scripts();
  write("packages/demo/fail.sh", "echo \"$OFFICE_CRON_COMMAND\" > launcher; exit 23");
  const out = spyOn(console, "log").mockImplementation(() => undefined);

  try {
    const [digest] = effectiveJobs(office(), declared("demo", { name: "digest", schedule: "@daily", script: "digest.sh" }), {});
    const fail = { id: "package.demo.fail", script: join(root, "packages/demo/fail.sh") };

    expect(await runJob(office("host"), digest)).toBe(0);
    expect(readFileSync(join(root, "package-runs"), "utf8")).toBe(`${root}\n`);
    expect(existsSync(join(root, "xdg-state/office/cron/test"))).toBe(false);
    expect(await runJob(office("host"), fail)).toBe(23);
    expect(readFileSync(join(root, "launcher"), "utf8")).toBe(`${join(root, "bin/office")}\n`);
    expect(out.mock.calls.map(call => call[0])).toEqual(["office cron: package.demo.digest exited 0", "office cron: package.demo.fail exited 23"]);

    expect(await runJob(office("container"), digest, new Date("2026-11-17T06:10:00Z"))).toBe(0);
    expect(readFileSync(join(root, "xdg-state/office/cron/test/package.demo.digest.stamp"), "utf8")).toBe("2026-11-17T06:10:00.000Z\n");
    expect(await runJob(office("container"), fail)).toBe(23);
    expect(existsSync(join(root, "xdg-state/office/cron/test/package.demo.fail.stamp"))).toBe(false);
  } finally {
    out.mockRestore();
  }
});

test("catch-up is UTC: a job runs when its latest due minute is after its last success, a failure is due again, and a rename keeps the stamp", async () => {
  const tz = process.env.TZ;
  const out = spyOn(console, "log").mockImplementation(() => undefined);

  try {
    process.env.TZ = "Pacific/Honolulu";
    scripts();
    write("packages/demo/digest.sh", "exit 3");
    const at = new Date("2026-11-17T06:10:00Z");
    let [mine, digest] = effectiveJobs(office("container"), declared("demo", { name: "digest", schedule: "15 6 * * *", script: "digest.sh" }), own);

    expect(missedRun(office(), mine, at)?.toISOString()).toBe("2026-11-17T06:00:00.000Z");
    // Its last due minute was yesterday's 06:15, and it never succeeded.
    expect(missedRun(office(), digest, at)?.toISOString()).toBe("2026-11-16T06:15:00.000Z");

    await catchUpJob(office("container"), mine, at);
    await catchUpJob(office("container"), digest, at);
    expect(readFileSync(join(root, "xdg-state/office/cron/test/office.digest.stamp"), "utf8")).toBe("2026-11-17T06:10:00.000Z\n");
    expect(existsSync(join(root, "xdg-state/office/cron/test/package.demo.digest.stamp"))).toBe(false);
    expect(missedRun(office(), mine, at)).toBeUndefined();
    expect(missedRun(office(), digest, at)).toBeDefined();
    expect(readFileSync(join(root, "office-runs"), "utf8")).toBe(`${root}\n`);

    // The id, not the script, is what the stamp is kept by.
    write("cron/new.sh", "printf '%s\\n' ran >> renamed-runs");
    [mine] = effectiveJobs(office("container"), [], { jobs: { digest: { schedule: "0 6 * * *", script: "cron/new.sh" } } });
    await catchUpJob(office("container"), mine, new Date("2026-11-17T06:20:00Z"));
    expect(existsSync(join(root, "renamed-runs"))).toBe(false);
    await catchUpJob(office("container"), mine, new Date("2026-11-18T06:00:00Z"));
    expect(readFileSync(join(root, "renamed-runs"), "utf8")).toBe("ran\n");

    // A job gone or disabled since catch-up listed it reaches catchUpJob as undefined: nothing runs.
    await catchUpJob(office("container"), undefined, at);
    // Rescheduled since its last success to a minute not yet due: skipped, its stamp kept.
    write("xdg-state/office/cron/test/package.demo.later.stamp", "2026-11-17T03:10:00.000Z\n");
    write("packages/demo/later.sh", "echo ran >> later-runs");
    const [later] = effectiveJobs(office("container"), declared("demo", { name: "later", schedule: "0 18 * * *", script: "later.sh" }), {});

    await catchUpJob(office("container"), later, at);
    expect(existsSync(join(root, "later-runs"))).toBe(false);

    // A success exactly at the due minute skips it; a stamp that isn't a time, or is empty, leaves it due.
    write("xdg-state/office/cron/test/package.demo.later.stamp", "2026-11-16T18:00:00.000Z\n");
    expect(missedRun(office(), later, at)).toBeUndefined();

    for (const text of ["not a time\n", ""]) {
      write("xdg-state/office/cron/test/package.demo.later.stamp", text);
      expect(missedRun(office(), later, at)?.toISOString()).toBe("2026-11-16T18:00:00.000Z");
    }
  } finally {
    out.mockRestore();

    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

test("catch-up starts one fresh child per id from the office folder, in order, and stops at the first child that fails", async () => {
  const log = join(root, "children");

  write("bin/office", `#!/bin/sh\nprintf '%s %s\\n' "$PWD" "$*" >> '${log}'\n[ "$4" = stop ] && exit 4\nexit 0\n`);
  chmodSync(join(root, "bin/office"), 0o755);

  expect(await catchUp(office("container"), ["office.a", "package.demo.b"])).toBe(0);
  expect(await catchUp(office("container"), ["office.c", "stop", "office.never"])).toBe(4);
  expect(readFileSync(log, "utf8")).toBe([
    `${root} cron catch-up-job test office.a`,
    `${root} cron catch-up-job test package.demo.b`,
    `${root} cron catch-up-job test office.c`,
    `${root} cron catch-up-job test stop`,
    "",
  ].join("\n"));
});
