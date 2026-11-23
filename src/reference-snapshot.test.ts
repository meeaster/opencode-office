import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

test("a snapshot of another version is refused", () => {
  write(saved(dir), JSON.stringify({ version: 4, inputs: "", owner: [], contributors: [local] }));
  expect(readSnapshot(dir)).toEqual({ ok: true, value: { version: 4, inputs: "", owner: [], contributors: [local] } });

  write(saved(dir), JSON.stringify({ version: 3, inputs: "", owner: [], contributors: [{ name: "notes", source: "local", stale: false, references: [] }] }));
  const read = readSnapshot(dir);

  expect(read.ok ? "" : read.errors.join("\n")).toContain("unsupported references snapshot version");
});

