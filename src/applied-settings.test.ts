import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AppliedSettings, AppliedSettingsError, appliedSettingsFile, canonicalJson, officeRootOf, readAppliedSettings, watchAppliedSettings } from "../sdk/applied-settings.ts";
import { publishAppliedSettings, writeAppliedSnapshot } from "./applied-settings.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-applied-settings-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const entry = (name: string, settings: AppliedSettings) => ({ entry: { name }, settings });

function problem(read: () => void) {
  try {
    read();
  } catch (error) {
    if (error instanceof AppliedSettingsError) return error.problem;
    throw error;
  }
}

test("publishing writes sorted entries by rename, and only when the bytes change", () => {
  const file = appliedSettingsFile(dir);

  expect(publishAppliedSettings({ dir }, [entry("zed", { a: 1 }), entry("alpha", {})])).toEqual([`wrote .office/runtime/settings.json`]);
  expect(Object.keys(JSON.parse(readFileSync(file, "utf8")).packages)).toEqual(["alpha", "zed"]);
  const inode = statSync(file).ino;

  expect(publishAppliedSettings({ dir }, [entry("alpha", {}), entry("zed", { a: 1 })])).toEqual([]);
  expect(statSync(file).ino).toBe(inode);
  expect(readAppliedSettings(dir, "zed")).toEqual({ a: 1 });
  publishAppliedSettings({ dir }, [entry("zed", { a: 2 })]);
  expect(statSync(file).ino).not.toBe(inode);
});

test("a read names a missing snapshot, a malformed one and a missing package apart, and takes no inherited key", () => {
  expect(problem(() => readAppliedSettings(dir, "demo"))).toBe("missing-snapshot");
  mkdirSync(join(dir, ".office/runtime"), { recursive: true });

  for (const text of ["{", "[]", '{"packages": []}', '{"packages": {"demo": 3}}', '{"packages": {"demo": {"port": 1e999}}}', '{"packages": {"other": {"n": [-1e400]}}, "demo": {}}']) {
    writeFileSync(appliedSettingsFile(dir), text);
    expect(problem(() => readAppliedSettings(dir, "demo"))).toBe("malformed-snapshot");
  }

  writeFileSync(appliedSettingsFile(dir), '{"packages": {"demo": {}}}');

  for (const name of ["other", "__proto__", "constructor", "toString"]) expect(problem(() => readAppliedSettings(dir, name))).toBe("missing-package");
});

test("a malformed snapshot's message doesn't quote it", () => {
  const sentinel = "sentinel-of-another-package";

  mkdirSync(join(dir, ".office/runtime"), { recursive: true });
  writeFileSync(appliedSettingsFile(dir), `{"packages": {"other": {"token": "${sentinel}"}, "demo": {,}}}`);

  try {
    readAppliedSettings(dir, "demo");
    throw new Error("read");
  } catch (error) {
    expect(error).toBeInstanceOf(AppliedSettingsError);
    expect(String(error)).toContain("isn't JSON");
    expect(String(error)).not.toContain(sentinel);
  }
});

test("settings compare by value, and the same values always give the same bytes", () => {
  const file = appliedSettingsFile(dir);

  expect(canonicalJson({ b: { y: [2, 1], x: -0 }, a: 1.0 })).toBe(canonicalJson({ a: 1, b: { x: 0, y: [2, 1] } }));
  expect(canonicalJson({ y: [1, 2] })).not.toBe(canonicalJson({ y: [2, 1] }));
  expect(() => canonicalJson({ n: Number.POSITIVE_INFINITY })).toThrow();

  const input = { demo: { nested: { z: 1, a: [{ d: 1, c: 2 }] } } };

  writeAppliedSnapshot(dir, input);
  const bytes = readFileSync(file, "utf8");

  // The input isn't reordered, and the reordered input writes nothing.
  expect(Object.keys(input.demo.nested)).toEqual(["z", "a"]);
  expect(writeAppliedSnapshot(dir, { demo: { nested: { a: [{ c: 2, d: 1 }], z: 1 } } })).toBe(false);
  expect(readFileSync(file, "utf8")).toBe(bytes);
  expect(bytes.indexOf('"a"')).toBeLessThan(bytes.indexOf('"z"'));
});

test("a snapshot reached through a link is neither read nor written, whichever office it leads to", () => {
  const [a, b] = [join(dir, "a"), join(dir, "b")];

  for (const office of [a, b]) mkdirSync(office);
  writeAppliedSnapshot(b, { demo: { from: "b" } });
  const before = readFileSync(appliedSettingsFile(b), "utf8");

  // A's runtime folder, then A's .office, then A's file, each leading into B.
  mkdirSync(join(a, ".office"));
  symlinkSync(join(b, ".office/runtime"), join(a, ".office/runtime"), "dir");

  const refused = (office: string) => {
    expect(problem(() => readAppliedSettings(office, "demo"))).toBe("redirected-snapshot");
    expect(() => writeAppliedSnapshot(office, { demo: { from: office } })).toThrow(/is a link/);
    expect(readFileSync(appliedSettingsFile(b), "utf8")).toBe(before);
  };

  refused(a);
  rmSync(join(a, ".office"), { recursive: true });
  symlinkSync(join(b, ".office"), join(a, ".office"), "dir");
  refused(a);
  rmSync(join(a, ".office"));
  mkdirSync(join(a, ".office/runtime"), { recursive: true });
  symlinkSync(appliedSettingsFile(b), appliedSettingsFile(a));
  refused(a);

  // And the other way: B led into A.
  rmSync(join(a, ".office"), { recursive: true });
  writeAppliedSnapshot(a, { demo: { from: "a" } });
  const aBytes = readFileSync(appliedSettingsFile(a), "utf8");

  rmSync(join(b, ".office/runtime"), { recursive: true });
  symlinkSync(join(a, ".office/runtime"), join(b, ".office/runtime"), "dir");
  expect(problem(() => readAppliedSettings(b, "demo"))).toBe("redirected-snapshot");
  expect(() => writeAppliedSnapshot(b, { demo: { from: "b" } })).toThrow(/is a link/);
  expect(readFileSync(appliedSettingsFile(a), "utf8")).toBe(aBytes);
});

test("the office of a package is found from its real folder, not the working folder", () => {
  const office = join(dir, "office");
  const pkg = join(office, ".office/generations/g1/packages/demo");

  mkdirSync(pkg, { recursive: true });
  writeFileSync(join(office, "office.yaml"), "name: [never parsed\n");
  // A link elsewhere, such as an OpenCode plugin link, resolves to the package's own office.
  mkdirSync(join(dir, "elsewhere"));
  writeFileSync(join(dir, "elsewhere/office.yaml"), "");
  symlinkSync(pkg, join(dir, "elsewhere/demo"));

  expect(officeRootOf(join(dir, "elsewhere/demo"))).toBe(office);
});

/** Waits until `done` holds, for a file watcher's events. */
async function until(done: () => boolean) {
  for (let i = 0; i < 200 && !done(); i++) await Bun.sleep(10);
}

test("a watch reports its package's changes across replacement by rename, and nothing for another package's", async () => {
  mkdirSync(join(dir, ".office/runtime"), { recursive: true });
  const changes: AppliedSettings[] = [];
  const errors: (string | undefined)[] = [];
  const watch = watchAppliedSettings(dir, "demo", settings => changes.push(settings), error => errors.push(error instanceof AppliedSettingsError ? error.problem : error.message));

  try {
    publishAppliedSettings({ dir }, [entry("demo", { port: 1, nested: { a: 1, b: 2 } }), entry("other", { x: 1 })]);
    await until(() => changes.length > 0);
    expect(changes).toEqual([{ port: 1, nested: { a: 1, b: 2 } }]);

    // Another package's change, the same values in another key order, an unrelated file: nothing.
    publishAppliedSettings({ dir }, [entry("demo", { nested: { b: 2, a: 1 }, port: 1 }), entry("other", { x: 2 })]);
    writeFileSync(join(dir, ".office/runtime/settings.json.new"), "{}");
    renameSync(join(dir, ".office/runtime/settings.json"), join(dir, ".office/runtime/settings.json.old"));
    writeFileSync(join(dir, ".office/runtime/settings.json"), `{"packages": {"other": {"x": 2}, "demo": {"nested": {"b": 2, "a": 1}, "port": 1}}}`);
    await Bun.sleep(150);
    expect(changes).toHaveLength(1);

    publishAppliedSettings({ dir }, [entry("demo", { port: 2 }), entry("other", { x: 2 })]);
    await until(() => changes.length > 1);
    expect(changes.at(-1)).toEqual({ port: 2 });

    // Withdrawn, then back with the last values: an error, then nothing new.
    publishAppliedSettings({ dir }, [entry("other", { x: 2 })]);
    await until(() => errors.includes("missing-package"));
    publishAppliedSettings({ dir }, [entry("demo", { port: 2 })]);
    await Bun.sleep(150);
    expect(changes).toHaveLength(2);
  } finally {
    watch.close();
  }
});

test("a watch that starts before its package is applied reports the first application", async () => {
  // As sync leaves it after a fetch failed: the folder, then a snapshot without the package.
  mkdirSync(join(dir, ".office/runtime"), { recursive: true });
  const changes: AppliedSettings[] = [];
  const errors: string[] = [];
  const watch = watchAppliedSettings(dir, "demo", settings => changes.push(settings), error => errors.push(error instanceof AppliedSettingsError ? error.problem : error.message));

  try {
    expect(watch.settings).toBeUndefined();
    expect(errors).toEqual(["missing-snapshot"]);
    publishAppliedSettings({ dir }, [entry("other", {})]);
    await until(() => errors.length > 1);
    expect(errors.at(-1)).toBe("missing-package");
    publishAppliedSettings({ dir }, [entry("demo", { port: 3 }), entry("other", {})]);
    await until(() => changes.length > 0);
    expect(changes).toEqual([{ port: 3 }]);
  } finally {
    watch.close();
  }

  // Without the folder it says why and reports nothing; it makes nothing.
  const elsewhere = join(dir, "unsynced");
  const failed: string[] = [];

  mkdirSync(elsewhere);
  watchAppliedSettings(elsewhere, "demo", () => {}, error => failed.push(error.message)).close();
  expect(failed[0]).toContain("can't watch");
  expect(existsSync(join(elsewhere, ".office"))).toBe(false);
});

test("a watch through a redirected runtime folder is refused before it watches, so the other office's syncs call nothing", async () => {
  const [a, b] = [join(dir, "a"), join(dir, "b")];

  writeAppliedSnapshot(b, { demo: { from: "b" } });
  mkdirSync(join(a, ".office"), { recursive: true });
  symlinkSync(join(b, ".office/runtime"), join(a, ".office/runtime"), "dir");
  const calls: string[] = [];
  const watch = watchAppliedSettings(a, "demo", () => calls.push("change"), error => calls.push(error instanceof AppliedSettingsError ? error.problem : error.message));

  try {
    expect(watch.settings).toBeUndefined();
    expect(calls).toEqual(["redirected-snapshot"]);
    writeAppliedSnapshot(b, { demo: { from: "b again" } });
    await Bun.sleep(150);
    expect(calls).toEqual(["redirected-snapshot"]);
  } finally {
    watch.close();
  }
});
