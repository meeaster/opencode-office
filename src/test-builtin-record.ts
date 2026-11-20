import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileHashes, sourceFile } from "./packages.ts";

/** Finish a minimal synced office with the test's office package and the other required built-in. */
export function recordRequiredFixtures(officePackage: string) {
  const references = join(dirname(officePackage), "references");
  mkdirSync(references, { recursive: true });
  writeFileSync(join(references, "package.yaml"), "name: references\ndescription: fixture\n");

  for (const dir of [officePackage, references]) {
    writeFileSync(join(dir, sourceFile), JSON.stringify({ office: "fixture", commit: "fixture", files: fileHashes(dir) }));
  }
}
