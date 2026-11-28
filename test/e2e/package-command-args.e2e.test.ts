// Words after a package command's name, in the compiled office: they reach the command exactly as
// typed, through the first process and the reader, while the CLI's own commands keep their options.
import { expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "../../packages/seeds/store.ts";
import { definitionFixture } from "../support/package-definition.fixture.ts";
import { definitionText, writePackage } from "../support/test-package.ts";

const { root, exe, write, read, fixture } = definitionFixture({ second: false });

test("a package command gets the words after its name as typed: paths with spaces, flags the CLI's commands use, the longest name winning", () => {
  const { dir, cli, run, select } = fixture("args");
  const echo = (name: string) => `run({args}){console.log(${JSON.stringify(name)}, JSON.stringify(args))}`;
  writePackage(join(dir, "packages/notes/office.ts"), definitionText(`{commands:{"notes":{summary:"Notes",${echo("notes")}},"notes show":{summary:"Show a note",usage:"<path>",aliases:["notes cat"],${echo("show")}}}}`));
  select("  - name: notes\n");
  cli(0, "sync");

  expect(cli(0, "notes", "show", "a/b.md", "--raw")).toBe('show ["a/b.md","--raw"]\n');
  expect(cli(0, "notes", "show", "my notes/a b.md")).toBe('show ["my notes/a b.md"]\n');
  expect(cli(0, "notes", "cat", "x")).toBe('show ["x"]\n');
  expect(cli(0, "notes", "show")).toBe("show []\n");
  expect(cli(0, "notes", "other")).toBe('notes ["other"]\n');
  expect(cli(0, "notes", "show", "--force")).toBe('show ["--force"]\n');
  // From outside the office, with --office after the words.
  expect(run(exe, 0, "notes", "show", "x", "--office", dir)).toBe('show ["x"]\n');
  expect(cli(0, "--help")).toContain("  notes show <path> | notes cat <path>    Show a note");
  expect(cli(0, "notes", "show", "-h")).toContain("usage: office <command>");

  // After --, every word is the package's, --office and --help too, and --office before it still picks the office.
  expect(run(exe, 0, "--office", dir, "notes", "show", "--", "--office", "/elsewhere", "--help")).toBe('show ["--","--office","/elsewhere","--help"]\n');
  expect(cli(0, "notes", "--", "-h")).toBe('notes ["--","-h"]\n');
  expect(cli(1, "notes", "show", "--office")).toContain("office: option --office needs a folder: --office <dir>");
  expect(cli(1, "notes", "show", "--office", "--help")).toContain("office: option --office is ambiguous: --help starts with a dash");

  // The CLI's own commands still refuse an option they don't know; a command that takes no words says so.
  expect(cli(1, "check", "--force")).toContain("Unknown option '--force'");
}, 60_000);

test("package handler errors print one line on stderr and exit 1", () => {
  const { dir, env, cli, select } = fixture("command-errors");
  select("  - name: skills\n  - name: executor\n");
  cli(0, "sync", "--packages");

  for (const [args, message] of [
    [["cron", "run", "nope"], "cron nope: not enabled for this office; see office cron list"],
    [["cron", "list", "extra"], "usage: office cron list"],
    [["skills", "list", "x"], "usage: office skills list"],
    [["apps", "deploy", "extra"], "usage: office apps deploy [--verbose]"],
    [["apps", "adopt"], "usage: office apps adopt <catalog-id>"],
    [["seeds", "diff", "one", "two"], "usage: office seeds diff [<path>]: one path at most, not 2"],
    [["seeds", "settle"], "usage: office seeds settle <path>: exactly one path, not 0"],
    [["references", "list", "extra"], "office references list takes no arguments, not extra"],
  ] satisfies [string[], string][]) {
    const result = Bun.spawnSync([exe, "--office", dir, ...args], { cwd: root, env });

    expect({ status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }).toEqual({
      status: 1, stdout: "", stderr: `office: ${message}\n`,
    });
  }
});

test("a package handler's error naming two problems fits on one stderr line", () => {
  const { dir, env, cli, select } = fixture("command-error-list");
  const scripts = ["one.sh", "two.sh"];
  select("  - name: cron\n    settings:\n      jobs:\n        one: { schedule: '@daily', script: one.sh }\n        two: { schedule: '@daily', script: two.sh }\n");

  for (const script of scripts) write(join(dir, script), "true\n");
  cli(0, "sync", "--packages");

  for (const script of scripts) rmSync(join(dir, script));

  const result = Bun.spawnSync([exe, "--office", dir, "cron", "list"], { cwd: root, env });
  const errors = scripts.map(script => `cron office.${script.slice(0, -3)}: ${script} must be an existing regular script inside the office folder, with no symlink`);

  expect({ status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() }).toEqual({
    status: 1, stdout: "", stderr: `office: ${errors.join("; ")}\n`,
  });
});

test("the seeds commands office prints for paths that look like options run as printed, each on its own path in this office", () => {
  const { dir, env, cli, select } = fixture("printed");
  const paths = ["--help", "--office=elsewhere", "--"];
  const declare = (text: string) => writePackage(join(dir, "packages/flags/office.ts"), definitionText(`{setup(c){${paths.map(path => `seeds.add(c,{destination:${JSON.stringify(path)},text:${JSON.stringify(text)}})`).join(";")}}}`, 'import {seeds} from "@office/seeds";'), { dependencies: ["seeds"] });
  const receipts = () => JSON.parse(read(join(dir, ".office/seeds/receipts.json"))).receipts;
  const rootEntries = readdirSync(root).sort();

  /** Runs a printed command line through the shell, from the office's folder, as the owner would paste it. */
  const shell = (line: string) => {
    const result = Bun.spawnSync(["/bin/sh", "-c", line], { cwd: dir, env });
    const output = result.stdout.toString() + result.stderr.toString();

    expect(result.exitCode, output).toBe(0);

    return output;
  };

  declare("v1\n");
  select("  - name: flags\n");
  cli(0, "sync");

  for (const path of paths) write(join(dir, path), "the owner's\n");
  declare("v2\n");
  const synced = cli(0, "sync");

  for (const path of paths) {
    const diff = new RegExp(`pending ${path}: .*; (office seeds diff .*)$`, "m").exec(synced)?.[1];

    expect(diff).toBe(`office seeds diff -- ${path}`);
    const shown = shell(diff!);

    expect(shown).toContain("What you changed (the seed office laid down → your file):");
    const settle = /^ {2}(office seeds settle .*)$/m.exec(shown)?.[1];

    expect(settle).toBe(`office seeds settle -- ${path}`);
    const before = receipts();

    expect(shell(settle!)).toStartWith(`settled ${path}: recorded package flags's seed`);
    expect(receipts()).toEqual({ ...before, [path]: { package: "flags", sha256: sha256("v2\n") } });
    expect(read(join(dir, path))).toBe("the owner's\n");
  }

  // Nothing reached the CLI as an option: no other office was looked for or made.
  expect(existsSync(join(dir, "elsewhere"))).toBe(false);
  expect(readdirSync(root).sort()).toEqual(rootEntries);
}, 60_000);
