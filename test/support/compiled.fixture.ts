import { constants, copyFileSync } from "node:fs";

import { compile } from "../../src/build.ts";

/** The full suite builds this checkout once. Targeted files build on demand; variant distributions always build themselves. */
export async function fixtureExecutable(output: string) {
  const compiled = process.env.OFFICE_TEST_DISTRIBUTION;

  if (compiled !== undefined) copyFileSync(compiled, output, constants.COPYFILE_FICLONE);
  else await compile(output);
}
