import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDefinition } from "./package-definition.ts";

let root: string;

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "office-definition-unit-")); });

afterEach(() => { rmSync(root, { recursive: true, force: true }); });

// Each case gets its own folder: Bun caches a required office.ts by path.
function definition(name: string, files: Record<string, string>) {
  const dir = join(root, name);
  mkdirSync(dir);

  for (const [file, text] of Object.entries(files)) writeFileSync(join(dir, file), text);

  return readDefinition(dir, `packages/${name}`);
}

test("a definition that cannot be read names its file and reason, whatever went wrong", () => {
  const valid = 'export default { name: "notes", description: "Notes" }';

  expect(definition("ok", { "office.ts": valid })).toMatchObject({ ok: true, value: { file: "packages/ok/office.ts" } });

  for (const [name, files, reason] of [
    ["thrown", { "office.ts": 'throw new Error("bad notes import")' }, "packages/thrown/office.ts: bad notes import"],
    ["both", { "office.ts": valid, "package.yaml": "name: notes\ndescription: otherwise valid\n" }, "packages/both has both office.ts and package.yaml"],
    ["shape", { "office.ts": 'export default { name: "notes", description: "Notes", setup: "handler.ts" }' }, "packages/shape/office.ts: setup:"],
    ["none", {}, "packages/none has no office.ts or package.yaml"],
  ] as const) {
    const read = definition(name, files);

    expect(read.ok).toBe(false);
    expect(read.ok ? "" : read.errors.join("\n")).toContain(reason);
  }
});
