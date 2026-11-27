// A package command's scalar edit of its own settings (CommandInputs.replaceSetting): one scalar
// changes, and both office.yaml's schema and the package's settings schema must accept the result.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { settingsSchema } from "../../packages/skills/settings.ts";
import { loadOffice, type PackageEntry, replacePackageSetting } from "../../src/office.ts";
import { schemaSettings } from "../../src/loader/definitions/settings.ts";
import { parseManifest } from "../../src/schema.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-settings-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const old = "a".repeat(40);
const next = "b".repeat(40);

const text = `# The office.
name: demo
packages:
  - name: knowledge # first
  - name: skills
    settings:
      # Where skills come from.
      sources:
        - folder: skills
        - repo: https://example.com/handbook.git
          ref: ${old}  # pinned
          track: main
          skills: [{ name: review, path: engineering/review }]
      enabled: [review]
`;

const manifest = parseManifest("skills", { settings: settingsSchema });

function validate(entry: PackageEntry) {
  if (!manifest.ok) throw new Error(manifest.errors.join("; "));

  return schemaSettings({ entry }, manifest.value, "packages/skills/office.ts");
}

const file = () => readFileSync(join(dir, "office.yaml"), "utf8");

function replace(path: (string | number)[], value: string | number | boolean, name = "skills") {
  return replacePackageSetting(loadOffice(dir), name, path, value, validate);
}

test("only the targeted scalar changes, comments and every other setting kept, and the settings returned read the new value", () => {
  writeFileSync(join(dir, "office.yaml"), text);

  const settings = replace(["sources", 1, "ref"], next);

  expect(file()).toBe(text.replace(old, next));
  expect(settings).toEqual({ sources: [{ folder: "skills" }, { repo: "https://example.com/handbook.git", ref: next, track: "main", skills: [{ name: "review", path: "engineering/review" }] }], enabled: ["review"] });
  expect(loadOffice(dir).packages.find(entry => entry.name === "skills")?.settings).toEqual(settings);
});

test("a value the package's schema refuses, or a document office.yaml's schema refuses, is never written", () => {
  writeFileSync(join(dir, "office.yaml"), text);

  expect(() => replace(["sources", 1, "ref"], "main")).toThrow("packages.skills.settings.sources.1.ref: the package's settings would not be valid");
  expect(file()).toBe(text);

  // Loaded while valid, then the document breaks elsewhere: the edit checks the whole document.
  const office = loadOffice(dir);

  writeFileSync(join(dir, "office.yaml"), `${text}opencode: banana\n`);
  expect(() => replacePackageSetting(office, "skills", ["sources", 1, "ref"], next, validate)).toThrow("office.yaml would not be valid");
  expect(file()).toBe(`${text}opencode: banana\n`);
});

test("a path to no scalar, outside the settings or of a package without an entry changes nothing", () => {
  writeFileSync(join(dir, "office.yaml"), text);

  expect(() => replace(["sources", 1], next)).toThrow("packages.skills.settings.sources.1: office.yaml has no setting there to replace");
  expect(() => replace(["sources", 1, "branch"], next)).toThrow("office.yaml has no setting there to replace");
  expect(() => replace(["..", "name"], next)).toThrow("office.yaml has no setting there to replace");
  expect(() => replace([], next)).toThrow("a setting path is one or more keys and list positions");
  expect(() => replace(["enabled", 0], "review", "cron")).toThrow("packages.cron.settings.enabled.0: office.yaml has no entry for package cron");
  expect(file()).toBe(text);
});

const anything = (entry: PackageEntry) => ({ ok: true as const, value: entry.settings ?? {} });

test("a value with flow punctuation or several lines reads back as exactly that value, in flow and block collections alike", () => {
  const flow = `name: demo
packages:
  - name: notes
    settings: { title: plain, tags: [a, b] } # flow
  # between
  - name: knowledge
`;

  const blocks = `name: demo
packages:
  - name: notes
    settings:
      title: | # kept
        first
        second
      after: x # also kept
`;

  writeFileSync(join(dir, "office.yaml"), flow);
  replacePackageSetting(loadOffice(dir), "notes", ["title"], "x, y: {z} # not a comment", anything);
  replacePackageSetting(loadOffice(dir), "notes", ["tags", 1], "]&*", anything);
  expect(file()).toBe(flow.replace("plain", JSON.stringify("x, y: {z} # not a comment")).replace("b]", `${JSON.stringify("]&*")}]`));
  expect(loadOffice(dir).packages[0].settings).toEqual({ title: "x, y: {z} # not a comment", tags: ["a", "]&*"] });

  writeFileSync(join(dir, "office.yaml"), blocks);
  replacePackageSetting(loadOffice(dir), "notes", ["title"], "one\ntwo", anything);
  expect(file()).toBe(blocks.replace("| # kept\n        first\n        second\n", "\"one\\ntwo\" # kept\n"));
  expect(loadOffice(dir).packages[0].settings).toEqual({ title: "one\ntwo", after: "x" });
});

test("a block scalar's header keeps its exact spacing, comment and line ending, and the file its final bytes", () => {
  const entry = (title: string) => `name: demo\npackages:\n  - name: notes\n    settings:\n      title: ${title}`;

  const cases: [string, string][] = [
    [entry("|  # keep-final-byte"), entry(`"one\\ntwo"  # keep-final-byte`)],
    [entry("|-2   # spaced\n        first\n        second"), entry(`"one\\ntwo"   # spaced`)],
    [entry(">+\n        first\n\n      after: x\n"), entry(`"one\\ntwo"\n      after: x\n`)],
    [entry("|  # crlf\r\n        first\r\n      after: x\r\n").replaceAll(/(?<!\r)\n/g, "\r\n"), entry(`"one\\ntwo"  # crlf\r\n      after: x\r\n`).replaceAll(/(?<!\r)\n/g, "\r\n")],
    [entry("|\r\n        first\r\n      after: x\r\n").replaceAll(/(?<!\r)\n/g, "\r\n"), entry(`"one\\ntwo"\r\n      after: x\r\n`).replaceAll(/(?<!\r)\n/g, "\r\n")],
  ];

  for (const [before, after] of cases) {
    writeFileSync(join(dir, "office.yaml"), before);
    replacePackageSetting(loadOffice(dir), "notes", ["title"], "one\ntwo", anything);
    expect(file()).toBe(after);
    expect(loadOffice(dir).packages[0].settings?.title).toBe("one\ntwo");
  }
});

test("a block-scalar pin keeps its header's own line ending when its body's differs, and every byte after it", () => {
  const source = (ref: string, after: string) => `# The office.\r\nname: demo\npackages:\n  - name: skills\n    settings:\n      enabled: [review] # chosen\r\n      sources:\n        - repo: https://example.com/handbook.git\n          skills: [{ name: review, path: engineering/review }]\n          ref: ${ref}${after}`;
  const following = "          # after the pin\r\n          track: main\n      # trailing\r\n";

  const cases: [string, string][] = [
    [source(`|-  # pin\r\n            ${old}\n`, following), source(`${next}  # pin\r\n`, following)],
    [source(`|2-\n            ${old}\r\n`, following), source(`${next}\n`, following)],
    [source(`|-2 # pin\r\n            ${old}\n`, following.replaceAll("\r\n", "\n")), source(`${next} # pin\r\n`, following.replaceAll("\r\n", "\n"))],
    [source(`|-  # pin\r\n            ${old}`, ""), source(`${next}  # pin`, "")],
  ];

  for (const [before, after] of cases) {
    writeFileSync(join(dir, "office.yaml"), before);
    const settings = replace(["sources", 0, "ref"], next);

    expect(file()).toBe(after);
    expect(settings.sources).toMatchObject([{ ref: next }]);
    expect(loadOffice(dir).packages.find(entry => entry.name === "skills")?.settings).toEqual(settings);
  }
});

test("a value shared through an anchor, in the same entry or another package's, is never replaced", () => {
  const scalar = `name: demo
packages:
  - name: notes
    settings: { ref: &pin old, copy: *pin }
`;

  const across = `name: demo
packages:
  - name: notes
    settings: &shared
      ref: old
  - name: other
    settings: *shared
`;

  for (const shared of [scalar, across]) {
    writeFileSync(join(dir, "office.yaml"), shared);
    expect(() => replacePackageSetting(loadOffice(dir), "notes", ["ref"], "new", anything)).toThrow("packages.notes.settings.ref: office.yaml would change more than that setting");
    expect(file()).toBe(shared);
  }
});
