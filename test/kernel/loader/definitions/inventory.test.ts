import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadOffice } from "../../../../src/office.ts";
import { resolvePackages } from "../../../../src/loader/sources/selection.ts";
import { validateReplacement } from "../../../../src/loader/definitions/inventory.ts";
import { definitionText, writePackage } from "../../../support/test-package.ts";

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

test("a replacement is checked with each selected optional provider it can import, active or not, and not with one office.yaml leaves out", () => {
  const office = join(dir, "office");
  const consumer = join(office, "packages/consumer");
  const shared = "  - name: shared\n    repo: https://example.com/shared.git\n    path: packages/shared\n    ref: main\n";

  writePackage(join(consumer, "office.ts"), definitionText("{}"));
  write(join(consumer, "shared.ts"), "");
  write(join(consumer, "package.json"), JSON.stringify({ name: "@office/consumer", office: { definition: "./office.ts", integrations: { "@office/shared": "./shared.ts" } } }));

  const candidate = (yaml: string) => {
    write(join(office, "office.yaml"), `name: t\npackages:\n  - name: consumer\n${yaml}`);
    const loaded = loadOffice(office);
    const item = resolvePackages(loaded).packages.find(pkg => pkg.entry.name === "consumer");

    if (item === undefined) throw new Error("no consumer");

    return () => validateReplacement(loaded, item);
  };

  expect(candidate(shared)).toThrow("package shared: not synced yet; run office sync");
  expect(candidate("")().entry.name).toBe("consumer");
});
