import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editorLinks, linkForEditors, writePackageLinks } from "../../../../src/loader/installed/links.ts";
import type { ResolvedPackage } from "../../../../src/loader/sources/selection.ts";
import { packageJsonText } from "../../../support/test-package.ts";

let dir: string;

beforeEach(() => { dir = realpathSync(mkdtempSync(join(tmpdir(), "office-links-"))); });

afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function pkg(name: string, kind: ResolvedPackage["kind"], folder: string): ResolvedPackage {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "office.ts"), "export default {}");
  writeFileSync(join(folder, "package.json"), packageJsonText(name));

  return { entry: { name, settings: {}, source: undefined }, kind, dir: folder };
}

test("a package set links each package it loads to its folder, relative, and a rejected one not at all", () => {
  const set = join(dir, ".office");
  const packages = [pkg("tooling", "built-in", join(set, "packages/tooling")), pkg("shared", "remote", join(set, "packages/shared")), pkg("notes", "local", join(dir, "packages/notes")), pkg("broken", "remote", join(set, "packages/broken"))];
  writePackageLinks(set, packages, ["broken"]);
  const link = (name: string) => join(set, "node_modules/@office", name);

  expect(readlinkSync(link("tooling"))).toBe("../../packages/tooling");
  expect(readlinkSync(link("shared"))).toBe("../../packages/shared");
  expect(readlinkSync(link("notes"))).toBe("../../../packages/notes");
  expect(realpathSync(link("notes"))).toBe(join(dir, "packages/notes"));
  expect(existsSync(link("broken"))).toBe(false);
  // Only the links: no generated editor configuration.
  expect(readdirSync(set).sort()).toEqual(["node_modules", "packages"]);
});

test("sync points packages/node_modules/@office at the published set for editors, and leaves the owner's folder", () => {
  const path = join(dir, editorLinks);
  const target = "../../.office/node_modules/@office";
  expect(linkForEditors(dir)).toEqual([]);
  mkdirSync(join(dir, "packages"));

  expect(linkForEditors(dir)).toEqual([`linked ${editorLinks} to the published package set, for editors`]);
  expect(readlinkSync(path)).toBe(target);
  expect(linkForEditors(dir)).toEqual([]);

  rmSync(path);
  symlinkSync("elsewhere", path);
  expect(linkForEditors(dir)).toEqual([`corrected ${editorLinks} to the published package set, for editors`]);
  expect(readlinkSync(path)).toBe(target);

  rmSync(path);
  mkdirSync(path);
  writeFileSync(join(path, "mine"), "kept");
  expect(linkForEditors(dir)).toEqual([`${editorLinks} is not Office's link; left as it is, so editors may not resolve @office imports (move it aside and sync to restore the link)`]);
  expect(lstatSync(path).isDirectory()).toBe(true);
  expect(readFileSync(join(path, "mine"), "utf8")).toBe("kept");

  // A packages/node_modules that isn't a real folder is never written through; a stale temporary is replaced.
  rmSync(join(dir, "packages/node_modules"), { recursive: true });
  mkdirSync(join(dir, "redirected"));
  symlinkSync("../redirected", join(dir, "packages/node_modules"));
  expect(linkForEditors(dir)).toEqual([`packages/node_modules is not Office's folder; left as it is, so editors may not resolve @office imports (move it aside and sync to restore the link)`]);
  expect(readdirSync(join(dir, "redirected"))).toEqual([]);
  rmSync(join(dir, "packages/node_modules"));
  mkdirSync(join(dir, "packages/node_modules"));
  symlinkSync("stale", `${path}.${process.pid}`);
  expect(linkForEditors(dir)).toEqual([`linked ${editorLinks} to the published package set, for editors`]);
  expect(readdirSync(join(dir, "packages/node_modules"))).toEqual(["@office"]);
});
