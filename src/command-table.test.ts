import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sync } from "./commands/sync.ts";
import { commandRegistration, nameProblems } from "./command-table.ts";
import { git } from "./git.ts";
import { loadOffice } from "./office.ts";
import { writePackage } from "./test-package.ts";

const run = () => {};
const owned = (owner: string, name: string, aliases: string[] = []) => ({ owner, command: { name, aliases } });
const messages = (...commands: ReturnType<typeof owned>[]) => nameProblems(commands).map(problem => problem.message);

test("a route is lowercase words: an alias can't be a flag or carry options", () => {
  for (const alias of ["sync --packages", "--help"]) {
    const read = commandRegistration({ name: "draft show", aliases: [alias], summary: "Draft", run });

    expect(read.ok).toBe(false);
    expect(read.ok ? "" : read.errors.join("\n")).toContain(`invalid route ${JSON.stringify(alias)}`);
  }

  expect(commandRegistration({ name: "draft show", aliases: ["draft read"], summary: "Draft", run }).ok).toBe(true);
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
    expect(nameProblems([owned("ink", "draft show", [name])])).toEqual([{ name, message: `package ink: command ${name} is reserved` }]);
  }

  expect(messages(owned("ink", "opencode inspect"), owned("press", "opencode inspect deep"))).toEqual([
    "package ink: command opencode inspect is reserved", "package press: command opencode inspect deep is reserved",
  ]);
  // Only the CLI's own first words: other packages may name references list or opencode commands.
  expect(messages(owned("ink", "references list"), owned("press", "opencode tidy"))).toEqual([]);
});

test("sync reports a reserved name with its package and publishes nothing", async () => {
  const office = mkdtempSync(join(tmpdir(), "office-names-"));
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(office, path)), { recursive: true });
    writeFileSync(join(office, path), text);
  };

  try {
    write("office.yaml", "name: t\npackages:\n  - name: notes\n");
    writePackage(join(office, "packages/notes/office.ts"), 'export default {name:"notes",description:"Notes",setup(ctx){ctx.command({name:"sync extra",summary:"Extra",run(){}})}}');
    git(["init", "--quiet", office]);
    const changes = await sync(loadOffice(office), { scope: "packages" });

    expect(changes).toContain("FAILED package notes: command sync extra is reserved; no reference generation published");
  } finally {
    rmSync(office, { recursive: true, force: true });
  }
});
