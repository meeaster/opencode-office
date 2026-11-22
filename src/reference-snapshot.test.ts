import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sync } from "./commands/sync.ts";
import { git } from "./git.ts";
import { loadOffice } from "./office.ts";
import { readSnapshot } from "./reference-snapshot.ts";

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "office-snapshot-")); });

afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const saved = (office: string) => join(office, ".office/resolved/references.json");
const local = { name: "notes", source: "local", stale: false, entries: [{ id: "references.repository", value: { name: "docs", url: "u" } }] };

test("an earlier release's command rows are read and dropped unread, whatever they hold; version 3 is refused", () => {
  const rows = [
    { routes: [{ name: "notes show", aliases: [], summary: "Show" }], settings: {}, files: "0".repeat(64) },
    { routes: "not a route table" },
    null,
  ];

  for (const commands of rows) {
    write(saved(dir), JSON.stringify({ version: 4, inputs: "", owner: [], contributors: [{ ...local, commands }] }));
    expect(readSnapshot(dir)).toEqual({ ok: true, value: { version: 4, inputs: "", owner: [], contributors: [local] } });
  }

  write(saved(dir), JSON.stringify({ version: 3, inputs: "", owner: [], contributors: [{ name: "notes", source: "local", stale: false, references: [] }] }));
  const read = readSnapshot(dir);

  expect(read.ok ? "" : read.errors.join("\n")).toContain("unsupported references snapshot version");
});

test("a sync rewrites a file holding command rows without them", async () => {
  const office = join(dir, "office");
  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: notes\n");
  write(join(office, "packages/notes/office.ts"), 'export default {name:"notes",description:"Notes",setup(ctx){ctx.command({name:"notes show",summary:"Show",run(){}})}}');
  git(["init", "--quiet", office]);
  await sync(loadOffice(office), { scope: "packages" });
  const published = JSON.parse(readFileSync(saved(office), "utf8"));

  expect(JSON.stringify(published)).not.toContain("commands");
  // As the previous release wrote it: the same file with the command index.
  const previous = { ...published, contributors: published.contributors.map((group: { name: string }) => group.name === "notes" ? { ...group, commands: { routes: [{ name: "notes show", aliases: [], summary: "Show" }], settings: {} } } : group) };
  writeFileSync(saved(office), JSON.stringify(previous));
  const changes = await sync(loadOffice(office), { scope: "packages" });

  expect(changes.filter(line => line.startsWith("FAILED"))).toEqual([]);
  expect(JSON.parse(readFileSync(saved(office), "utf8"))).toEqual(published);
});
