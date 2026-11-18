import { expect, test } from "bun:test";

import { CommandFailed, stream, streamChecked } from "./index.ts";
import { PlainReporter } from "./plain.ts";
import { displayLines } from "./reporter.ts";

function plain(verbose = false) {
  const out: string[] = [];
  const err: string[] = [];

  return { out, err, reporter: new PlainReporter("office setup", verbose, (line) => out.push(line), (line) => err.push(line)) };
}

test("the plain renderer writes one line per event, prefixed with the stage's key, and nothing else", async () => {
  const { out, err, reporter } = plain();

  reporter.begin("office personal · host mode · ~/office");

  const stage = reporter.stage("Tools", { key: "tools" });

  expect(reporter.active).toBe(stage);
  stage.detail("checking docker");
  stage.output("mise node@24 download");
  stage.note("installed\nby mise");
  stage.warn("one tool is missing");
  stage.error("FAILED package demo: broken");
  expect(await stage.inherit("office check", () => 42)).toBe(42);
  stage.done("3 tools");
  expect(reporter.active).toBeUndefined();
  reporter.note("between stages");
  reporter.finish([{ title: "Next steps", items: [{ label: "Pair", value: "office pair" }, { label: "Add this line:" }, { label: "", value: "source ~/env.sh" }] }]);

  expect(out).toEqual([
    "office setup: office personal · host mode · ~/office",
    "tools: checking docker",
    "tools: installed",
    "tools: by mise",
    "tools: warning: one tool is missing",
    "tools: FAILED package demo: broken",
    "tools: office check",
    "tools: done: 3 tools",
    "office setup: between stages",
    "office setup: done (0s)",
    "next: Pair: office pair",
    "next: Add this line",
    "next: source ~/env.sh",
  ]);
  expect(err).toEqual([]);
  // No escape codes, ever.
  expect(out.join("\n")).not.toMatch(/\u001b/);
});

test("the plain renderer keeps subprocess output back unless the stage or part fails, then shows its last lines", () => {
  const { out, reporter } = plain();
  const stage = reporter.stage("Services", { key: "services" });

  for (let index = 1; index <= 15; index++) stage.output(`line ${index}`);

  expect(out).toEqual([]);
  stage.fail("docker compose failed");
  expect(out.slice(0, 2)).toEqual(["services: | line 4", "services: | line 5"]);
  expect(out).toHaveLength(13);
  expect(out.at(-1)).toBe("services: FAILED: docker compose failed");

  out.length = 0;

  const repos = reporter.stage("Repositories and packages", { key: "repos" });
  const good = repos.part("references/a", "cloning");
  const bad = repos.part("references/b", "updating");

  good.output("hidden");
  bad.output("fatal: couldn't find remote ref dev");
  good.done("cloned");
  bad.fail("Command failed: git fetch");

  expect(out).toEqual([
    "repos: cloning references/a",
    "repos: updating references/b",
    "repos: references/a: cloned",
    "repos: references/b: FAILED: Command failed: git fetch",
    "repos: | references/b: fatal: couldn't find remote ref dev",
  ]);
});

test("verbose plain output prints every subprocess line as it comes", () => {
  const { out, reporter } = plain(true);
  const stage = reporter.stage("Services", { key: "services" });

  stage.output("Container office-t-executor-1 Started");
  stage.part("references/a", "cloning").output("Receiving objects: 100%");

  expect(out).toEqual(["services: | Container office-t-executor-1 Started", "services: cloning references/a", "services: | references/a: Receiving objects: 100%"]);
});

test("the plain renderer never prompts, and a stop or an interruption goes to stderr", async () => {
  const { out, err, reporter } = plain();

  await expect(reporter.ask({ kind: "confirm", message: "Install?" })).rejects.toThrow("no prompt opens without a terminal");
  reporter.stopped("sync failed\n  - references/b");
  reporter.interrupted();

  expect(out).toEqual([]);
  expect(err).toEqual(["office setup: stopped: sync failed", "office setup:   - references/b", "office setup: interrupted; run office setup again to continue"]);
});

test("display lines split progress meters on carriage returns and drop escape codes and blank lines", () => {
  expect(displayLines("Receiving objects:  10%\rReceiving objects: 100%, done.\r\n\u001b[1;32mok\u001b[0m\n\n  \nlast")).toEqual(["Receiving objects:  10%", "Receiving objects: 100%, done.", "ok", "last"]);
});

test("stream gives each line to its callback as the command runs and returns the whole output", async () => {
  const lines: string[] = [];
  const result = await stream("sh", ["-c", "printf 'one\\rtwo\\rthree\\n'; printf 'err\\n' >&2; printf 'tail'"], { line: (text) => lines.push(text) });

  expect(result.status).toBe(0);
  // A meter's updates (carriage returns) at most once a second; whole lines always.
  expect(lines.sort()).toEqual(["err", "one", "tail", "three"]);
  expect(result.stderr).toBe("err\n");

  const failing = streamChecked("sh", ["-c", "echo fatal: no >&2; exit 3"]);

  await expect(failing).rejects.toBeInstanceOf(CommandFailed);
  await expect(failing).rejects.toThrow(/^Command failed: sh -c echo fatal: no >&2; exit 3\nfatal: no$/);
  expect((await stream("/nonexistent/command", [])).status).toBe(1);
});
