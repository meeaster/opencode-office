import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileHashes, requiredPackages, sourceFile } from "./packages.ts";
import { writePackage } from "./test-package.ts";

/** Finish a minimal synced office with the test's office package and the other required built-ins. */
export function recordRequiredFixtures(officePackage: string) {
  for (const name of requiredPackages) {
    const dir = join(dirname(officePackage), name);
    mkdirSync(dir, { recursive: true });

    if (dir !== officePackage && !existsSync(join(dir, "package.json"))) writePackage(join(dir, "package.yaml"), `# fixture\n{}\n`);
    writeFileSync(join(dir, sourceFile), JSON.stringify({ office: "fixture", commit: "fixture", files: fileHashes(dir) }));
  }
}

/** The required built-ins of a synced office at `office`, as fixtures, keeping any the test wrote. */
export function recordRequiredBuiltins(office: string) {
  const officePackage = join(office, ".office/packages/office");

  if (!existsSync(join(officePackage, "package.json"))) writePackage(join(officePackage, "package.yaml"), "# fixture\n{}\n");
  recordRequiredFixtures(officePackage);
}
