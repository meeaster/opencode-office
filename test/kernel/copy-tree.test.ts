import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { excludeCopy, planCopy } from "../../sdk/copy-tree.ts";

let office: string;

beforeEach(() => {
  office = mkdtempSync(join(tmpdir(), "copy-tree-"));
});

afterEach(() => rmSync(office, { recursive: true, force: true }));

function write(path: string, bytes: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

test("a copy refuses source symlinks, preserves file modes and skips unchanged files", () => {
  const source = join(office, "source");
  const destination = join(office, ".opencode/plugins/demo");
  const original = join(source, "index.js");
  const copied = join(destination, "index.js");

  write(original, "export default {};\n");
  chmodSync(original, 0o700);
  symlinkSync("index.js", join(source, "alias"));
  expect(() => planCopy(source, destination)).toThrow("alias: symbolic link");
  rmSync(join(source, "alias"));
  planCopy(source, destination).write(office);
  const before = statSync(copied);
  const same = planCopy(source, destination);

  expect(before.mode & 0o777).toBe(0o700);
  expect(same.differences).toEqual([]);
  same.write(office);
  expect(statSync(copied).ino).toBe(before.ino);
  expect(statSync(copied).mtimeMs).toBe(before.mtimeMs);

  chmodSync(original, 0o600);
  planCopy(source, destination).write(office);
  expect(statSync(copied).mode & 0o777).toBe(0o600);
});

test("applying a plan refuses redirected parents, including for stale file removal", () => {
  const source = join(office, "source");
  const destination = join(office, ".agents/skills/demo");
  const assets = join(destination, "assets");
  const outside = join(office, "outside");

  write(join(source, "assets/changed"), "new");
  write(join(assets, "changed"), "old");
  write(join(assets, "stale"), "old");
  const plan = planCopy(source, destination);

  renameSync(assets, outside);
  symlinkSync(outside, assets);
  expect(() => plan.write(office)).toThrow("expected a real folder");
  expect(readFileSync(join(outside, "changed"), "utf8")).toBe("old");
  expect(readFileSync(join(outside, "stale"), "utf8")).toBe("old");

  rmSync(assets);
  renameSync(outside, assets);
  write(join(assets, "changed"), "new");
  const remove = planCopy(source, destination);

  renameSync(assets, outside);
  symlinkSync(outside, assets);
  expect(() => remove.write(office)).toThrow("expected a real folder");
  expect(readFileSync(join(outside, "stale"), "utf8")).toBe("old");
});

test("a refused directory exclusion keeps the previous link", () => {
  const path = ".agents/skills/demo";
  const target = join(office, path);

  write(join(office, "skills/demo/SKILL.md"), "original");
  mkdirSync(dirname(target), { recursive: true });
  symlinkSync("../../skills/demo", target);

  expect(() => excludeCopy(office, path, at => {
    if (at.endsWith("/")) throw new Error("Git refused the directory");

    return [];
  })).toThrow("Git refused the directory");
  expect(readFileSync(join(target, "SKILL.md"), "utf8")).toBe("original");
});
