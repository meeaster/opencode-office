import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileHashes, requiredPackages, sourceFile } from "./packages.ts";

/** Finish a minimal synced office with the test's office package and the other required built-ins. */
export function recordRequiredFixtures(officePackage: string) {
  for (const name of requiredPackages) {
    const dir = join(dirname(officePackage), name);
    mkdirSync(dir, { recursive: true });

    if (dir !== officePackage) writeFileSync(join(dir, "package.yaml"), `name: ${name}\ndescription: fixture\n`);
    writeFileSync(join(dir, sourceFile), JSON.stringify({ office: "fixture", commit: "fixture", files: fileHashes(dir) }));
  }
}
