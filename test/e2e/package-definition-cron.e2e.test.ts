// The cron package through the compiled office: jobs packages declare and the office's own from the
// cron package's settings, its commands, where each kind of mistake is caught, a broken package
// stopping a named run, and catch-up in fresh processes.
import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { git } from "../../src/git.ts";
import { activeGeneration } from "../../src/loader/package-generation.ts";
import { definitionFixture } from "../support/package-definition.fixture.ts";
import { definitionText, writePackage } from "../support/test-package.ts";

const { root, exe, marker, write, read, commit, fixture, collector } = definitionFixture({ second: false });

/** A definition declaring `jobs` to the cron registry (handles match by id, so it needs no import). */
const declaring = (jobs: object[], extra = "") => definitionText(`{setup(c){for (const job of ${JSON.stringify(jobs)}) c.add({id:"cron.jobs",parse:v=>v},job); ${extra}}}`);

/** office.yaml's cron entry, keeping the office's two default jobs off unless asked. */
const cronEntry = (settings = "") => `  - name: cron\n    settings: {overrides: {package.office.update-references: {enabled: false}, package.office.upgrade-tools: {enabled: false}}${settings}}\n`;

/** Like `declaring`, printing to standard output as the module loads and while its setup runs, awaited parts included. */
const noisy = (jobs: object[]) => definitionText(
  `{async setup(c){for (const job of ${JSON.stringify(jobs)}) c.add({id:"cron.jobs",parse:v=>v},job); console.log("setup log"); process.stdout.write("setup write\\n"); await Promise.resolve(); console.info("setup later");}}`,
  'console.log("module log");',
);

test("jobs from packages and the office's settings: listed without a sync, run with their status, and the container commands' output and guards", () => {
  const { dir, env, cli, select } = fixture("cron-jobs");
  const report = join(dir, "packages/report");
  const noise = "module log\nsetup log\nsetup write\nsetup later\n";

  // The container's runner reads supercronic's standard output as its crontab: what packages print while loading goes to standard error.
  const streams = (...args: string[]) => {
    const result = Bun.spawnSync([exe, "--office", dir, ...args], { cwd: root, env });

    expect(result.exitCode, result.stderr.toString()).toBe(0);

    return { stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  };

  select(`  - name: report\n  - name: cron\n    settings:\n      jobs: {heartbeat: {schedule: '@hourly', script: scripts/heartbeat.sh}}\n      overrides: {package.office.upgrade-tools: {enabled: false}, package.office.update-references: {schedule: '0 5 * * *'}}\n`);
  writePackage(join(report, "office.ts"), declaring([]));
  write(join(dir, "scripts/heartbeat.sh"), 'pwd > heartbeat-ran; printf "%s" "$OFFICE_CRON_COMMAND" > launcher');
  cli(0, "sync");

  // A synced local package's edit is read by the next command, without a sync.
  writePackage(join(report, "office.ts"), declaring([{ name: "digest", schedule: "@daily", script: "scripts/digest.sh" }, { name: "boxed", schedule: "@weekly", script: "scripts/digest.sh", when: "container" }]));
  write(join(report, "scripts/digest.sh"), "echo digest; exit 23");
  expect(cli(0, "cron", "list")).toBe("office.heartbeat\npackage.office.update-references\npackage.report.digest\npackage.report.boxed\n");
  const crontab = "0 * * * * office cron run office.heartbeat\n0 5 * * * office cron run package.office.update-references\n0 0 * * * office cron run package.report.digest\n0 0 * * 0 office cron run package.report.boxed\n";

  expect(cli(0, "cron", "supercronic")).toBe(crontab);
  writePackage(join(report, "office.ts"), noisy([{ name: "digest", schedule: "@daily", script: "scripts/digest.sh" }, { name: "boxed", schedule: "@weekly", script: "scripts/digest.sh", when: "container" }]));
  expect(streams("cron", "supercronic")).toEqual({ stdout: crontab, stderr: noise });
  expect(streams("cron", "list")).toEqual({ stdout: "office.heartbeat\npackage.office.update-references\npackage.report.digest\npackage.report.boxed\n", stderr: noise });
  writePackage(join(report, "office.ts"), declaring([{ name: "digest", schedule: "@daily", script: "scripts/digest.sh" }, { name: "boxed", schedule: "@weekly", script: "scripts/digest.sh", when: "container" }]));

  // A named run runs from the office folder with the launcher, and exits with the script's status.
  expect(cli(23, "cron", "run", "package.report.digest")).toBe("digest\noffice cron: package.report.digest exited 23\n");
  cli(0, "cron", "run", "office.heartbeat");
  expect(read(join(dir, "heartbeat-ran"))).toBe(`${dir}\n`);
  expect(read(join(dir, "launcher"))).toBe(exe);

  for (const id of ["package.office.upgrade-tools", "package.report.nope", "office.nope"]) expect(cli(1, "cron", "run", id)).toContain(`cron ${id}: not enabled for this office`);
  expect(cli(1, "cron", "run")).toContain("usage: office cron run <job-id>");
  // catch-up-job runs nothing unless catch-up starts it for this office from its folder (here the cwd is elsewhere).
  expect(cli(0, "cron", "catch-up-job", "cron-jobs", "package.report.digest")).toBe("");
  expect(cli(0, "cron", "catch-up-job", "other", "package.report.digest")).toBe("");

  // On a host the container's commands refuse, and a job for the container isn't listed.
  const config = join(dir, "office.yaml");
  const container = read(config);

  write(config, container.replace("opencode: container", "opencode: { mode: host, url: 'http://127.0.0.1:1' }"));
  expect(cli(0, "cron", "list")).toBe("office.heartbeat\npackage.office.update-references\npackage.report.digest\n");
  expect(cli(1, "cron", "supercronic")).toContain("office cron supercronic runs only in the OpenCode container");
  expect(cli(1, "cron", "catch-up")).toContain("office cron catch-up runs only in the OpenCode container");

  // With no job that applies, the crontab is empty, also with a package printing as it loads.
  write(config, container.replace(/ {2}- name: report\n/, "").replace(/ {6}jobs: .*\n/, "").replace("{schedule: '0 5 * * *'}", "{enabled: false}"));
  expect(cli(0, "cron", "supercronic")).toBe("");
  write(config, container.replace(/ {6}jobs: .*\n/, "").replace("{schedule: '0 5 * * *'}", "{enabled: false}"));
  writePackage(join(report, "office.ts"), noisy([]));
  expect(streams("cron", "supercronic")).toEqual({ stdout: "", stderr: noise });

  // The keys before cron was a package are unknown to every command that reads office.yaml in full.
  for (const old of [`${container}cron: {heartbeat: {schedule: '@hourly', script: scripts/heartbeat.sh}}\n`, container.replace("  - name: report\n", "  - name: report\n    cron: {digest: {enabled: false}}\n")]) {
    write(config, old);

    for (const command of [["sync"], ["check"], ["cron", "list"]]) expect(cli(1, ...command)).toMatch(/office\.yaml is not valid:\n {2}(packages\[\d+\]\.)?cron: must be a mapping of/);
  }
}, 60_000);

test("a job's mistakes: the parser's and the settings schema's before the switch, a missing script after it, with sync exiting 1 naming it", () => {
  const { dir, cli, select } = fixture("cron-moments");
  const report = join(dir, "packages/report");
  const config = join(dir, "office.yaml");

  select(`  - name: report\n${cronEntry()}`);
  writePackage(join(report, "office.ts"), declaring([]));
  cli(0, "sync", "--packages");
  const synced = read(config);
  let pointer = activeGeneration(dir);

  writePackage(join(report, "office.ts"), declaring([{ name: "digest", schedule: "every tuesday", script: "scripts/digest.sh" }]));
  expect(cli(1, "sync", "--packages")).toContain("cron job digest: schedule must be five UTC cron fields");
  expect(activeGeneration(dir)).toBe(pointer);

  write(join(dir, "outside.sh"), "true");
  writePackage(join(report, "office.ts"), declaring([{ name: "digest", schedule: "@daily", script: "../outside.sh" }]));
  expect(cli(1, "sync", "--packages")).toContain("cron job digest: script must be a relative .sh path");
  expect(activeGeneration(dir)).toBe(pointer);

  writePackage(join(report, "office.ts"), declaring([]));
  write(config, synced.replace("{overrides:", "{jobs: {heartbeat: {schedule: '@hourly'}}, overrides:"));
  expect(cli(1, "sync", "--packages")).toContain("packages.cron.settings.jobs.heartbeat.script: is required");
  expect(activeGeneration(dir)).toBe(pointer);

  write(config, synced);
  writePackage(join(report, "office.ts"), declaring([{ name: "digest", schedule: "@daily", script: "scripts/absent.sh" }]));
  expect(cli(1, "sync", "--packages")).toContain("cron package.report.digest: scripts/absent.sh must be an existing regular script inside package report's folder");
  expect(activeGeneration(dir)).not.toBe(pointer);
  pointer = activeGeneration(dir);

  // An override naming a job no selected package declares, or one of a deselected package.
  writePackage(join(report, "office.ts"), declaring([]));
  write(config, synced.replace("{overrides: {", "{overrides: {package.report.nope: {enabled: false}, "));
  expect(cli(1, "cron", "list")).toContain("cron override package.report.nope: no selected package declares this job");
  expect(cli(1, "sync", "--packages")).toContain("cron override package.report.nope");
  write(config, synced.replace("  - name: report\n", "").replace("{overrides: {", "{overrides: {package.report.digest: {enabled: false}, "));
  expect(cli(1, "sync", "--packages")).toContain("cron override package.report.digest: no selected package declares this job");

  // A local package can't take the cron package's name.
  write(config, `${synced}`.replace("  - name: report\n", ""));
  writePackage(join(dir, "packages/cron/office.ts"), definitionText("{}"));
  expect(cli(1, "cron", "list")).toContain("built-in package cron conflicts with local packages/cron; rename one before syncing");
  rmSync(join(dir, "packages/cron"), { recursive: true });
  cli(0, "cron", "list");
}, 60_000);

test("a broken package stops a named run, of a package's job and of the office's own; the reference refresh then applies what sync recorded", () => {
  const f = fixture("cron-broken");
  const { dir, home, cli, probe, select } = f;
  const a = join(root, "cron-broken-repo");
  const job = "package.office.update-references";
  const stamp = join(home, `.local/state/office/cron/cron-broken/${job}.stamp`);
  const module = join(dir, "packages/docs/office.ts");
  const checkout = join(dir, "references/docs");

  git(["init", "-qb", "main", a]);
  write(join(a, "document"), "A");
  commit(a);
  select(`  - name: docs\n  - name: cron\n    settings: {jobs: {mine: {schedule: '@daily', script: mine.sh}}, overrides: {package.office.upgrade-tools: {enabled: false}}}\n`);
  write(join(dir, "mine.sh"), "echo mine >> mine-ran");
  writePackage(module, collector(a));
  cli(0, "sync");
  cli(0, "check");

  // Every command loads every package: with docs broken, neither job runs.
  writePackage(module, `${marker} throw Error("broken docs");`);
  rmSync(probe, { force: true });
  write(join(a, "document"), "advanced A");
  const advanced = commit(a);

  for (const id of [job, "office.mine"]) expect(cli(1, "cron", "run", id)).toContain("broken docs");
  expect(existsSync(join(dir, "mine-ran"))).toBe(false);
  expect(existsSync(stamp)).toBe(false);
  expect(git(["rev-parse", "HEAD"], checkout)).not.toBe(advanced);

  // A definition that imports but whose setup throws, after writing a marker that shows it ran, stops them too.
  writePackage(module, definitionText('{setup() { appendFileSync(process.env.PROBE, "set up\\n"); throw Error("docs setup broken"); }}', 'import {appendFileSync} from "node:fs";'));
  rmSync(probe, { force: true });

  for (const id of [job, "office.mine"]) expect(cli(1, "cron", "run", id)).toContain("package docs: docs setup broken");
  expect(read(probe)).toBe("set up\nset up\n");
  expect(existsSync(join(dir, "mine-ran"))).toBe(false);
  expect(existsSync(stamp)).toBe(false);
  expect(git(["rev-parse", "HEAD"], checkout)).not.toBe(advanced);

  // Fixed, the job refreshes the checkout to the ref sync recorded.
  writePackage(module, collector(a));
  expect(cli(0, "cron", "run", job)).toContain("exited 0");
  expect(git(["rev-parse", "HEAD"], checkout)).toBe(advanced);
  expect(read(join(checkout, "document"))).toBe("advanced A");
}, 60_000);

// Only a fresh process sees the helper the preceding job broke; the package's unit tests cover a
// job the preceding one deselected, disabled or rescheduled.
test("catch-up starts each job in a fresh process that sees what a preceding job synced", () => {
  const name = "catch-up";
  const { dir, home, probe, cli } = fixture(name);
  const pkg = join(dir, "packages/later");
  const id = "package.later.tick";
  const stamp = join(home, ".local/state/office/cron", name, `${id}.stamp`);

  write(join(dir, "office.yaml"), `name: ${name}
packages:
  - name: cron
    settings: {jobs: {first: {script: first.sh, schedule: '@daily'}}, overrides: {package.office.update-references: {enabled: false}, package.office.upgrade-tools: {enabled: false}}}
  - name: later
`);
  write(join(dir, "first.sh"), `set -eu\n"$OFFICE_CRON_COMMAND" sync --packages\necho ok > synced\necho 'throw Error("broken tick helper"); export const tick = {}' > packages/later/tick.ts`);
  write(join(pkg, "tick.sh"), "echo stale >> ran");
  write(join(pkg, "tick.ts"), 'export const tick = {name:"tick",script:"tick.sh",schedule:"@hourly"}');
  writePackage(join(pkg, "office.ts"), definitionText(`{setup(c){c.add({id:"cron.jobs",parse:v=>v},tick)}}`, `import {tick} from "./tick.ts";`));
  cli(0, "sync", "--packages");
  const out = cli(1, "cron", "catch-up");
  expect(out).toContain("catching up office.first");
  expect(read(join(dir, "synced"))).toBe("ok\n");
  expect(out).toContain("broken tick helper");
  expect(out).not.toContain(`catching up ${id}`);
  expect(existsSync(join(dir, "ran"))).toBe(false);
  expect(existsSync(probe)).toBe(false);
  expect(existsSync(stamp)).toBe(false);
}, 60_000);

// The parent catch-up stays bound to the set it started with, which still holds a valid old copy;
// the next child binds to the set the first job published, and runs the same id as that set declares it.
test("a catch-up child runs a job as the package set a preceding job published declares it, not as the set catch-up started in", () => {
  const name = "catch-up-set";
  const { dir, home, cli } = fixture(name);
  const repo = join(root, "catch-up-set-source");
  const id = "package.later.tick";
  const tick = (script: string) => declaring([{ name: "tick", schedule: "@hourly", script }]);

  git(["init", "-qb", "main", repo]);
  write(join(repo, "later/old.sh"), "echo old >> ran");
  writePackage(join(repo, "later/office.ts"), tick("old.sh"));
  const before = commit(repo);
  write(join(repo, "later/new.sh"), "echo new >> ran");
  writePackage(join(repo, "later/office.ts"), tick("new.sh"));
  const after = commit(repo);

  const config = (ref: string) => `name: ${name}
packages:
  - name: cron
    settings: {jobs: {first: {script: first.sh, schedule: "@daily"}}, overrides: {package.office.update-references: {enabled: false}, package.office.upgrade-tools: {enabled: false}}}
  - {name: later, repo: ${repo}, path: later, ref: ${ref}}
`;

  write(join(dir, "office.yaml"), config(before));
  // The first job moves the package to the later commit and publishes that set.
  write(join(dir, "first.sh"), `set -eu\nprintf '%s' '${config(after)}' > office.yaml\n"$OFFICE_CRON_COMMAND" sync --packages\n`);
  cli(0, "sync", "--packages");
  const started = activeGeneration(dir);

  const out = cli(0, "cron", "catch-up");
  expect(out).toContain("office cron: office.first exited 0");
  expect(out).toContain(`catching up ${id}`);
  expect(read(join(dir, "ran"))).toBe("new\n");
  expect(existsSync(join(home, ".local/state/office/cron", name, `${id}.stamp`))).toBe(true);
  // The set catch-up started in is still there, and declares the job with a script it holds.
  expect(activeGeneration(dir)).not.toBe(started);
  const old = join(dir, ".office/generations", started ?? "none", "packages/later");
  expect(read(join(old, "office.ts"))).toContain('"script":"old.sh"');
  expect(existsSync(join(old, "old.sh"))).toBe(true);
  expect(existsSync(join(old, "new.sh"))).toBe(false);
}, 60_000);

test("the scheduled reference refresh catches up once at its overridden due time using the named run's stamp", () => {
  const { dir, home, cli } = fixture("ref-schedule");
  const job = "package.office.update-references";
  const stamp = join(home, `.local/state/office/cron/ref-schedule/${job}.stamp`);
  const repo = join(dir, "upstream");
  const checkout = join(dir, "references/docs");
  // A past UTC minute well away from both the next run and the 06:00 default.
  const due = new Date(Date.now() - 8 * 60 * 60_000);
  due.setUTCMinutes(17, 0, 0);

  git(["init", "-qb", "main", repo]);
  write(join(repo, "document"), "first");
  const first = commit(repo);
  write(join(dir, "office.yaml"), `name: ref-schedule
references: [{name: docs, url: ${repo}, ref: main}]
packages: [{name: cron, settings: {overrides: {${job}: {schedule: '17 ${due.getUTCHours()} * * *'}, package.office.upgrade-tools: {enabled: false}}}}]
`);
  cli(0, "sync", "--packages");
  cli(0, "cron", "run", job);
  write(join(repo, "document"), "next");
  const next = commit(repo);
  expect(cli(0, "cron", "catch-up")).not.toContain("catching up");
  expect(git(["rev-parse", "HEAD"], checkout)).toBe(first);
  write(stamp, `${new Date(due.getTime() - 60_000).toISOString()}\n`);
  expect(cli(0, "cron", "catch-up")).toContain(`catching up ${job} (due ${due.toISOString()})`);
  expect(git(["rev-parse", "HEAD"], checkout)).toBe(next);
  expect(cli(0, "cron", "catch-up")).not.toContain("catching up");
}, 60_000);
