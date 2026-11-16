// The tool's own files (the template, the plugins, the image files and the base compose file),
// its version, and the command that runs it. In the compiled executable the files are embedded
// assets under import.meta.dir (/$bunfs/root); run from a checkout, they are the repository's.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import manifest from "../package.json";

/** The commit `src/build.ts` compiled from, with "+uncommitted" for a tree with changes. Defined only in the executable. */
declare const OFFICE_COMMIT: string;

/** The version `src/build.ts` compiled, such as 0.1.0 or a release's 0.1.0-20261116T154210Z. Defined only in the executable. */
declare const OFFICE_VERSION: string;

const root = Bun.isStandaloneExecutable ? import.meta.dir : resolve(import.meta.dir, "..");

/** A path inside the tool's files, such as "template/office" or "plugins/office". */
export function toolPath(path: string): string {
  return join(root, path);
}

/** The asset folders `src/build.ts` embeds, each a path relative to the repository root. */
export const assets = ["template", "target/plugins", "image", "compose.yaml"];

/**
 * A tool plugin bundled into one `index.js` with what it imports (the shared office.yaml schema
 * and its library), so an office's copy needs no packages. The header says where it comes from.
 */
export async function bundlePlugin(plugin: string): Promise<string> {
  // Bun names each bundled module in a comment, relative to the current folder; building from the
  // repository keeps the bundle the same wherever `office` runs, and free of the machine's paths.
  const previous = process.cwd();

  process.chdir(root);

  const result = await Bun.build({
    entrypoints: [toolPath(`plugins/${plugin}/index.ts`)],
    target: "bun",
    banner: `// The office tool's ${plugin} plugin, bundled from its plugins/${plugin}/. \`office sync\` replaces this copy; change the tool's.`,
  }).finally(() => process.chdir(previous));

  const [output] = result.outputs;

  if (!result.success || output === undefined) throw new AggregateError(result.logs, `bundling the ${plugin} plugin failed`);

  return output.text();
}

/**
 * The files an office's copy of a tool plugin holds, by name: embedded in the executable by
 * `src/build.ts`, or bundled now when run from a checkout.
 */
export async function pluginFiles(plugin: string): Promise<Map<string, string>> {
  if (Bun.isStandaloneExecutable) {
    // Bun embeds an asset folder under its own name, so target/plugins/ is plugins/ in the executable.
    return new Map(toolFiles(`plugins/${plugin}`).map((name) => [name, readFileSync(toolPath(`plugins/${plugin}/${name}`), "utf8")]));
  }

  return new Map([["index.js", await bundlePlugin(plugin)]]);
}

/**
 * Writes a tool file to `target`. Embedded files lose their mode, so scripts are recognised by
 * name: every executable the tool ships is a `.sh` file.
 */
export function writeToolFile(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content, { mode: target.endsWith(".sh") ? 0o755 : 0o644 });
}

/** Every file under a tool folder, as paths relative to it. */
export function toolFiles(folder: string): string[] {
  return readdirSync(toolPath(folder), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(toolPath(folder), join(entry.parentPath, entry.name)))
    .sort();
}

/** The commit of the checkout, for a run from source; "+uncommitted" when the tree has changes. */
export function checkoutCommit(): string {
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

  return `${git(["rev-parse", "--short=12", "HEAD"])}${git(["status", "--porcelain"]) === "" ? "" : "+uncommitted"}`;
}

/** `office --version`: the version and the commit it was built from. */
export function version(): string {
  const commit = Bun.isStandaloneExecutable ? OFFICE_COMMIT : checkoutCommit();
  const [hash, dirty] = commit.split("+");

  return `office ${Bun.isStandaloneExecutable ? OFFICE_VERSION : manifest.version} (commit ${hash}${dirty === undefined ? "" : ", built with uncommitted changes"})`;
}

/** How a systemd unit runs this office command: the executable itself, or the checkout's launcher. */
export function officeCommand(): string {
  return Bun.isStandaloneExecutable ? process.execPath : toolPath("bin/office");
}

/**
 * A real folder holding the image files and the base compose file, for Docker, which can't read
 * files inside the executable. It is unpacked once per content under ~/.cache/office/, so a build
 * with different image files never reuses stale ones; older folders are removed.
 */
export function unpackedImage(): string {
  // Each file's place in the tool, and its name in the unpacked folder.
  const files = [...toolFiles("image").map((name) => ({ source: `image/${name}`, name })), { source: "compose.yaml", name: "compose.yaml" }];
  const hash = createHash("sha256");

  for (const file of files) hash.update(`${file.name}\0${readFileSync(toolPath(file.source), "utf8")}\0`);

  const cache = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "office");
  const dir = join(cache, `image-${hash.digest("hex").slice(0, 16)}`);

  if (existsSync(dir)) return dir;

  for (const entry of existsSync(cache) ? readdirSync(cache) : []) {
    if (entry.startsWith("image-")) rmSync(join(cache, entry), { recursive: true, force: true });
  }

  // Written beside the final folder and renamed, so an interrupted unpack is never used.
  const staging = `${dir}.${process.pid}`;

  for (const file of files) writeToolFile(join(staging, file.name), readFileSync(toolPath(file.source), "utf8"));

  renameSync(staging, dir);

  return dir;
}

/**
 * Puts a compiled `office` into the image's build context: this executable, or, run from a
 * checkout, one compiled from it, so the container runs the same code as the host.
 */
export async function placeExecutable(context: string): Promise<void> {
  const target = join(context, "office");

  if (Bun.isStandaloneExecutable) {
    copyFileSync(process.execPath, target);

    return;
  }

  const { compile } = await import("./build.ts");

  await compile(target);
}
