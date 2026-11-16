// Compiles `office` into one executable that carries the template, the plugins, the image files
// and the base compose file. `bun src/build.ts` writes target/office; with --install it also
// installs it as ~/.local/bin/office.
import { copyFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { assets, checkoutCommit } from "./tool.ts";

const root = resolve(import.meta.dir, "..");

/** Compiles the CLI from this checkout into `outfile`, stamped with the checkout's commit. */
export async function compile(outfile: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(root, "src/cli.ts")],
    compile: { outfile, assets: assets.map((path) => join(root, path)) },
    define: { OFFICE_COMMIT: JSON.stringify(checkoutCommit()) },
  });

  if (!result.success) throw new AggregateError(result.logs, "bun build failed");
}

if (import.meta.main) {
  const outfile = join(root, "target/office");

  await compile(outfile);
  console.log(`built ${outfile}`);

  if (process.argv.includes("--install")) {
    // Copied beside the target and renamed over it, so a running `office` (or the symlink an
    // older install left) is replaced in one step.
    const installed = join(homedir(), ".local/bin/office");

    copyFileSync(outfile, `${installed}.new`);
    renameSync(`${installed}.new`, installed);
    console.log(`installed ${installed}`);
  }
}
