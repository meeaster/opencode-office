// A package's `up` and `host.timers` in the compiled office: when `up` functions run, what a broken
// package or a throwing `up` stops, the gathering the finishing readers hand to `up`, and the
// office's name and mode in a command. systemd and Docker are fakes that record their calls.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { definitionFixture, type DefinitionFixture } from "./package-definition.fixture.ts";
import { applyOfficeTools, builtinTools, definitionText, fakeRegistry, writePackage } from "./test-package.ts";

const { exe, write, read, fixture } = definitionFixture({ second: false });

const fs = 'import {appendFileSync, rmSync, writeFileSync} from "node:fs"; import {join} from "node:path";';

/** Fakes that record each call, in one log, to $HOME/calls; Docker fails `compose … up` while $HOME/compose-fails exists. */
function rig(f: DefinitionFixture) {
  write(join(f.home, "bin/docker"), '#!/bin/sh\necho "docker $*" >> "$HOME/calls"\ncase "$*" in *" up -d"*) [ -f "$HOME/compose-fails" ] && exit 1;; esac\nexit 0\n', 0o755);
  write(join(f.home, "bin/systemctl"), '#!/bin/sh\necho "systemctl $*" >> "$HOME/calls"\nexit 0\n', 0o755);
  // `mise outdated --json` finds nothing to move.
  write(join(f.home, "bin/mise"), `#!/bin/sh\n${fakeRegistry}if [ "$1" = --version ]; then echo 2026.11.7; else echo "{}"; fi\n`, 0o755);
}

/** Host mode with no Socket Firewall to install, its state in the office, the server password up needs, and the built-ins' shared tools applied. */
function hostMode(f: DefinitionFixture, entries: string) {
  const initial = read(join(f.dir, "office.yaml"));

  write(join(f.dir, "office.yaml"), `${initial.replace("opencode: container", "opencode: { mode: host, url: 'http://127.0.0.1:1' }").replace(/^ {2}sfw: (\S+)$/m, "  sfw: { version: $1, enabled: false }")}${entries}state: ./state\n`);
  write(join(f.dir, "state/secrets.env"), "OPENCODE_PASSWORD=fixture-only\n");
  applyOfficeTools(join(f.dir, "state"), builtinTools);
}

const calls = (f: DefinitionFixture) => existsSync(join(f.home, "calls")) ? read(join(f.home, "calls")).split("\n").filter(Boolean) : [];

/** The installed units but the cron package's, which host mode installs for the office package's jobs. */
const units = (f: DefinitionFixture) => existsSync(join(f.home, "units")) ? readdirSync(join(f.home, "units")).filter(file => !file.includes("-cron-")).sort() : [];

/** A package whose `up` sets one or two timers and writes a marker with the mode, whose `down` clears them, whose `check` reports inactive ones, and whose command prints the office's mode and name. */
const notes = definitionText(`{
  settings: {type: "object", additionalProperties: false, properties: {two: {type: "boolean", default: true}, at: {type: "string", default: "*-*-* 06:00:00 UTC"}}},
  setup() { appendFileSync(join(process.env.HOME, "counter"), "notes setup\\n") },
  up({office, settings, host}) {
    writeFileSync(join(office.dir, "notes-up"), office.mode);
    return ["up as " + office.name, ...host.timers.set([{id: "a", calendar: settings.at, run: ["notes", "say", "100%", "$HOME"]}, ...(settings.two ? [{id: "b", calendar: "*-*-* 07:00:00 UTC", run: ["notes"]}] : [])])];
  },
  down({office, host}) { rmSync(join(office.dir, "notes-up"), {force: true}); return ["marker removed", ...host.timers.clear()] },
  check({host}) { return host.timers.status().flatMap(t => t.active ? [] : [{level: "warning", message: t.id + " inactive at " + t.calendar}]) },
  commands: {"notes mode": {summary: "Print the mode", run({office}) { console.log(office.mode + " " + office.name) }}},
}`, fs);

const other = definitionText('{up({host}) { return host.timers.set([{id: "x", calendar: "Mon *-*-* 05:00:00 UTC", run: ["other"]}]) }}');

test("up functions run last and set their own timers; a second up changes them; check reads them; down clears only the caller's; a command gets the mode", () => {
  const f = fixture("timers");
  rig(f);
  writePackage(join(f.dir, "packages/notes/office.ts"), notes);
  writePackage(join(f.dir, "packages/other/office.ts"), other);
  hostMode(f, "  - name: notes\n  - name: other\n");
  f.cli(0, "sync", "--packages");
  rmSync(join(f.home, "counter"));

  const first = f.cli(0, "up");
  expect(first).toContain("package notes: up as timers");
  expect(first).toContain("package notes: timer office-timers-notes-a: *-*-* 06:00:00 UTC, a");
  expect(read(join(f.dir, "notes-up"))).toBe("host");
  expect(units(f)).toEqual(["a", "b"].flatMap(id => [`office-timers-notes-${id}.service`, `office-timers-notes-${id}.timer`]).concat(["office-timers-other-x.service", "office-timers-other-x.timer"]));
  expect(read(join(f.home, "units/office-timers-notes-a.service"))).toContain(`"--office" "${f.dir}" "notes" "say" "100%%" "$$HOME"\n`);
  // One gathering: setup ran once. The office's own work came first: Compose started before any timer was enabled.
  expect(read(join(f.home, "counter"))).toBe("notes setup\n");
  const log = calls(f);
  expect(log.findIndex(line => / up -d /.test(line))).toBeLessThan(log.findIndex(line => line.includes("enable --now office-timers-notes-a.timer")));

  write(join(f.dir, "office.yaml"), read(join(f.dir, "office.yaml")).replace("  - name: notes\n", "  - name: notes\n    settings: {two: false, at: 'Tue *-*-* 08:00:00 UTC'}\n"));
  f.cli(0, "up");
  expect(units(f)).toEqual(["office-timers-notes-a.service", "office-timers-notes-a.timer", "office-timers-other-x.service", "office-timers-other-x.timer"]);
  expect(read(join(f.home, "units/office-timers-notes-a.timer"))).toContain("\nOnCalendar=Tue *-*-* 08:00:00 UTC\nPersistent=true\n");

  // The fake reports every timer inactive, as one stopped by hand.
  expect(f.cli(1, "check")).toMatch(/^WARN package notes: a inactive at Tue \*-\*-\* 08:00:00 UTC$/m);

  const others = read(join(f.home, "units/office-timers-other-x.timer"));
  const down = f.cli(0, "down");
  expect(down).toContain("package notes: marker removed");
  expect(down).toMatch(/^package notes: removed office-timers-notes-a\.(timer|service), office-timers-notes-a\.(timer|service)$/m);
  expect(existsSync(join(f.dir, "notes-up"))).toBe(false);
  expect(units(f)).toEqual(["office-timers-other-x.service", "office-timers-other-x.timer"]);
  expect(read(join(f.home, "units/office-timers-other-x.timer"))).toBe(others);

  expect(f.cli(0, "notes", "mode")).toBe("host timers\n");
  write(join(f.dir, "office.yaml"), read(join(f.dir, "office.yaml")).replace(/^opencode: .*$/m, "opencode: { mode: host, managed: true, url: 'http://127.0.0.1:1' }"));
  expect(f.cli(0, "notes", "mode")).toBe("managed-host timers\n");
  write(join(f.dir, "office.yaml"), read(join(f.dir, "office.yaml")).replace(/^opencode: .*$/m, "opencode: container"));
  expect(f.cli(0, "notes", "mode")).toBe("container timers\n");
  // In container mode setting timers fails: up stops at notes' up.
  expect(f.cli(1, "up")).toContain("package notes: its up failed: package notes: host timers can't be set in container mode");
}, 60_000);

test("a package that doesn't load stops up before anything starts; an up that throws stops the later ones and leaves what started", () => {
  const f = fixture("stops");
  rig(f);
  const marking = (name: string) => definitionText(`{up({office}) { writeFileSync(join(office.dir, "${name}-up"), "") }}`, fs);
  writePackage(join(f.dir, "packages/first/office.ts"), marking("first"));
  writePackage(join(f.dir, "packages/thrower/office.ts"), definitionText('{up() { throw Error("up boom") }}'));
  writePackage(join(f.dir, "packages/after/office.ts"), marking("after"));
  f.select("  - name: first\n  - name: thrower\n  - name: after\n");
  f.cli(0, "sync", "--packages");

  const thrown = f.cli(1, "up");
  expect(thrown).toContain("package thrower: its up failed: up boom");
  expect(existsSync(join(f.dir, "first-up"))).toBe(true);
  expect(existsSync(join(f.dir, "after-up"))).toBe(false);
  expect(calls(f).some(line => / up -d /.test(line))).toBe(true);
  expect(calls(f).some(line => / (down|stop|rm) /.test(line))).toBe(false);

  rmSync(join(f.dir, "first-up"));
  rmSync(join(f.home, "calls"));
  writePackage(join(f.dir, "packages/thrower/office.ts"), definitionText('{setup() { throw Error("setup boom") }}'));
  const broken = f.cli(1, "up");
  expect(broken).toContain("packages didn't load, so nothing was started");
  expect(broken).toContain("setup boom");
  expect(broken).toContain("thrower");
  expect(calls(f)).toEqual([]);
  expect(existsSync(join(f.dir, "first-up"))).toBe(false);
  expect(existsSync(join(f.dir, "state"))).toBe(false);
}, 60_000);

test("the readers that finish setup and refresh, and upgrade-tools --apply, gather once and hand that gathering to up", async () => {
  const f = fixture("finishing");
  rig(f);
  const counted = definitionText(`{setup() { appendFileSync(join(process.env.HOME, "counter"), "setup\\n") }, up({office}) { appendFileSync(join(office.dir, "up-ran"), "up\\n") }}`, fs);
  writePackage(join(f.dir, "packages/counted/office.ts"), counted);
  // No pins to move, so upgrade-tools needs no release lookup.
  write(join(f.dir, "office.yaml"), read(join(f.dir, "office.yaml")).replace(/\ntools:\n(?: {2}.*\n)+/, "\n") + "  - name: counted\nstate: ./state\n");
  rmSync(join(f.dir, "mise.toml"), { force: true });
  f.cli(0, "sync", "--packages");
  const generation = readlinkSync(join(f.dir, ".office/current")).split("/")[1];
  // An Executor that answers health and accepts the saved key.
  const executor = Bun.serve({ port: 0, fetch: request => new URL(request.url).pathname === "/api/context" ? Response.json({ organization: "org" }) : new URL(request.url).pathname === "/health" ? new Response("ok") : new Response("no", { status: 500 }) });
  write(join(f.dir, "state/office-executor.env"), "EXECUTOR_TOKEN=fixture\nEXECUTOR_ORGANIZATION=org\n");

  const counts = async (args: string[]) => {
    rmSync(join(f.home, "counter"), { force: true });
    rmSync(join(f.dir, "up-ran"), { force: true });
    const child = Bun.spawn([exe, ...args], { cwd: f.dir, env: { ...f.env, EXECUTOR_PORT: String(executor.port) }, stdout: "pipe", stderr: "pipe" });
    const output = (await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])).slice(0, 2).join("");

    return { counter: existsSync(join(f.home, "counter")) ? read(join(f.home, "counter")) : output, up: existsSync(join(f.dir, "up-ran")) ? read(join(f.dir, "up-ran")) : output };
  };

  try {
    // Each finishing reader goes on to deploy apps and check, which this Executor can't answer: only the counts matter.
    expect(await counts(["--package-reader", f.dir, generation, "--finish-setup", f.dir, "", "", ""])).toEqual({ counter: "setup\n", up: "up\n" });
    expect(await counts(["--package-reader", f.dir, generation, "--finish-refresh", f.dir, ""])).toEqual({ counter: "setup\n", up: "up\n" });
    expect(await counts(["--office", f.dir, "upgrade-tools", "--apply"])).toEqual({ counter: "setup\n", up: "up\n" });
  } finally {
    await executor.stop(true);
  }
}, 90_000);
