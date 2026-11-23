import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { syncLines as sync } from "./sync.fixture.ts";
import { declaredCommands, nameProblems, packageRoute } from "./command-table.ts";
import { OfficeError } from "./office.ts";
import { git } from "./git.ts";
import { loadOffice } from "./office.ts";
import { parseManifest } from "./schema.ts";
import { definitionText, writePackage } from "./test-package.ts";

const run = () => {};
const owned = (owner: string, name: string, aliases: string[] = []) => ({ owner, command: { name, aliases } });
const messages = (...commands: ReturnType<typeof owned>[]) => nameProblems(commands).map(problem => problem.message);

test("a definition declares commands by name: a name or alias is lowercase words, not a flag or options", () => {
  const commands = (name: string, aliases: string[]) => parseManifest("draft", { commands: { [name]: { summary: "Draft", aliases, run } } });

  for (const [name, alias] of [["draft show", "sync --packages"], ["draft show", "--help"], ["Draft Show", "draft read"]]) {
    const read = commands(name, [alias]);
    const wrong = name === "Draft Show" ? name : alias;

    expect(read.ok).toBe(false);
    expect(read.ok ? "" : read.errors.join("\n")).toContain(`invalid route ${JSON.stringify(wrong)}`);
  }

  const read = commands("draft show", ["draft read"]);

  expect(read.ok && declaredCommands(read.value)).toEqual([{ name: "draft show", aliases: ["draft read"], summary: "Draft", run }]);
  expect(parseManifest("draft", { commands: { "draft show": { summary: "two\nlines", run } } })).toMatchObject({ ok: false, errors: [expect.stringContaining("single-line")] });
  // A bad name and a bad body are both reported.
  expect(parseManifest("draft", { commands: { "Draft Show": { summary: "two\nlines", run } } })).toMatchObject({ ok: false, errors: [expect.stringContaining("invalid route"), expect.stringContaining("single-line")] });
});

test("a command declares exactly one handler, result or run; sync names the package and the command", async () => {
  const result = () => "";

  expect(parseManifest("draft", { commands: { "draft text": { summary: "Text", result } } })).toMatchObject({ ok: true, value: { commands: { "draft text": { result } } } });
  expect(parseManifest("draft", { commands: { "draft both": { summary: "Both", result, run }, "draft none": { summary: "None" }, "draft word": { summary: "Word", result: "text" } } })).toEqual({
    ok: false,
    errors: ["commands.draft both: must declare exactly one of result or run", "commands.draft none: must declare exactly one of result or run", "commands.draft word.result: expected a command handler"],
  });

  const office = mkdtempSync(join(tmpdir(), "office-handlers-"));

  try {
    writeFileSync(join(office, "office.yaml"), "name: t\npackages:\n  - name: untyped\n");
    writePackage(join(office, "packages/untyped/office.ts"), definitionText('{commands:{"untyped both":{summary:"Both",result(){return ""},run(){}}}}'));
    git(["init", "--quiet", office]);
    const changes = await sync(loadOffice(office), { scope: "packages" });

    expect(changes.filter(line => line.includes("exactly one"))).toEqual(["FAILED package untyped: packages/untyped/office.ts: commands.untyped both: must declare exactly one of result or run"]);
  } finally {
    rmSync(office, { recursive: true, force: true });
  }
});

test("constructor and prototype are routes like any other, as a name and as an alias", () => {
  const read = parseManifest("draft", { commands: { constructor: { summary: "Build", aliases: ["prototype"], run }, prototype: { summary: "Sketch", run } } });

  expect(read.ok && declaredCommands(read.value)).toEqual([
    { name: "constructor", aliases: ["prototype"], summary: "Build", run },
    { name: "prototype", aliases: [], summary: "Sketch", run },
  ]);
  expect(read.ok && messages(...declaredCommands(read.value).map(command => owned("draft", command.name, command.aliases)))).toEqual(["command prototype claimed twice by package draft"]);
});

test("each name or alias has one owner, across packages and within one", () => {
  expect(messages(owned("press", "issue read"), owned("ink", "draft show", ["issue read"]))).toEqual(["command issue read claimed by both package press and package ink"]);
  expect(messages(owned("press", "demo run"), owned("ink", "demo run"))).toEqual(["command demo run claimed by both package press and package ink"]);
  expect(messages(owned("ink", "draft show", ["draft show"]))).toEqual(["command draft show claimed twice by package ink"]);
  expect(messages(owned("ink", "draft show"), owned("ink", "draft read", ["draft show"]))).toEqual(["command draft show claimed twice by package ink"]);
  expect(messages(owned("press", "issue read"), owned("ink", "draft show", ["draft read"]))).toEqual([]);
});

test("a package can't take a first word of the CLI's own commands, nor opencode inspect", () => {
  for (const name of ["sync", "sync extra", "apps extra", "check list", "packages show"]) {
    expect(nameProblems([owned("ink", "draft show", [name])])).toEqual([{ name, owners: ["ink"], message: `package ink: command ${name} is reserved` }]);
  }

  expect(messages(owned("ink", "opencode inspect"), owned("press", "opencode inspect deep"))).toEqual([
    "package ink: command opencode inspect is reserved", "package press: command opencode inspect deep is reserved",
  ]);
  // Only the CLI's own first words: other packages may name references list, seeds commands or opencode commands.
  expect(messages(owned("ink", "references list"), owned("press", "opencode tidy"), owned("quill", "seeds list"))).toEqual([]);
});

test("a package command's words are the tokens as given, without --office; the CLI's own commands, opencode inspect, --help and --version stay the CLI's", () => {
  expect(packageRoute(["notes", "show", "my notes/a b.md", "--force", "-x"])).toEqual({ office: undefined, words: ["notes", "show", "my notes/a b.md", "--force", "-x"] });
  expect(packageRoute(["--office", "/o", "notes", "show", "x"])).toEqual({ office: "/o", words: ["notes", "show", "x"] });
  expect(packageRoute(["notes", "show", "x", "--office=/o"])).toEqual({ office: "/o", words: ["notes", "show", "x"] });

  for (const args of [[], ["sync", "--force"], ["apps", "extra"], ["opencode", "inspect"], ["--verbose", "notes"], ["notes", "--help"], ["notes", "-h"], ["notes", "--version"]]) expect(packageRoute(args)).toBeUndefined();

  expect(packageRoute(["opencode", "tidy"])).toEqual({ office: undefined, words: ["opencode", "tidy"] });
});

test("only tokens before -- are the CLI's: the package gets -- and what follows as typed, --office there is its own, and --office needs a value that isn't an option", () => {
  expect(packageRoute(["notes", "show", "--", "--office", "/x", "--help", "-h", "--version"])).toEqual({ office: undefined, words: ["notes", "show", "--", "--office", "/x", "--help", "-h", "--version"] });
  expect(packageRoute(["--office", "/o", "notes", "--", "--office=/x"])).toEqual({ office: "/o", words: ["notes", "--", "--office=/x"] });
  expect(packageRoute(["notes", "--"])).toEqual({ office: undefined, words: ["notes", "--"] });
  expect(packageRoute(["notes", "--office=--help"])).toEqual({ office: "--help", words: ["notes"] });

  expect(() => packageRoute(["notes", "show", "--office"])).toThrow(new OfficeError("option --office needs a folder: --office <dir>"));
  expect(() => packageRoute(["notes", "--office", "--", "x"])).toThrow("option --office is ambiguous: -- starts with a dash; to name such a folder, use --office=--");
  expect(() => packageRoute(["--office", "--help", "notes"])).toThrow("option --office is ambiguous: --help starts with a dash; to name such a folder, use --office=--help");
  expect(() => packageRoute(["notes", "--office", "-h"])).toThrow("option --office is ambiguous");

  expect(() => packageRoute(["sync", "--office"])).toThrow("option --office needs a folder");
  expect(packageRoute(["exec", "--", "ls", "--office"])).toBeUndefined();
});

test("sync reports a reserved name, or one claimed twice, by command-only packages and by ones that failed, and a registry key two packages add, and publishes nothing", async () => {
  const office = mkdtempSync(join(tmpdir(), "office-names-"));

  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(office, path)), { recursive: true });
    writeFileSync(join(office, path), text);
  };

  try {
    write("office.yaml", "name: t\npackages:\n  - name: notes\n  - name: pages\n  - name: quill\n  - name: service\n  - name: alpha\n  - name: beta\n");
    // Any registry with a key, not only the built-ins': both packages add docs.
    writePackage(join(office, "packages/alpha/office.ts"), definitionText('{setup(c){c.registry(shared); c.add(shared, {name: "docs"})}}', 'const shared = {id: "alpha.shared", key: e => e.name, parse: i => i};'));
    writePackage(join(office, "packages/beta/office.ts"), definitionText('{setup(c){c.add({id: "alpha.shared"}, {name: "docs"})}}'));
    // Neither has a setup: their commands are still checked.
    writePackage(join(office, "packages/notes/office.ts"), definitionText('{commands:{"sync extra":{summary:"Extra",run(){}},"shared show":{summary:"Show",run(){}}}}'));
    writePackage(join(office, "packages/pages/office.ts"), definitionText('{commands:{"shared show":{summary:"Show",run(){}}}}'));
    // A failed setup, or a check failed after the definition loaded, doesn't withdraw a claim.
    writePackage(join(office, "packages/quill/office.ts"), definitionText('{setup(){throw Error("setup failed")},commands:{"apps extra":{summary:"Extra",run(){}}}}'));
    writePackage(join(office, "packages/service/office.ts"), definitionText('{host:{services:{svc:{description:"Service",script:"missing.sh"}}},commands:{"check extra":{summary:"Extra",run(){}}}}'));
    git(["init", "--quiet", office]);
    const changes = await sync(loadOffice(office), { scope: "packages" });

    expect(changes).toContain("FAILED package notes: command sync extra is reserved");
    expect(changes).toContain("FAILED command shared show claimed by both package notes and package pages");
    expect(changes).toContain("FAILED package quill: command apps extra is reserved");
    expect(changes).toContain("FAILED package service: command check extra is reserved");
    expect(changes).toContain("FAILED alpha.shared docs claimed by both package alpha and package beta");
  } finally {
    rmSync(office, { recursive: true, force: true });
  }
});
