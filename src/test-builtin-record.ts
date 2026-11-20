import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileHashes, sourceFile } from "./packages.ts";

/** Mark a synthetic installed built-in's fixture bytes as the copy the test office received. */
export function recordBuiltinFixture(dir: string) {
  writeFileSync(join(dir, sourceFile), JSON.stringify({ office: "fixture", commit: "fixture", files: fileHashes(dir) }));
}
