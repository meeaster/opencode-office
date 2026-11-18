import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { summarize, sync } from "./commands/sync.ts";
import { cloneShallow, git } from "./git.ts";
import { loadOffice } from "./office.ts";
import { PlainReporter } from "./report/plain.ts";
import { silentStage } from "./report/reporter.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-git-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("sync refreshes a reference that is its own clone, and refuses a plain folder at a clone path instead of running git in the office", async () => {
  const office = join(dir, "office");
  const upstream = join(dir, "upstream");

  const commit = (message: string) => {
    writeFileSync(join(upstream, "notes.md"), `${message}\n`);
    git(["add", "-A"], upstream);
    git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", message], upstream);
  };

  mkdirSync(upstream);
  git(["init", "--quiet", upstream]);
  commit("one");
  mkdirSync(office);
  writeFileSync(join(office, "office.yaml"), `name: t\nreferences:\n  - { name: up, url: ${upstream} }\n  - { name: plain, url: ${upstream} }\n`);
  git(["init", "--quiet", office]);
  mkdirSync(join(office, "references/plain"), { recursive: true });
  writeFileSync(join(office, "references/plain/keep.md"), "not a clone\n");

  const first = await sync(loadOffice(office), { referencesOnly: true });

  expect(first).toContain("cloned reference references/up");
  expect(first).toContain(`FAILED reference references/plain: ${join(office, "references/plain")} holds a folder that isn't a repository of its own (no .git), not a clone; move it away so office sync can clone there`);

  commit("two");

  expect(await sync(loadOffice(office), { referencesOnly: true })).toContain("updated reference references/up");
});

test("sync reports each clone as a part while it runs, keeps git's error for one that fails, and returns the same lines in office.yaml's order", async () => {
  const office = join(dir, "office");
  const upstream = join(dir, "upstream");

  mkdirSync(upstream);
  git(["init", "--quiet", upstream]);
  writeFileSync(join(upstream, "notes.md"), "one\n");
  git(["add", "-A"], upstream);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "one"], upstream);
  mkdirSync(office);
  writeFileSync(
    join(office, "office.yaml"),
    `name: t\nreferences:\n${["a", "b", "c", "d", "e"].map((name) => `  - { name: ${name}, url: ${upstream} }\n`).join("")}  - { name: missing, url: ${join(dir, "nowhere")} }\n`,
  );
  git(["init", "--quiet", office]);

  const lines: string[] = [];
  const reporter = new PlainReporter("office sync", false, (line) => lines.push(line), (line) => lines.push(line));
  const stage = reporter.stage("Repositories and packages", { key: "repos" });
  const changes = await sync(loadOffice(office), { referencesOnly: true, stage });

  expect(changes.slice(0, 5)).toEqual(["a", "b", "c", "d", "e"].map((name) => `cloned reference references/${name}`));
  expect(changes[5]).toStartWith("FAILED reference references/missing: Command failed: git fetch --quiet --depth 1 origin HEAD\n");
  expect(summarize(changes)).toBe("5 cloned, 1 failed");

  expect(lines[0]).toBe("repos: cloning and updating 6 sources, 4 at a time");

  for (const name of ["a", "b", "c", "d", "e"]) {
    expect(lines).toContain(`repos: cloning references/${name}`);
    expect(lines).toContain(`repos: references/${name}: cloned`);
  }

  // Four at once: the fifth starts only after one of the first four has finished.
  expect(lines.indexOf("repos: cloning references/e")).toBeGreaterThan(lines.findIndex((line) => / cloned$/.test(line)));
  expect(lines.find((line) => line.startsWith("repos: references/missing: FAILED: Command failed: git fetch"))).toBeDefined();
  // The failing clone's own last lines follow, git's error among them.
  expect(lines.some((line) => line.startsWith("repos: | references/missing: ") && line.includes("nowhere"))).toBe(true);
  // A rerun updates nothing: every part says current, and there is no change to return.
  lines.length = 0;
  writeFileSync(join(office, "office.yaml"), `name: t\nreferences:\n${["a", "b"].map((name) => `  - { name: ${name}, url: ${upstream} }\n`).join("")}`);

  expect(await sync(loadOffice(office), { referencesOnly: true, stage: reporter.stage("Repositories and packages", { key: "repos" }) })).toEqual([]);
  expect(lines[0]).toBe("repos: cloning and updating 2 sources, 4 at a time");
  expect(lines.slice(1).sort()).toEqual(["repos: references/a: current", "repos: references/b: current", "repos: updating references/a", "repos: updating references/b"]);
  expect(summarize([])).toBe("already in sync");
});

test("a full sync reports its change lines as notes and FAILED lines as errors while returning them", async () => {
  const office = join(dir, "office");

  mkdirSync(office);
  writeFileSync(join(office, "office.yaml"), "name: t\n");
  git(["init", "--quiet", office]);

  const seen: { kind: string; text: string }[] = [];
  const stage = { ...silentStage, note: (text: string) => seen.push({ kind: "note", text }), error: (text: string) => seen.push({ kind: "error", text }) };
  const changes = await sync(loadOffice(office), { stage });

  expect(changes.length).toBeGreaterThan(0);
  expect(seen.map((entry) => entry.text)).toEqual(changes);
  expect(seen.every((entry) => (entry.kind === "error") === entry.text.startsWith("FAILED"))).toBe(true);
});

test("a shallow clone that fails leaves nothing behind, and one an earlier release left half-initialised is cloned again with the real error", async () => {
  const office = join(dir, "office");
  const upstream = join(dir, "upstream");

  mkdirSync(upstream);
  git(["init", "--quiet", upstream]);
  writeFileSync(join(upstream, "notes.md"), "one\n");
  git(["add", "-A"], upstream);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "one"], upstream);
  mkdirSync(office);
  writeFileSync(join(office, "office.yaml"), `name: t\nreferences:\n  - { name: up, url: ${upstream}, ref: missing-branch }\n`);
  git(["init", "--quiet", office]);

  const realError = expect.stringMatching(/^FAILED reference references\/up: Command failed: git fetch --quiet --depth 1 origin missing-branch\n.*missing-branch/);

  expect(await sync(loadOffice(office), { referencesOnly: true })).toEqual([realError]);
  expect(existsSync(join(office, "references/up"))).toBe(false);
  // The same again: still the real error, not git rev-parse on an empty repository.
  expect(await sync(loadOffice(office), { referencesOnly: true })).toEqual([realError]);

  // What a failed clone left before: an empty folder holding only an initialised .git with the remote.
  mkdirSync(join(office, "references/up"), { recursive: true });
  git(["init", "--quiet", join(office, "references/up")]);
  git(["remote", "add", "origin", upstream], join(office, "references/up"));
  expect(await sync(loadOffice(office), { referencesOnly: true })).toEqual([realError]);
  // The folder was there before this clone, so only what the clone made goes.
  expect(existsSync(join(office, "references/up/.git"))).toBe(false);

  writeFileSync(join(office, "office.yaml"), `name: t\nreferences:\n  - { name: up, url: ${upstream} }\n`);
  expect(await sync(loadOffice(office), { referencesOnly: true })).toEqual(["cloned reference references/up"]);
  expect(() => cloneShallow(upstream, "missing-branch", join(dir, "blocking"))).toThrow("missing-branch");
  expect(existsSync(join(dir, "blocking"))).toBe(false);
});
