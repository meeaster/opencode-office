import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { git } from "./git.ts";
import { definitionFixture } from "./package-definition.fixture.ts";

const { root, bin, marker, write, read, commit, fixture, collector, pausedRefresh } = definitionFixture();

test("stale refresh needs the actual and last-applied origin/ref; cron runs only its named owner", async () => {
  const f = fixture("cron-refs");
  const { dir, home, cli, probe, select } = f;
  const a = join(root, "repo-a");
  const b = join(root, "repo-b");

  for (const repo of [a, b]) {
    git(["init", "-qb", "main", repo]);
    write(join(repo, "document"), repo);
    commit(repo);
  }

  const module = join(dir, "packages/docs/office.ts");
  const checkout = join(dir, "references/docs");
  const job = "package.office.update-references";
  const stamp = join(home, `.local/state/office/cron/cron-refs/${job}.stamp`);
  const observed = () => [git(["rev-parse", "HEAD"], checkout), read(join(checkout, "document")), read(join(checkout, ".git/FETCH_HEAD"))];
  select("  - name: docs\n");
  write(module, collector(a));
  cli(0, "sync");
  cli(0, "check");
  write(join(checkout, "document"), "dirty A");
  const before = observed();

  write(module, collector(b));
  cli(0, "sync", "--packages");
  write(module, `${marker} throw Error("broken definition");`);
  cli(1, "sync", "--packages");
  rmSync(probe);
  git(["remote", "set-url", "origin", b], checkout);
  expect(cli(1, "sync", "--references")).toContain(`desired ${b} @ main, last applied ${a} @ main`);
  expect(observed()).toEqual(before);
  expect(cli(1, "cron", "run", job)).toContain("exited 1");
  expect(observed()).toEqual(before);
  expect(existsSync(stamp)).toBe(false);
  expect(existsSync(probe)).toBe(false);

  git(["remote", "set-url", "origin", a], checkout);
  git(["switch", "-qc", "release"], a);
  write(join(a, "document"), "pending release");
  commit(a);
  git(["switch", "-q", "main"], a);
  write(module, collector(a, "release"));
  cli(0, "sync", "--packages");
  expect(cli(1, "check", "--verbose")).toContain(`desired ${a} @ release, last applied ${a} @ main`);
  expect(observed()).toEqual(before);

  // A legacy ref alone cannot grant stale authority. A healthy refresh establishes the pair.
  write(module, collector(a));
  cli(0, "sync", "--packages");
  git(["config", "--unset", "office.appliedReference"], checkout);
  git(["config", "office.referenceRef", "main"], checkout);
  write(module, collector(a, "main", 'throw Error("failed");'));
  cli(1, "sync", "--packages");
  expect(cli(1, "sync", "--references")).toContain("no unambiguous applied origin and ref");
  expect(observed()).toEqual(before);
  write(module, collector(a));
  cli(0, "sync");
  write(module, `${marker} throw Error("must not import from cron");`);
  cli(1, "sync", "--packages");
  rmSync(probe);
  write(join(a, "document"), "advanced A");
  const advanced = commit(a);
  expect(cli(0, "cron", "run", job)).toContain("exited 0");
  expect(git(["rev-parse", "HEAD"], checkout)).toBe(advanced);
  expect(read(join(checkout, "document"))).toBe("advanced A");
  const success = read(stamp);
  write(join(a, "document"), "fetched but no longer authorized");
  commit(a);
  write(join(checkout, "document"), "keep through stale apply refusal");
  const lastGood = observed();
  const paused = await pausedRefresh(f);
  git(["config", "--unset", "office.appliedReference"], checkout);
  expect(await paused.resume(1)).toContain("no unambiguous applied");
  expect(observed()).toEqual(lastGood);
  select("  - name: docs\n  - name: office\n    cron: {update-references: {enabled: false}}\n");
  expect(cli(1, "cron", "run", job)).toContain("not enabled");
  expect(read(stamp)).toBe(success);
  expect(existsSync(probe)).toBe(false);
}, 60_000);

test("cron routes mixed job declarations without claiming a local package named cron", () => {
  const { dir, cli } = fixture("mixed-cron");
  const config = join(dir, "office.yaml");

  const declarations = `name: mixed-cron
cron: {report: {script: report.sh, schedule: '@weekly'}}
packages:
  - name: office
    cron: {upgrade-tools: {enabled: false}}
  - name: cron
`;

  write(config, declarations);
  write(join(dir, "report.sh"), "exit 0");
  write(join(dir, "packages/cron/office.ts"), `export default {name:"cron", description:"Local jobs",
    cron:{report:{script:"report.sh",schedule:"@daily",when:"container"}}};`);
  write(join(dir, "packages/cron/report.sh"), `echo "local child"; exit 23`);
  const listing = "office.report\npackage.office.update-references\n";
  expect(cli(0, "cron", "list")).toBe(`${listing}package.cron.report\n`);
  expect(cli(0, "cron", "supercronic")).toBe([
    "0 0 * * 0 office cron run office.report",
    "0 6 * * * office cron run package.office.update-references",
    "0 0 * * * office cron run package.cron.report\n",
  ].join("\n"));
  expect(cli(23, "cron", "run", "package.cron.report")).toBe("local child\noffice cron: package.cron.report exited 23\n");
  write(config, declarations + "opencode: { mode: host, url: 'http://127.0.0.1:1' }\n");
  expect(cli(0, "cron", "list")).toBe(listing);

  for (const args of [["supercronic"], ["catch-up"], ["run"], ["run", "office.report", "extra"]]) {
    expect(cli(1, "cron", ...args)).toBe("office: usage: office cron list | run <job-id>\n");
  }
});

// Only a fresh process sees the helper the preceding job broke; standard/cron/jobs.test.ts covers
// a job the preceding one deselected, disabled by a setting or rescheduled.
test("catch-up checks the next job in a fresh process after a preceding job syncs", () => {
  const name = "catch-up";
  const { dir, home, probe, cli } = fixture(name);
  const pkg = join(dir, "packages/later");
  const id = "package.later.tick";
  const stamp = join(home, ".local/state/office/cron", name, `${id}.stamp`);

  write(join(dir, "office.yaml"), `name: ${name}
cron: {first: {script: first.sh, schedule: '@daily'}}
packages:
  - {name: office, cron: {update-references: {enabled: false}, upgrade-tools: {enabled: false}}}
  - name: unrelated
  - name: later
`);
  write(join(dir, "packages/unrelated/office.ts"), `import {existsSync,appendFileSync} from "node:fs";
    if (existsSync(new URL("../../synced", import.meta.url))) {appendFileSync(process.env.PROBE,"extra import"); throw Error("unrelated import")}
    export default {name:"unrelated",description:"Unrelated"}`);
  write(join(dir, "first.sh"), `set -eu\n"$OFFICE_CRON_COMMAND" sync --packages\necho ok > synced\necho 'throw Error("broken tick helper"); export const tick = {}' > packages/later/tick.ts`);
  write(join(pkg, "tick.sh"), "echo stale >> ran");
  write(join(pkg, "tick.ts"), 'export const tick = {script:"tick.sh",schedule:"@hourly"}');
  write(join(pkg, "office.ts"), `import {tick} from "./tick.ts"; export default {name:"later",description:"Later",registerCron(ctx){ctx.cron.job("tick",tick)}}`);
  cli(0, "sync", "--packages");
  const out = cli(1, "cron", "catch-up");
  expect(out).toContain("catching up office.first");
  expect(read(join(dir, "synced"))).toBe("ok\n");
  expect(out).toContain("broken tick helper");
  expect(out).not.toContain(`catching up ${id}`);
  expect(existsSync(join(dir, "ran"))).toBe(false);
  expect(existsSync(probe)).toBe(false);
  expect(existsSync(stamp)).toBe(false);
});

test("one author registers current-mode jobs and indexed commands without changing the command's synced inputs", () => {
  const { dir, home, probe, cli } = fixture("author-cron");
  const run = "package.report.daily";
  const stamp = join(home, `.local/state/office/cron/author-cron/${run}.stamp`);
  const module = join(dir, "packages/report/office.ts");
  const script = join(dir, "packages/report/daily.sh");
  const data = join(dir, "packages/other/package.yaml");
  write(data, "name: other\ndescription: Legacy jobs\ncron: {weekly: {schedule: '@weekly', script: weekly.sh}}\n");
  write(join(dir, "packages/other/weekly.sh"), "true");
  write(script, "echo ran >> runs; test ! -e fail || exit 29");
  write(join(dir, "packages/report/two.sh"), "echo two > unsynced");
  const spare = join(dir, "packages/spare/office.ts");
  write(spare, 'export default {name:"spare",description:"Unrelated"}');

  const hour = (new Date().getUTCHours() + 12) % 24;

  const configure = (mode: string, label: string, enabled = true) => write(join(dir, "office.yaml"), `name: author-cron
opencode: ${mode}
packages:
  - name: report
    settings: {label: ${label}}
    cron: {daily: {enabled: ${enabled}, schedule: '0 ${hour} * * *'}}
  - {name: other}
  - {name: spare}
  - name: office
    cron: {update-references: {enabled: false}, upgrade-tools: {enabled: false}}
`);

  const definition = (extra = "") => `import {appendFileSync} from "node:fs";
    const log = line => appendFileSync(process.env.PROBE,line+"\\n");
    export default {name:"report",description:"Reports",
    settings:{label:{description:"Edition",default:"one"}},
    setup(ctx) {
      log("setup:"+ctx.settings.label);
      ctx.command({name:"report edition",summary:"Print edition",run(){console.log(ctx.settings.label)}});
      ctx.add({registry:"references.repository",value:{name:"edition",url:ctx.settings.label}});
    },
    registerCron(ctx) {
      log("cron:"+ctx.settings.label);
      ctx.cron.job("daily",ctx.cron.mode==="host" ? false : {script:ctx.settings.label==="two"?"two.sh":"daily.sh",schedule:"@daily"});
      ${extra}
    }}`;

  write(module, definition());
  configure("container", "one");
  cli(0, "sync", "--packages");
  expect(read(probe)).toBe("cron:one\nsetup:one\n");
  expect(existsSync(join(dir, "runs"))).toBe(false);
  expect(existsSync(join(home, "units"))).toBe(false);
  expect(cli(0, "cron", "supercronic")).toBe(`0 ${hour} * * * office cron run ${run}\n0 0 * * 0 office cron run package.other.weekly\n`);
  write(join(dir, "fail"), "");
  expect(cli(29, "cron", "run", run)).toContain("exited 29");
  expect(existsSync(stamp)).toBe(false);
  rmSync(join(dir, "fail"));
  expect(cli(0, "cron", "catch-up")).toContain(`catching up ${run}`);
  expect(cli(0, "cron", "catch-up")).not.toContain(`catching up ${run}`);
  expect(read(join(dir, "runs"))).toBe("ran\nran\n");
  const success = read(stamp);
  configure("container", "two", false);
  expect(cli(1, "cron", "run", run)).toContain("not enabled");
  configure("{mode: host, url: 'http://127.0.0.1:1'}", "two");
  expect(cli(0, "cron", "list")).toBe("package.other.weekly\n");
  expect(cli(0, "report", "edition")).toContain("one");
  configure("{mode: host, managed: true, url: 'http://127.0.0.1:1'}", "two");
  expect(cli(0, "cron", "list")).toContain(`package.office.update-agent-clis\n${run}\n`);
  expect(read(stamp)).toBe(success);

  write(spare, `${marker} throw Error("unrelated module");`);
  rmSync(probe);
  cli(0, "cron", "run", run);
  expect(read(join(dir, "unsynced"))).toBe("two\n");
  expect(read(probe)).toBe("cron:two\n");
  expect(cli(0, "report", "edition")).toContain("one");
  expect(cli(0, "references", "list")).toContain("edition\tone");
  expect(read(probe)).toBe("cron:two\nsetup:one\n");
  write(spare, 'export default {name:"spare",description:"Unrelated"}');

  // A failed collector is not a successful empty list, even after making a valid registration.
  write(module, definition('throw Error("incomplete cron batch")'));
  expect(cli(1, "sync", "--packages")).toContain("incomplete cron batch");
  expect(cli(0, "--help")).not.toContain("report edition");
  expect(cli(1, "cron", "run", run)).toContain("incomplete cron batch");
  expect(cli(1, "up")).toContain("incomplete cron batch");
  expect(read(join(dir, "runs"))).toBe("ran\nran\n");
  expect(read(stamp)).toBe(success);

  write(module, 'export default {name:"report",description:"Withdrawn",settings:{label:{description:"Edition",default:"one"}},registerCron(){}}');
  expect(cli(1, "sync", "--packages")).toContain("packages.report.cron.daily: no such job");
  const config = join(dir, "office.yaml");
  write(config, read(config).replace(/^    cron: \{daily:.*\n/m, ""));
  cli(0, "sync", "--packages");
  expect(cli(1, "cron", "run", run)).toContain("not enabled");
  expect(read(stamp)).toBe(success);
}, 60_000);

test("an invalid registration rejects the owner's batch before a valid sibling can run", () => {
  const { dir, cli, probe, select } = fixture("bad-cron");
  select("  - name: report\n");
  const pkg = join(dir, "packages/report");
  write(join(pkg, "run.sh"), "echo bad >> started");
  const job = '{schedule:"@daily",script:"run.sh"}';

  // One data conflict and one asynchronous hook end to end; standard/cron/jobs.test.ts covers the other invalid registrations.
  for (const [data, extra, reason] of [
    [`cron:{first:${job}},`, "", "duplicate cron job package.report.first"],
    ["", 'return Promise.reject(Error("async job discovery"))', "synchronously"],
  ]) {
    write(join(pkg, "office.ts"), `export default {name:"report",description:"Reports",${data}
      registerCron(ctx){ctx.cron.job("first",${job}); ${extra}}}`);
    expect(cli(1, "cron", "run", "package.report.first")).toContain(reason);
    expect(existsSync(join(dir, "started"))).toBe(false);
  }

  write(join(pkg, "office.ts"), `import {writeFileSync} from "node:fs"; export default {name:"report",description:"Reports",
    async registerCron(){await Promise.resolve(); writeFileSync(process.env.PROBE,"async hook ran")}}`);
  expect(cli(1, "sync", "--packages")).toContain("register jobs synchronously");
  expect(existsSync(probe)).toBe(false);
  write(join(pkg, "office.ts"), 'export default {name:"report",description:"Reports",setup(ctx){if (ctx.cron?.mode) ctx.cron.job("bad",false)}}');
  expect(cli(1, "sync", "--packages")).toContain("ctx.cron belongs in registerCron(ctx)");
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
packages: [{name: office, cron: {update-references: {schedule: '17 ${due.getUTCHours()} * * *'}, upgrade-tools: {enabled: false}}}]
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
