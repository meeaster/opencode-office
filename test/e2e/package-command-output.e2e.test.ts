// What a package command writes, seen at the process boundary, through the compiled office and the
// checkout's bin/office: a `result` handler's text alone on standard output whatever package code
// prints while gathering (child processes with inherited output included) and after; a `run`
// handler's streaming output, terminal and exit status; help; and one gathering per command.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { definitionFixture } from "../support/package-definition.fixture.ts";
import { definitionText, writePackage } from "../support/test-package.ts";
import { toolPath } from "../../src/tool.ts";

const { root, exe, write, fixture } = definitionFixture({ second: false });
const checkout = toolPath(".");

// Prints every way package code can reach descriptor 1 while it is imported and set up, counts its
// setups, with NOISY_LATE prints again after gathering, and with NOISY_FAIL throws after gathering.
const noisy = definitionText(`{
  async setup() {
    appendFileSync(process.env.PROBE + ".setups", "setup\\n");
    console.log("setup log");
    process.stdout.write("setup write\\n");
    writeSync(1, "setup fd\\n");
    const helper = Bun.spawn(["/bin/sh", "-c", 'printf "%s\\\\n" "helper stdout"'], { stdout: "inherit", stderr: "inherit" });
    if (await helper.exited !== 0) throw Error("helper failed");
    if (process.env.NOISY_LATE) setTimeout(() => {
      console.log("late log");
      process.stdout.write("late write\\n");
      Bun.spawn(["/bin/sh", "-c", "echo late helper"], { stdout: "inherit", stderr: "inherit" });
    }, 50);
    if (process.env.NOISY_FAIL) setTimeout(() => { throw Error("late failure"); }, 50);
  },
}`, 'import { appendFileSync, writeSync } from "node:fs";\nconsole.log("module log");');

const probe = definitionText(`{
  commands: {
    "probe text": {
      summary: "Returns text",
      usage: "<kind>",
      async result({ args, office }) {
        await Promise.resolve();
        console.log("handler log");
        if (args[0] === "fail") throw Error("result failed");
        if (args[0] === "number") return 7;
        if (args[0] === "status") process.exitCode = 23;
        if (args[0] === "bun-options") return spawnSync("/bin/sh", ["-c", 'printf "%s\\\\n" "\${BUN_OPTIONS-unset}" "\${OFFICE_CALLER_BUN_OPTIONS-unset}"']).stdout.toString();
        if (args[0] === "hold-result") {
          const holder = Bun.spawn(["/bin/sh", "-c", 'for i in $(/usr/bin/seq 500); do [ -f "$RESULT_GATE" ] && exit; /bin/sleep .02; done'], { stdio: ["ignore", "ignore", "ignore", "ignore", 4] });
          holder.unref();
          writeFileSync(join(office.dir, "reader-pid"), String(process.pid));
          return "buffered result";
        }
        return { lines: "one\\ntwo", terminated: "one\\ntwo\\n", empty: "", large, status: large }[args[0]];
      },
    },
    "probe act": {
      summary: "Runs a script",
      async run() {
        console.log("handler tty " + (process.stdout.isTTY === true));
        process.stdout.write("handler write\\n");
        const script = Bun.spawn(["/bin/sh", "-c", 'echo "script stdout"; echo "script stderr" >&2; [ -t 1 ] && echo "script tty"; while [ ! -f "$GATE" ]; do sleep 0.02; done; exit 23'], { stdio: ["inherit", "inherit", "inherit"] });
        process.exitCode = await script.exited;
      },
    },
  },
}`, 'import { spawnSync } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nimport { join } from "node:path";\nconst large = "x".repeat(1 << 20);');

const noise = "module log\nsetup log\nsetup write\nsetup fd\nhelper stdout\n";

// More than a pipe holds; the result travels through one.
const large = `${"x".repeat(1 << 20)}\n`;

function office(name: string) {
  const f = fixture(name);
  const gate = join(f.home, "gate");
  const bun = join(f.home, "bun");

  // The checkout's bin/office starts with `env bun`: only Bun is added to PATH.
  mkdirSync(bun);
  symlinkSync(process.execPath, join(bun, "bun"));
  f.select("  - name: noisy\n  - name: probe\n");
  writePackage(join(f.dir, "packages/noisy/office.ts"), noisy);
  writePackage(join(f.dir, "packages/probe/office.ts"), probe);
  f.cli(0, "sync");
  writeFileSync(gate, "");

  const launchers = { compiled: [exe], source: [join(checkout, "bin/office")] };
  const env = (extra: Record<string, string> = {}) => ({ ...f.env, PATH: `${bun}:${f.env.PATH}`, GATE: gate, ...extra });
  const setups = () => readFileSync(`${f.probe}.setups`, "utf8").split("\n").length - 1;

  /** Runs office with standard output and standard error as separate pipes. */
  const streams = (launcher: keyof typeof launchers, args: string[], extra: Record<string, string> = {}) => {
    const result = Bun.spawnSync([...launchers[launcher], "--office", f.dir, ...args], { cwd: root, env: env(extra) });

    return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  };

  /**
   * Runs office in a pseudo-terminal, with one of its streams sent to a file instead, or neither
   * (`file` "none", the file then empty); returns both.
   */
  const terminal = async (launcher: keyof typeof launchers, args: string[], file: "stdout" | "stderr" | "none") => {
    const path = join(f.home, `${file}.txt`);
    const run = { stdout: '"$@" >"$FILE"', stderr: '"$@" 2>"$FILE"', none: ': >"$FILE"; "$@"' }[file];
    let screen = "";

    const shell = Bun.spawn(["/bin/sh", "-c", `${run}; status=$?; printf '<end>'; exit $status`, "sh", ...launchers[launcher], "--office", f.dir, ...args], {
      cwd: root, env: env({ FILE: path }), terminal: { cols: 200, rows: 24, data: (_, data) => { screen += new TextDecoder().decode(data); } },
    });

    const status = await shell.exited;

    for (let i = 0; i < 200 && !screen.endsWith("<end>"); i++) await Bun.sleep(10);
    shell.terminal?.close();

    return { status, screen: screen.replace(/<end>$/, "").replaceAll("\r\n", "\n"), file: readFileSync(path, "utf8") };
  };

  /**
   * Runs office with standard output and standard error opened on one file separately, standard
   * error appending: each writes at its own offset, so what went through which shows.
   */
  const separate = (launcher: keyof typeof launchers, args: string[]) => {
    const path = join(f.home, "separate.txt");
    const result = Bun.spawnSync(["/bin/sh", "-c", '"$@" >"$FILE" 2>>"$FILE"', "sh", ...launchers[launcher], "--office", f.dir, ...args], { cwd: root, env: env({ FILE: path }) });

    return { status: result.exitCode, file: readFileSync(path, "utf8") };
  };

  return { ...f, gate, launchers, env, setups, streams, terminal, separate };
}

for (const launcher of ["compiled", "source"] as const) {
  test(`${launcher}: a result is all of standard output, whatever package code prints while gathering and after`, () => {
    const f = office(`result-${launcher}`);
    const late = { NOISY_LATE: "1" };
    // Nothing a command does needs a temporary folder.
    const missing = { TMPDIR: join(f.home, "missing") };
    const after = "handler log\nlate log\nlate write\nlate helper\n";
    let count = f.setups();

    for (const [kind, stdout] of [["lines", "one\ntwo\n"], ["terminated", "one\ntwo\n"], ["empty", ""]]) {
      expect(f.streams(launcher, ["probe", "text", kind], late)).toEqual({ status: 0, stdout, stderr: noise + after });
      expect(f.setups()).toBe(++count);
    }

    expect(f.streams(launcher, ["probe", "text", "large"], missing)).toEqual({ status: 0, stdout: large, stderr: `${noise}handler log\n` });
    expect(f.setups()).toBe(++count);

    for (const [kind, message] of [["fail", "result failed"], ["number", "probe text: its result must be text: Invalid type: Expected string but received 7"]]) {
      const failed = f.streams(launcher, ["probe", "text", kind]);

      expect({ status: failed.status, stdout: failed.stdout }).toEqual({ status: 1, stdout: "" });
      expect(failed.stderr).toBe(`${noise}handler log\noffice: ${message}\n`);
      expect(f.setups()).toBe(++count);
    }

    // A result returned, more than a pipe holds, then the reader failed: its own exit status, or a throw after the handler.
    expect(f.streams(launcher, ["probe", "text", "status"])).toEqual({ status: 23, stdout: "", stderr: `${noise}handler log\n` });
    expect(f.setups()).toBe(++count);
    const thrown = f.streams(launcher, ["probe", "text", "lines"], { NOISY_FAIL: "1" });

    expect({ status: thrown.status, stdout: thrown.stdout }).toEqual({ status: 1, stdout: "" });
    expect(thrown.stderr).toStartWith(`${noise}handler log\n`);
    expect(thrown.stderr).toContain("late failure");
    expect(f.setups()).toBe(++count);

    const unknown = f.streams(launcher, ["probe", "nope"]);

    expect({ status: unknown.status, stdout: unknown.stdout }).toEqual({ status: 2, stdout: "" });
    expect(unknown.stderr).toStartWith(noise);
    expect(unknown.stderr).toContain("Unknown command or options: probe nope");
    expect(f.setups()).toBe(++count);

    const help = f.streams(launcher, ["--help"], missing);

    expect({ status: help.status, stderr: help.stderr }).toEqual({ status: 0, stderr: noise });
    expect(help.stdout).toStartWith("usage: office");
    expect(help.stdout).toContain("  probe text <kind>    Returns text\n  probe act    Runs a script\n");
    expect(f.setups()).toBe(++count);
  });

  test(`${launcher}: a run handler streams its script's output before it exits, with the script's status`, async () => {
    const f = office(`run-${launcher}`);
    const count = f.setups();

    expect(f.streams(launcher, ["probe", "act"], { TMPDIR: join(f.home, "missing") })).toEqual({ status: 23, stdout: "handler tty false\nhandler write\nscript stdout\n", stderr: `${noise}script stderr\n` });
    expect(f.setups()).toBe(count + 1);

    const waiting = join(f.home, "waiting");
    const child = Bun.spawn([...f.launchers[launcher], "--office", f.dir, "probe", "act"], { cwd: root, env: f.env({ GATE: waiting }), stdout: "pipe", stderr: "pipe" });
    const reader = child.stdout.getReader();
    const deadline = Date.now() + 15_000;
    let seen = "";

    try {
      while (!seen.includes("script stdout\n") && Date.now() < deadline) {
        const { value, done } = await Promise.race([reader.read(), Bun.sleep(deadline - Date.now()).then(() => ({ value: undefined, done: true }))]);

        if (done) break;
        seen += new TextDecoder().decode(value);
      }

      expect({ seen, exited: child.exitCode }).toEqual({ seen: "handler tty false\nhandler write\nscript stdout\n", exited: null });
      await Bun.write(waiting, "");
      expect(await child.exited).toBe(23);
    } finally {
      // Whatever failed above, the script stops waiting and office doesn't outlive the test.
      await Bun.write(waiting, "");
      child.kill();
    }
  });

  test(`${launcher}: in a terminal, standard output and standard error stay apart`, async () => {
    const f = office(`terminal-${launcher}`);

    // Standard output is the terminal and standard error a file.
    expect(await f.terminal(launcher, ["probe", "text", "lines"], "stderr")).toEqual({ status: 0, screen: "one\ntwo\n", file: `${noise}handler log\n` });
    expect(await f.terminal(launcher, ["probe", "act"], "stderr")).toEqual({ status: 23, screen: "handler tty true\nhandler write\nscript stdout\nscript tty\n", file: `${noise}script stderr\n` });

    // Standard error is the terminal and standard output a file.
    expect(await f.terminal(launcher, ["probe", "text", "lines"], "stdout")).toEqual({ status: 0, screen: `${noise}handler log\n`, file: "one\ntwo\n" });
    expect(await f.terminal(launcher, ["probe", "act"], "stdout")).toEqual({ status: 23, screen: `${noise}script stderr\n`, file: "handler tty false\nhandler write\nscript stdout\n" });

    // Both are the terminal.
    expect(await f.terminal(launcher, ["probe", "text", "lines"], "none")).toEqual({ status: 0, screen: `${noise}handler log\none\ntwo\n`, file: "" });
    expect(await f.terminal(launcher, ["probe", "act"], "none")).toEqual({ status: 23, screen: `${noise}handler tty true\nhandler write\nscript stdout\nscript stderr\nscript tty\n`, file: "" });
  });

  test(`${launcher}: standard output and standard error opened on one file separately stay apart`, () => {
    const f = office(`separate-${launcher}`);
    const diagnostics = `${noise}handler log\n`;

    // Standard error appended the diagnostics at its own offset; the result then went to standard output's, the file's start.
    expect(f.separate(launcher, ["probe", "text", "lines"])).toEqual({ status: 0, file: `one\ntwo\n${diagnostics.slice("one\ntwo\n".length)}` });
  });
}

test("the compiled reader restores the caller's Bun options before a package starts a process", () => {
  const f = office("bun-options");
  const args = ["probe", "text", "bun-options"];

  for (const [env, options] of [[{ BUN_OPTIONS: "--smol" }, "--smol"], [{ BUN_OPTIONS: "" }, "unset"], [{}, "unset"]] as const) {
    expect(f.streams("compiled", args, env)).toEqual({ status: 0, stdout: `${options}\nunset\n`, stderr: `${noise}handler log\n` });
  }
});

test("an ordinary command keeps its SIGINT handler while a descendant still holds its result pipe", async () => {
  const f = office("result-pipe");
  const gate = join(f.home, "result-gate");
  const pidFile = join(f.dir, "reader-pid");
  const child = Bun.spawn([exe, "--office", f.dir, "probe", "text", "hold-result"], { cwd: root, env: f.env({ RESULT_GATE: gate }), stdout: "pipe", stderr: "pipe" });
  const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);

  try {
    for (let attempt = 0; attempt < 300 && child.exitCode === null; attempt++) {
      if (existsSync(pidFile) && !existsSync(join("/proc", readFileSync(pidFile, "utf8")))) break;
      await Bun.sleep(20);
    }

    expect(existsSync(pidFile)).toBe(true);
    expect(existsSync(join("/proc", readFileSync(pidFile, "utf8")))).toBe(false);
    expect(child.exitCode).toBeNull();
    child.kill("SIGINT");
    writeFileSync(gate, "");
    expect(await child.exited).toBe(0);
    expect(await output).toEqual(["buffered result\n", `${noise}handler log\n`]);
  } finally {
    writeFileSync(gate, "");

    if (child.exitCode === null) child.kill();
  }
});

// Declares two cron jobs and two references, through handles with the registries' ids, when its setup runs with REPORT_FULL.
const report = definitionText(`{
  setup(c) {
    if (!process.env.REPORT_FULL) return;
    c.add(jobs, { name: "digest", schedule: "@daily", script: "scripts/job.sh" });
    c.add(jobs, { name: "hourly", schedule: "@hourly", script: "scripts/job.sh" });
    c.add(repositories, { name: "zeta", url: "https://example.invalid/zeta.git", ref: "main" });
    c.add(repositories, { name: "alpha", url: "https://example.invalid/alpha.git" });
  },
}`, 'const jobs = { id: "cron.jobs", parse: value => value };\nconst repositories = { id: "references.repository", parse: value => value };');

for (const launcher of ["compiled", "source"] as const) {
  test(`${launcher}: cron list, cron supercronic and references list print only their text beside a noisy package`, () => {
    const f = office(`converted-${launcher}`);
    const quiet = "  - name: cron\n    settings: {overrides: {package.office.update-references: {enabled: false}, package.office.upgrade-tools: {enabled: false}}}\n";

    writePackage(join(f.dir, "packages/report/office.ts"), report);
    write(join(f.dir, "packages/report/scripts/job.sh"), "true\n");
    f.select(`  - name: noisy\n  - name: probe\n  - name: report\n${quiet}`);
    f.cli(0, "sync");
    const full = { REPORT_FULL: "1" };
    const clean = (stdout: string) => ({ status: 0, stdout, stderr: noise });

    expect(f.streams(launcher, ["cron", "supercronic"], full)).toEqual(clean("0 0 * * * office cron run package.report.digest\n0 * * * * office cron run package.report.hourly\n"));
    expect(f.streams(launcher, ["cron", "list"], full)).toEqual(clean("package.report.digest\npackage.report.hourly\n"));
    expect(f.streams(launcher, ["references", "list"], full)).toEqual(clean("zeta\thttps://example.invalid/zeta.git @ main\tpackage report\nalpha\thttps://example.invalid/alpha.git\tpackage report\n"));

    // Nothing applies, and nothing is listed: no bytes at all.
    for (const words of [["cron", "supercronic"], ["cron", "list"], ["references", "list"]]) expect(f.streams(launcher, words)).toEqual(clean(""));

    // Extra words and the wrong mode fail with nothing on standard output.
    const failing = (words: string[], message: string) => {
      const result = f.streams(launcher, words, full);

      expect({ status: result.status, stdout: result.stdout }).toEqual({ status: 1, stdout: "" });
      expect(result.stderr).toStartWith(noise);
      expect(result.stderr).toContain(message);
    };

    failing(["cron", "list", "extra"], "usage: office cron list");
    failing(["cron", "supercronic", "extra"], "usage: office cron supercronic");
    failing(["references", "list", "extra"], "office references list takes no arguments, not extra");
    const config = join(f.dir, "office.yaml");

    writeFileSync(config, readFileSync(config, "utf8").replace("opencode: container", "opencode: { mode: host, url: 'http://127.0.0.1:1' }"));
    failing(["cron", "supercronic"], "office cron supercronic runs only in the OpenCode container");
    expect(f.streams(launcher, ["cron", "list"], full)).toEqual(clean("package.report.digest\npackage.report.hourly\n"));

    const help = f.streams(launcher, ["--help"]);

    expect({ status: help.status, stderr: help.stderr }).toEqual({ status: 0, stderr: noise });

    for (const line of ["  references list    Show desired references", "  cron list    List the jobs", "  cron supercronic    In the OpenCode container"]) expect(help.stdout).toContain(line);
  });
}
