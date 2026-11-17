import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { sync } from "./commands/sync.ts";
import { installedPackages } from "./layout.ts";
import { loadOffice } from "./office.ts";
import { fragmentFiles, orphanFragments, toolNotes, updateFragment } from "./package-tools.ts";

let dir: string;

let office: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-package-tools-"));
  office = join(dir, "office");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A local package `demo` declaring `tools`, listed in office.yaml. */
function demo(tools: string): void {
  write(join(office, "packages/demo/package.yaml"), `name: demo\ndescription: A demo package.\n${tools}`);
  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: demo\n");
}

const fragment = () => join(office, ".mise/conf.d/demo.toml");

/** What `office check` says of demo's tools. */
function notes() {
  const loaded = loadOffice(office);
  const item = installedPackages(loaded).installed.find((candidate) => candidate.entry.name === "demo");

  if (item === undefined) throw new Error("demo isn't installed");

  return toolNotes(loaded, item);
}

test("sync writes a package's tools to its fragment at the package's versions, naming the package", async () => {
  demo('tools:\n  "npm:agent-browser": "0.43.0"\n  jq: "1.7.1"\n');

  const changes = await sync(loadOffice(office));

  expect(changes).toContain("created .mise/conf.d/demo.toml with package demo's tools: npm:agent-browser 0.43.0, jq 1.7.1");

  const text = readFileSync(fragment(), "utf8");

  expect(text.split("\n")[0]).toStartWith("# The mise tools of package demo.");
  expect(text).toEndWith('[tools]\n"npm:agent-browser" = "0.43.0"\n"jq" = "1.7.1"\n');
  expect(notes()).toEqual({ ok: true, notes: ["tools npm:agent-browser, jq in .mise/conf.d/demo.toml"] });
  expect(await sync(loadOffice(office))).not.toContain(expect.stringContaining(".mise"));
});

test("sync keeps a version the office changed, and check doesn't count it as drift", async () => {
  demo('tools:\n  "npm:agent-browser": "0.43.0"\n');
  await sync(loadOffice(office));

  const bumped = readFileSync(fragment(), "utf8").replace('"0.43.0"', '"0.44.1" # bumped by upgrade-tools');

  writeFileSync(fragment(), bumped);

  const changes = await sync(loadOffice(office));

  expect(changes.filter((change) => change.includes(".mise"))).toEqual([]);
  expect(readFileSync(fragment(), "utf8")).toBe(bumped);
  expect(notes().ok).toBe(true);
});

test("sync removes a tool the package no longer declares and adds a new one, keeping the rest", async () => {
  demo('tools:\n  "npm:agent-browser": "0.43.0"\n  jq: "1.7.1"\n');
  await sync(loadOffice(office));
  writeFileSync(fragment(), readFileSync(fragment(), "utf8").replace('"1.7.1"', '"1.8.0"'));
  demo('tools:\n  jq: "1.7.1"\n  "npm:oxlint": "1.93.0"\n');

  expect(notes()).toEqual({
    ok: false,
    notes: ["tools jq in .mise/conf.d/demo.toml", ".mise/conf.d/demo.toml lacks npm:oxlint; office sync adds it", ".mise/conf.d/demo.toml holds npm:agent-browser, which the package no longer declares; office sync removes it"],
  });

  const changes = await sync(loadOffice(office));

  expect(changes).toContain("added npm:oxlint 1.93.0 to .mise/conf.d/demo.toml, which package demo declares");
  expect(changes).toContain("removed npm:agent-browser from .mise/conf.d/demo.toml, as package demo no longer declares it");
  expect(readFileSync(fragment(), "utf8")).toEndWith('[tools]\n"jq" = "1.8.0"\n"npm:oxlint" = "1.93.0"\n');
  expect(notes().ok).toBe(true);
});

test("check reports a declared tool missing from the fragment", async () => {
  demo('tools:\n  "npm:agent-browser": "0.43.0"\n');

  expect(notes()).toEqual({ ok: false, notes: ["tools npm:agent-browser are missing: .mise/conf.d/demo.toml doesn't exist; office sync writes it"] });

  await sync(loadOffice(office));
  writeFileSync(fragment(), readFileSync(fragment(), "utf8").replace(/^"npm:agent-browser".*\n/m, ""));

  expect(notes()).toEqual({ ok: false, notes: ["tools none in .mise/conf.d/demo.toml", ".mise/conf.d/demo.toml lacks npm:agent-browser; office sync adds it"] });
});

test("sync deletes the fragment when the package leaves office.yaml or declares no tools, and leaves the office's own fragments alone", async () => {
  demo('tools:\n  "npm:agent-browser": "0.43.0"\n');
  write(join(office, ".mise/conf.d/own.toml"), '[tools]\njq = "1.7.1"\n');
  await sync(loadOffice(office));

  expect(fragmentFiles(loadOffice(office)).map((path) => path.slice(office.length + 1))).toEqual([".mise/conf.d/demo.toml", ".mise/conf.d/own.toml"]);

  write(join(office, "office.yaml"), "name: t\n");

  expect(orphanFragments(loadOffice(office), [])).toEqual([".mise/conf.d/demo.toml holds the tools of package demo, which office.yaml no longer lists (office sync deletes it)"]);
  expect(await sync(loadOffice(office))).toContain("deleted .mise/conf.d/demo.toml, the tools of package demo, which office.yaml no longer lists");
  expect(existsSync(fragment())).toBe(false);
  expect(existsSync(join(office, ".mise/conf.d/own.toml"))).toBe(true);

  rmSync(join(office, ".mise"), { recursive: true });
  demo('tools:\n  "npm:agent-browser": "0.43.0"\n');
  await sync(loadOffice(office));
  demo("");

  expect(await sync(loadOffice(office))).toContain("deleted .mise/conf.d/demo.toml, as package demo declares no tools");
  expect(existsSync(join(office, ".mise"))).toBe(false);
});

test("sync refuses to write a package's tools over a fragment it didn't write", async () => {
  demo('tools:\n  "npm:agent-browser": "0.43.0"\n');
  write(fragment(), '[tools]\njq = "1.7.1"\n');

  expect(await sync(loadOffice(office))).toContain("FAILED package demo: .mise/conf.d/demo.toml is not the fragment office sync writes for it, so its tools aren't written; rename that file");
  expect(readFileSync(fragment(), "utf8")).toBe('[tools]\njq = "1.7.1"\n');
});

test("a fragment whose [tools] table was removed gets one back", () => {
  expect(updateFragment("# The mise tools of package demo. x\n", "demo", { jq: "1.7.1" }).text).toBe('# The mise tools of package demo. x\n[tools]\n"jq" = "1.7.1"\n');
});

test("package.yaml's tools take exact versions only", async () => {
  demo('tools:\n  jq: latest\n  node: "26"\n');

  expect(await sync(loadOffice(office))).toEqual(
    expect.arrayContaining(["FAILED package demo: packages/demo/package.yaml: tools.jq: must be an exact version such as 0.43.0", "FAILED package demo: packages/demo/package.yaml: tools.node: must be an exact version such as 0.43.0"]),
  );
  expect(existsSync(fragment())).toBe(false);
});
