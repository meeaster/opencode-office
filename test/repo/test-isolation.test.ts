import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { miseShims } from "../../src/features/host/host-env.ts";
import { hostToolsRoot } from "../../src/features/host/host-tools.ts";
import { applyOfficeTools } from "../support/test-package.ts";
import { toolPath } from "../../src/tool.ts";

test("fixture tools refuse a redirected state directory or executable before changing its target", () => {
  const root = mkdtempSync(join(tmpdir(), "redirect-"));
  const state = join(root, "state");
  const sentinel = join(root, "owner");

  mkdirSync(sentinel);
  symlinkSync(sentinel, state);
  expect(() => applyOfficeTools(state)).toThrow("not a test directory");
  expect(readdirSync(sentinel)).toEqual([]);

  const other = join(root, "other");
  const target = join(sentinel, "mise");

  mkdirSync(join(other, "tools/fixture"), { recursive: true });
  writeFileSync(target, "owner bytes");
  symlinkSync(target, join(other, "tools/fixture/sops"));
  expect(() => applyOfficeTools(other)).toThrow("EEXIST");
  expect(readFileSync(target, "utf8")).toBe("owner bytes");
});

test("isolated paths", () => {
  const owned = process.env.OFFICE_TEST_ROOT + "/";

  for (const path of [homedir(), miseShims(), hostToolsRoot(), Bun.which("mise")]) expect(path?.startsWith(owned)).toBe(true);
  expect(process.env.SOPS_AGE_KEY_FILE).toBeUndefined();
  mkdirSync(miseShims(), { recursive: true });
  writeFileSync(join(miseShims(), "node"), "fixture shim", { flag: "wx" });
  expect(Bun.spawnSync(["mise", "install"]).exitCode).toBe(1);
});

test("a launcher started from a populated host uses a fresh HOME, shim tree and private mise", () => {
  const parent = mkdtempSync(join(tmpdir(), "parent-"));
  const sentinel = join(parent, "mise");
  const shims = join(parent, "shims");

  mkdirSync(shims);
  writeFileSync(sentinel, "#!/bin/sh\nexit 42\n", { mode: 0o755 });
  symlinkSync(sentinel, join(shims, "node"));
  symlinkSync(process.execPath, join(parent, "bun"));

  const result = Bun.spawnSync([toolPath("bin/test"), import.meta.path, "-t", "^isolated paths$"], {
    env: { HOME: parent, TMPDIR: parent, PATH: `${parent}:/usr/bin:/bin`, MISE_DATA_DIR: parent, XDG_DATA_HOME: parent, SOPS_AGE_KEY_FILE: sentinel },
  });

  expect(result.exitCode, result.stderr.toString()).toBe(0);
  expect(result.stderr.toString()).toContain("1 pass");
  expect(readFileSync(sentinel, "utf8")).toBe("#!/bin/sh\nexit 42\n");
  expect(readdirSync(parent).sort()).toEqual(["bun", "mise", "shims"]);
});
