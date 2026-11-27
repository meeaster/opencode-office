// What packages' access declarations give setup and check: each selected local or built-in
// package's sources, with the settings office.yaml has now; a declaration that fails is a problem
// naming the package, never an empty answer; a Git package's code isn't run.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadOffice } from "../../../src/office.ts";
import { declaredAccess } from "../../../src/loader/access.ts";
import { definitionText, writePackage } from "../../support/test-package.ts";
import { toolPath } from "../../../src/tool.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-access-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A local package `name` whose access declaration module is `access`. */
function declaring(name: string, access: string) {
  writePackage(join(dir, "packages", name, "office.ts"), definitionText("{}"));
  writeFileSync(join(dir, "packages", name, "package.json"), JSON.stringify({ name: `@office/${name}`, office: { definition: "./office.ts", access: "./access.ts" } }));
  writeFileSync(join(dir, "packages", name, "access.ts"), access);
}

test("the example's declaration gives read and read-write remotes and nothing for a local-only entry; a failing or foreign declaration is named", async () => {
  cpSync(toolPath("examples/package-work/packages/mirrors"), join(dir, "packages/mirrors"), { recursive: true });
  declaring("thrower", 'import { Package } from "@office/sdk";\nexport default Package.access(() => { throw new Error("no settings"); });\n');
  declaring("foreign", "export default () => [];\n");
  declaring("shapeless", 'import { Package } from "@office/sdk";\nexport default Package.access(() => [{ name: "x" }]);\n');
  writeFileSync(join(dir, "office.yaml"), `name: demo
packages:
  - name: mirrors
    settings:
      mirrors:
        - {name: notes, description: Notes, url: 'https://example.com/notes.git', push: true}
        - {name: wiki, description: Wiki, url: 'https://example.com/wiki.git'}
        - {name: diary, description: Local only}
  - name: thrower
  - name: foreign
  - name: shapeless
  - {name: fetched, repo: 'https://example.invalid/never.git', path: pkg, ref: v1}
`);

  const { sources, problems } = await declaredAccess(loadOffice(dir));

  expect(sources).toEqual([
    { owner: "mirrors", name: "notes", url: "https://example.com/notes.git", access: "read-write" },
    { owner: "mirrors", name: "wiki", url: "https://example.com/wiki.git", access: "read" },
  ]);
  expect(problems).toEqual([
    "package thrower: its access declaration failed: no settings",
    "package foreign: its access declaration failed: must be the result of Package.access from @office/sdk",
    expect.stringMatching(/^package shapeless: its access declaration failed: must return a list of \{ name, url, access: "read" \| "read-write" \}: /),
  ]);
});
