import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { renameNoReplace } from "./no-replace.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-no-replace-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("a no-replace rename keeps an empty folder or a file already at the target, and moves into a free path", () => {
  const from = join(dir, "from");
  mkdirSync(from);
  writeFileSync(join(from, "index.js"), "");
  const folder = join(dir, "folder");
  mkdirSync(folder);
  chmodSync(folder, 0o750);
  const { ino, mode } = statSync(folder);
  const file = join(dir, "file");
  writeFileSync(file, "owner");

  for (const target of [folder, file]) expect(() => renameNoReplace(from, target)).toThrow(expect.objectContaining({ code: "EEXIST" }));
  expect(statSync(folder)).toMatchObject({ ino, mode });
  expect(readdirSync(folder)).toEqual([]);
  expect(() => renameNoReplace(join(dir, "missing"), join(dir, "free"))).toThrow(expect.objectContaining({ code: "ENOENT" }));
  renameNoReplace(from, join(dir, "free"));
  expect(existsSync(from)).toBe(false);
  expect(readdirSync(join(dir, "free"))).toEqual(["index.js"]);
});
