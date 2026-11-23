import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sync } from "./commands/sync.ts";
import { declaredCommands, nameProblems } from "./command-table.ts";
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
  for (const name of ["sync", "sync extra", "apps extra", "seeds list", "packages show"]) {
    expect(nameProblems([owned("ink", "draft show", [name])])).toEqual([{ name, owners: ["ink"], message: `package ink: command ${name} is reserved` }]);
  }

  expect(messages(owned("ink", "opencode inspect"), owned("press", "opencode inspect deep"))).toEqual([
    "package ink: command opencode inspect is reserved", "package press: command opencode inspect deep is reserved",
  ]);
  // Only the CLI's own first words: other packages may name references list or opencode commands.
  expect(messages(owned("ink", "references list"), owned("press", "opencode tidy"))).toEqual([]);
});

test("sync reports a reserved name, or one claimed twice, by command-only packages and by ones that failed, and publishes nothing", async () => {
  const office = mkdtempSync(join(tmpdir(), "office-names-"));

  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(office, path)), { recursive: true });
    writeFileSync(join(office, path), text);
  };

  try {
    write("office.yaml", "name: t\npackages:\n  - name: notes\n  - name: pages\n  - name: quill\n  - name: service\n");
    // Neither has a setup: their commands are still checked.
    writePackage(join(office, "packages/notes/office.ts"), definitionText('{commands:{"sync extra":{summary:"Extra",run(){}},"shared show":{summary:"Show",run(){}}}}'));
    writePackage(join(office, "packages/pages/office.ts"), definitionText('{commands:{"shared show":{summary:"Show",run(){}}}}'));
    // A failed setup, or a check failed after the definition loaded, doesn't withdraw a claim.
    writePackage(join(office, "packages/quill/office.ts"), definitionText('{setup(){throw Error("setup failed")},commands:{"apps extra":{summary:"Extra",run(){}}}}'));
    writePackage(join(office, "packages/service/office.ts"), definitionText('{host:{services:{svc:{description:"Service",script:"missing.sh"}}},commands:{"seeds extra":{summary:"Extra",run(){}}}}'));
    git(["init", "--quiet", office]);
    const changes = await sync(loadOffice(office), { scope: "packages" });

    expect(changes).toContain("FAILED package notes: command sync extra is reserved; no reference generation published");
    expect(changes).toContain("FAILED command shared show claimed by both package notes and package pages; no reference generation published");
    expect(changes).toContain("FAILED package quill: command apps extra is reserved; no reference generation published");
    expect(changes).toContain("FAILED package service: command seeds extra is reserved; no reference generation published");
  } finally {
    rmSync(office, { recursive: true, force: true });
  }
});
