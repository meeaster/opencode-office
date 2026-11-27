import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { materializePackage, writeOfficeDeclaration } from "../../../../src/loader/sources/copies.ts";
import { sourceDrift } from "../../../../src/loader/sources/drift.ts";
import { resolvePackages } from "../../../../src/loader/sources/selection.ts";
import { loadOffice } from "../../../../src/office.ts";
import { fixtureFileHashes } from "../../../support/test-builtin-record.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-drift-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("a remote copy reports an unreadable record, then reports edits and the ref mismatch independently of its declaration", async () => {
  const repo = "https://example.com/shared.git";
  const commit = "a".repeat(40);

  writeFileSync(join(dir, "office.yaml"), `name: t\npackages: [{ name: shared, repo: ${repo}, path: pkg, ref: v2 }]\n`);
  const office = loadOffice(dir);
  const [item] = resolvePackages(office, "shared").packages;

  mkdirSync(item.dir, { recursive: true });
  const record = join(item.dir, ".source.json");
  const data = join(item.dir, "data.txt");

  writeOfficeDeclaration(office, item);
  writeFileSync(record, "{");
  expect(await sourceDrift(office, item)).toEqual({
    ok: false, copyNotes: ["no readable .source.json (office sync replaces the copy)"], declarationNotes: [],
  });

  writeFileSync(data, "original\n");
  writeFileSync(record, JSON.stringify({ repo, path: "pkg", ref: "v1", commit, files: fixtureFileHashes(item.dir) }));
  writeFileSync(data, "edited\n");
  writeFileSync(join(item.dir, ".office.json"), '{"opencode":"host"}');

  expect(await sourceDrift(office, item)).toEqual({
    ok: false,
    copyNotes: [
      `from ${repo} pkg at ${commit.slice(0, 12)} (ref v1)`,
      "package files edited: data.txt (edited); office sync restores them, as packages in .office/packages/ are read-only: to change one, copy it into packages/<another name>/ and list that instead",
      "office.yaml asks for v2; office sync updates it",
    ],
    declarationNotes: [".office/packages/shared/.office.json doesn't say opencode: container; office sync writes it"],
  });
});

test("a built-in whose record still matches can differ from the executable; a local package only checks the declaration", async () => {
  writeFileSync(join(dir, "office.yaml"), "name: t\npackages: [{ name: own }]\n");
  const office = loadOffice(dir);
  const [builtin] = resolvePackages(office, "office").packages;
  const [local] = resolvePackages(office, "own").packages;

  mkdirSync(local.dir, { recursive: true });
  await materializePackage(office, builtin, join(dir, ".office/packages"));
  writeOfficeDeclaration(office, builtin);

  const current = await sourceDrift(office, builtin);
  expect(current).toEqual({ ok: true, copyNotes: [expect.stringContaining("from the built-in copy of office"), "package files as copied"], declarationNotes: [] });

  writeFileSync(join(builtin.dir, "outdated.txt"), "this file belonged to the older executable\n");
  writeFileSync(join(builtin.dir, ".source.json"), JSON.stringify({ office: "old", commit: "fixture", files: fixtureFileHashes(builtin.dir) }));
  expect(await sourceDrift(office, builtin)).toEqual({
    ok: false,
    copyNotes: ["from the built-in copy of office old (commit fixture)", "differs from this office executable's copy (office sync updates it)"],
    declarationNotes: [],
  });

  expect(await sourceDrift(office, local)).toEqual({
    ok: false,
    copyNotes: [],
    declarationNotes: ["packages/own/.office.json doesn't say opencode: container; office sync writes it"],
  });
});
