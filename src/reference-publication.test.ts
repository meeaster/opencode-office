import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOffice } from "./office.ts";
import { planReferenceApply } from "./reference-publication.ts";
import { inputHash } from "./reference-snapshot.ts";

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "office-refresh-plan-")); });

afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const yaml = (url: string) => writeFileSync(join(dir, "office.yaml"), `name: t\nreferences: [{name: docs, url: ${url}}]\n`);

/** Plan from office.yaml alone (no saved file yet), change something, then try to apply. */
function applyAfter(change: () => void) {
  yaml("first");
  const plan = planReferenceApply(loadOffice(dir));

  if (!plan.ok) throw new Error(plan.errors.join("; "));
  expect(plan.value.fromYaml).toBe(true);
  change();
  let applied = false;

  expect(() => plan.value.guard("docs", () => { applied = true; })).toThrow("reference docs: claim changed; checkout left unchanged");
  expect(applied).toBe(false);
}

test("a refresh planned from office.yaml leaves the checkout alone when office.yaml changes before it applies", () => {
  applyAfter(() => yaml("second"));
});

test("a refresh planned from office.yaml leaves the checkout alone when a first saved file is published before it applies", () => {
  applyAfter(() => {
    const office = loadOffice(dir);
    mkdirSync(join(dir, ".office/resolved"), { recursive: true });
    // The same claim, but now from a published file.
    writeFileSync(join(dir, ".office/resolved/references.json"), JSON.stringify({ version: 4, inputs: inputHash(office), owner: office.references, contributors: [] }));
  });
});
