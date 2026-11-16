// Compiles `office` into one executable that carries the template, the plugins, the image files
// and the base compose file. `bun src/build.ts` writes target/office; with --install it also
// installs it as ~/.local/bin/office. With --prerelease <id> the version becomes <version>-<id>,
// as the release workflow builds it.
import { copyFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import manifest from "../package.json";
import { assets, checkoutCommit } from "./tool.ts";

const root = resolve(import.meta.dir, "..");

/** Compiles the CLI from this checkout into `outfile`, stamped with `version` and the checkout's commit. */
export async function compile(outfile: string, version = manifest.version): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(root, "src/cli.ts")],
    compile: { outfile, assets: assets.map((path) => join(root, path)) },
    define: { OFFICE_COMMIT: JSON.stringify(checkoutCommit()), OFFICE_VERSION: JSON.stringify(version) },
  });

  if (!result.success) throw new AggregateError(result.logs, "bun build failed");
}

if (import.meta.main) {
  const { values: flags } = parseArgs({ options: { install: { type: "boolean" }, prerelease: { type: "string" } } });
  const outfile = join(root, "target/office");

  await compile(outfile, flags.prerelease === undefined ? manifest.version : `${manifest.version}-${flags.prerelease}`);
  console.log(`built ${outfile}`);

  if (flags.install) {
    // Copied beside the target and renamed over it, so a running `office` (or the symlink an
    // older install left) is replaced in one step.
    const installed = join(homedir(), ".local/bin/office");

    copyFileSync(outfile, `${installed}.new`);
    renameSync(`${installed}.new`, installed);
    console.log(`installed ${installed}`);
  }
}
