import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { sourceFile } from "../../src/loader/sources/copies.ts";
import { requiredPackages } from "../../src/loader/sources/selection.ts";
import { definitionText, writePackage } from "./test-package.ts";

export function fixtureFileHashes(dir: string) {
  const files: Record<string, string> = {};

  for (const entry of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const name = relative(dir, path);

    if (name !== ".office.json" && name !== ".source.json") files[name] = createHash("sha256").update(readFileSync(path)).digest("hex");
  }

  return files;
}

/** Finish a minimal synced office with the test's office package and the other required built-ins. */
export function recordRequiredFixtures(officePackage: string) {
  for (const name of requiredPackages) {
    const dir = join(dirname(officePackage), name);
    mkdirSync(dir, { recursive: true });

    if (dir !== officePackage && !existsSync(join(dir, "package.json"))) writePackage(join(dir, "office.ts"), definitionText("{}"));
    writeFileSync(join(dir, sourceFile), JSON.stringify({ office: "fixture", commit: "fixture", files: fixtureFileHashes(dir) }));
  }
}

/** The required built-ins of a synced office at `office`, as fixtures, keeping any the test wrote. */
export function recordRequiredBuiltins(office: string) {
  const officePackage = join(office, ".office/packages/office");

  if (!existsSync(join(officePackage, "package.json"))) writePackage(join(officePackage, "office.ts"), definitionText("{}"));
  recordRequiredFixtures(officePackage);
}
