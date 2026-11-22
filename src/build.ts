// Compiles `office` into one executable that carries the template, the built-in packages, the image files
// and the base compose file. `bun src/build.ts` writes target/office; with --install it also
// installs it as ~/.local/bin/office. With --prerelease <id> the version becomes <version>-<id>,
// as the release workflow builds it.
import { copyFileSync, cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

import manifest from "../package.json";
import { assets, bundledPlugins, bundlePlugin, checkoutCommit, packageTests } from "./tool.ts";

const root = resolve(import.meta.dir, "..");

/**
 * How the compiled office runs. It installs nothing on import, and it ignores the bunfig.toml and
 * .env of the folder it runs in, which a compiled executable otherwise reads: a folder's preload
 * script would run, and its variables apply, before office's own code. It reads package.json
 * files, so one package's import of another follows that package's `exports`.
 */
export const runtime = { execArgv: ["--no-install"], autoloadBunfig: false, autoloadDotenv: false, autoloadPackageJson: true };

/** Compiles the CLI from this checkout into `outfile`, stamped with `version` and the checkout's commit. */
export async function compile(outfile: string, version = manifest.version): Promise<void> {
  // The built-in packages as offices hold them, staged to be embedded as `packages`: a bundled
  // plugin replaces its package's plugin/ sources with the one built index.js. Each build stages in
  // its own folder, so builds running at once (parallel test files) never share one.
  mkdirSync(join(root, "target"), { recursive: true });
  const stage = mkdtempSync(join(root, "target/stage-"));
  const staged = join(stage, "packages");

  try {
    cpSync(join(root, "packages"), staged, { recursive: true, filter: (path) => !`${relative(join(root, "packages"), path).split(sep).slice(1).join("/")}/`.startsWith(packageTests) });

    for (const name of bundledPlugins) {
      rmSync(join(staged, name, "plugin"), { recursive: true });
      mkdirSync(join(staged, name, "plugin"));
      writeFileSync(join(staged, name, "plugin/index.js"), await bundlePlugin(name));
    }

    const result = await Bun.build({
      entrypoints: [join(root, "src/cli.ts"), join(root, "src/validate-replacement.ts")],
      compile: { outfile, ...runtime, assets: [...assets.map((path) => join(root, path)), staged] },
      define: { OFFICE_COMMIT: JSON.stringify(checkoutCommit()), OFFICE_VERSION: JSON.stringify(version) },
    });

    if (!result.success) throw new AggregateError(result.logs, "bun build failed");
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
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
