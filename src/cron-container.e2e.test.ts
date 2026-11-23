// The cron package in a container-mode office, through the compiled office: `office up` passes the
// OpenCode container the crontab's revision, the container's mount computes the same, and
// `office check` compares the running container's revision with the jobs as they are now and says
// when Supercronic isn't running. Docker and systemctl are stand-ins; Executor and OpenCode are a
// loopback server this test owns, answering only the health and listing reads check makes.
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { containerOfficeDir } from "./office.ts";
import { cronOffice } from "./office-up.fixture.ts";
import { definitionFixture, type DefinitionFixture } from "./package-definition.fixture.ts";

const { root, exe, write, read, fixture } = definitionFixture({ second: false });

// Every plugin an office of the template loads, as the container's OpenCode would list it.
const plugins = ["office", "knowledge", "browser"].map(name => ({ id: name, source: { type: "local", path: `${containerOfficeDir}/.opencode/plugins/${name}` }, state: { status: "active" } }));

const answers = new Map(Object.entries({
  "/health": "ok",
  "/api/info": { version: "2.3.0" },
  "/api/agent": { data: [{ id: "build" }] },
  "/api/skill": { data: [] },
  "/api/plugin": { data: plugins },
  "/api/mcp": { data: [] },
}));

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(request) {
    const answer = answers.get(new URL(request.url).pathname);

    return answer === undefined ? new Response(null, { status: 404 }) : Response.json(answer);
  },
});

afterAll(() => server.stop(true));

/** Calls `office check` may make: systemd's reads, and Compose's list, top and two reads inside the running container. */
const readCall = /^(systemctl --user show |docker compose -p \S+ -f \S+ (ps --status running |top opencode$|exec -T opencode (office --version|printenv OFFICE_CRON_REVISION)$))/;

/** The unit files and the revision the stand-in container holds, by path. */
function bytes(f: DefinitionFixture): Record<string, string> {
  const units = join(f.home, "units");
  const files = existsSync(units) ? readdirSync(units).map(file => join(units, file)) : [];

  return Object.fromEntries([...files, join(f.home, "revision")].map(path => [path, readFileSync(path, "utf8")]));
}

/**
 * `office check`, started without blocking this process, which serves the stand-in Executor and
 * OpenCode; its cron lines. The fixture's check exits 1 for four failures unrelated to cron, always
 * the same: the stand-in container reports no office version, Executor accepts no key, and the two
 * skill folders aren't loaded by the stand-in OpenCode; the test requires exactly those. Check is
 * read-only: the unit files and the container's revision are the same after it, and every call it
 * made is a read.
 */
async function cronCheck(f: DefinitionFixture): Promise<string[]> {
  const before = bytes(f);
  const log = () => readFileSync(join(f.home, "calls"), "utf8").split("\n").filter(Boolean);
  const earlier = log().length;

  const child = Bun.spawn([exe, "--office", f.dir, "check"], { cwd: root, env: f.env, stdout: "pipe", stderr: "pipe" });
  const [output, errors, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  const lines = `${output}${errors}`.split("\n");
  const calls = log().slice(earlier);

  expect(status).toBe(1);
  expect(bytes(f)).toEqual(before);
  expect(calls.filter(line => !readCall.test(line))).toEqual([]);
  expect(calls.some(line => line.endsWith("exec -T opencode printenv OFFICE_CRON_REVISION"))).toBe(true);
  expect(lines.filter(line => /^FAIL (?!cron:|package cron:)/.test(line)).map(line => line.slice(0, line.indexOf(":")))).toEqual(["FAIL office versions", "FAIL Executor key", "FAIL root", "FAIL example"]);

  return lines.filter(line => /^\S+ +cron: /.test(line));
}

test("container mode: up passes the crontab's revision, the mount computes the same, and check compares the running container's and its runner", async () => {
  const f = fixture("cronbox");

  cronOffice(f, write, { ports: String(server.port) });
  // A running opencode container that reports the revision its last `up -d` got, and Supercronic
  // while the file supercronic exists, using only shell builtins: the fixture's PATH has no /bin.
  const h = f.home;

  write(join(h, "bin/docker"), `#!/bin/sh
echo "docker $*" >> '${h}/calls'
case "$*" in
  *" up -d"*) printf '%s' "$OFFICE_CRON_REVISION" > '${h}/revision';;
  *"ps --status running"*) echo opencode;;
  *"printenv OFFICE_CRON_REVISION"*) read -r revision < '${h}/revision'; printf '%s\\n' "$revision";;
  *" top opencode"*) [ -f '${h}/supercronic' ] && echo "1 office supercronic /tmp/office-crontab" || echo "1 office opencode serve";;
esac
exit 0
`, 0o755);
  write(join(f.home, "supercronic"), "");
  const config = join(f.dir, "office.yaml");
  const running = "ok   cron: supercronic runs in the opencode container";

  f.cli(0, "sync");
  f.cli(0, "up");
  const first = read(join(f.home, "revision"));

  // The crontab printed in the container, from the office at another path, hashes to the revision.
  const mounted = join(root, "cronbox-in-container");

  cpSync(f.dir, mounted, { recursive: true, verbatimSymlinks: true });
  const crontab = f.run(exe, 0, "--office", mounted, "cron", "supercronic");

  expect(crontab).toBe("15 6 * * * office cron run office.mine\n0 6 * * * office cron run package.office.update-references\n0 7 * * 1 office cron run package.report.digest\n");
  expect(createHash("sha256").update(crontab.slice(0, -1)).digest("hex")).toBe(first);
  expect(await cronCheck(f)).toEqual([running]);

  // A changed schedule: check says the container's is out of date until up passes a new revision.
  write(config, read(config).replace("overrides: {", "overrides: {package.office.update-references: {schedule: '0 5 * * *'}, "));
  expect(await cronCheck(f)).toEqual(["FAIL cron: the container's schedule is out of date (run office up)"]);
  f.cli(0, "up");
  expect(read(join(f.home, "revision"))).not.toBe(first);
  expect(await cronCheck(f)).toEqual([running]);

  // The revision matches, but Supercronic isn't running.
  rmSync(join(f.home, "supercronic"));
  expect(await cronCheck(f)).toEqual(["FAIL cron: supercronic isn't running in the opencode container"]);

  expect(existsSync(join(f.home, "units/office-cronbox-cron-office.mine.timer"))).toBe(false);
  expect(readFileSync(join(f.home, "calls"), "utf8")).not.toContain("-cron-");
}, 60_000);
