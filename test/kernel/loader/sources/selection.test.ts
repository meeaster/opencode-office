import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadOffice } from "../../../../src/office.ts";
import { resolvePackages } from "../../../../src/loader/sources/selection.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-packages-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

test("an entry without repo is built-in when shipped and local otherwise; the required office package appears only once, a built-in can't come from another repository and no package is called sdk", () => {
  const office = join(dir, "office");

  write(
    join(office, "office.yaml"),
    [
      "name: t",
      "packages:",
      "  - name: knowledge",
      "  - name: mine",
      "  - name: office",
      "  - name: shared",
      "    repo: https://example.com/shared.git",
      "    path: packages/shared",
      "    ref: main",
      "  - name: sdk",
      "",
    ].join("\n"),
  );

  const { packages, problems } = resolvePackages(loadOffice(office));

  expect(packages.map((item) => [item.entry.name, item.kind, item.dir.slice(office.length + 1)])).toEqual([
    ["tools", "built-in", ".office/packages/tools"],
    ["mise-integration", "built-in", ".office/packages/mise-integration"],
    ["opencode", "built-in", ".office/packages/opencode"],
    ["office", "built-in", ".office/packages/office"],
    ["references", "built-in", ".office/packages/references"],
    ["seeds", "built-in", ".office/packages/seeds"],
    ["cron", "built-in", ".office/packages/cron"],
    ["knowledge", "built-in", ".office/packages/knowledge"],
    ["mine", "local", "packages/mine"],
    ["shared", "remote", ".office/packages/shared"],
  ]);
  // A package called sdk would take @office/sdk's place in the package set.
  expect(problems).toEqual([{ packages: ["sdk"], message: "the name sdk is reserved for @office/sdk; rename the package" }]);
});
