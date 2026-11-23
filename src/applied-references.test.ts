import { afterEach, beforeEach, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appliedReferences, referenceFile, writeAppliedReferences } from "./applied-references.ts";
import { syncLines as sync } from "./sync.fixture.ts";
import { gatherPackages } from "./gather.ts";
import { sources } from "./github.ts";
import { officeInstructions } from "../packages/office/plugin/instructions.ts";
import { loadOffice } from "./office.ts";
import { definitionText, writePackage } from "./test-package.ts";

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "office-applied-")); });

afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const own = { references: [{ name: "docs", url: "https://example.com/docs.git" }] };
const file = () => join(dir, referenceFile);

test("the applied references are read back with their owners, in the order written; without a file, office.yaml's own", () => {
  expect(appliedReferences(dir, own)).toEqual({ ok: true, value: [{ name: "docs", url: "https://example.com/docs.git", owner: "office.yaml" }] });

  const written = [
    { name: "docs", url: "https://example.com/docs.git", owner: "office.yaml" },
    { name: "zeta", url: "https://example.com/zeta.git", ref: "main", description: "Zeta's docs", owner: "zulu" },
    { name: "alpha", url: "https://example.com/alpha.git", owner: "alpha" },
  ];

  writeAppliedReferences(dir, written);
  expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ references: written });
  expect(appliedReferences(dir, own)).toEqual({ ok: true, value: written });
});

test("a file that isn't JSON, has another shape or lists a name twice is a problem naming it, never an empty list", () => {
  mkdirSync(join(dir, ".office/resolved"), { recursive: true });

  for (const [text, problem] of [
    ["{", "JSON"],
    [JSON.stringify({ version: 4, references: [] }), "version"],
    [JSON.stringify({ references: [{ name: "docs", url: "u", owner: "a" }, { name: "docs", url: "v", owner: "b" }] }), "lists reference docs more than once"],
  ]) {
    writeFileSync(file(), text);
    const read = appliedReferences(dir, own);

    expect(read.ok).toBe(false);
    expect(read.ok ? "" : read.errors.join("\n")).toContain(referenceFile);
    expect(read.ok ? "" : read.errors.join("\n")).toContain(problem);
  }
});

test("a link to nothing is an invalid file, not a missing one; a write replaces a link at the path without writing through it", () => {
  const target = join(dir, "elsewhere.json");
  mkdirSync(join(dir, ".office/resolved"), { recursive: true });
  symlinkSync(target, file());

  expect(appliedReferences(dir, own)).toEqual({ ok: false, errors: [`${referenceFile}: is a link to ${target}, which doesn't exist`] });
  writeFileSync(target, "kept\n");
  writeAppliedReferences(dir, [{ name: "docs", url: "u", owner: "office.yaml" }]);
  expect(lstatSync(file()).isFile()).toBe(true);
  expect(readFileSync(target, "utf8")).toBe("kept\n");
});

/** A local package that adds one reference, named for the package. */
function referencing(office: string, name: string, url: string) {
  writePackage(join(office, "packages", name, "office.ts"), definitionText(`{setup(c){c.add(repositories,{name:"${name}-docs",url:${JSON.stringify(url)}})}}`, 'import {repositories} from "@office/references/repositories";'), { dependencies: ["references"] });
}

test("sync records office.yaml's references, then the packages' in the order they were set up, not alphabetically; check's gathering agrees", async () => {
  const office = join(dir, "office");
  mkdirSync(office);

  for (const name of ["zulu", "alpha"]) referencing(office, name, `https://example.com/${name}.git`);

  // From source, a local package resolves its @office imports through the published set's editor link.
  writeFileSync(join(office, "office.yaml"), "name: t\n");
  await sync(loadOffice(office), { scope: "packages" });
  writeFileSync(join(office, "office.yaml"), "name: t\nreferences: [{name: own, url: https://example.com/own.git}]\npackages:\n  - name: zulu\n  - name: alpha\n");
  expect((await sync(loadOffice(office), { scope: "packages" })).filter(line => line.startsWith("FAILED"))).toEqual([]);

  const order = ["own", "zulu-docs", "alpha-docs"];
  const read = appliedReferences(office, loadOffice(office));
  expect(read.ok ? read.value.map(entry => [entry.name, entry.owner]) : read.errors).toEqual([["own", "office.yaml"], ["zulu-docs", "zulu"], ["alpha-docs", "alpha"]]);
  expect((await gatherPackages(loadOffice(office))).references.map(entry => entry.name)).toEqual(order);
});

test("before the first sync, the guidance and the GitHub planner's sources take office.yaml's own references", () => {
  const office = join(dir, "office");
  mkdirSync(office);
  writeFileSync(join(office, "office.yaml"), "name: t\nreferences: [{name: docs, url: https://github.com/example/docs.git}]\n");
  const read = appliedReferences(office, loadOffice(office));

  if (!read.ok) throw new Error(read.errors.join("; "));
  expect(officeInstructions(office)).toContain("- `references/docs/`");
  expect(sources(loadOffice(office), read.value)).toContainEqual({ what: "reference docs", url: "https://github.com/example/docs.git", pushes: false });
});
