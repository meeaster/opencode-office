// The tool's own files (the template, the built-in packages with their plugin bundles, the image
// files and the base compose file), its version, and the command that runs it. In the compiled
// executable the files are embedded assets under import.meta.dir (/$bunfs/root); run from a
// checkout, they are the repository's.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

import manifest from "../package.json";

/** The full commit `src/build.ts` compiled from, with "+uncommitted" for a tree with changes. Defined only in the executable. */
declare const OFFICE_COMMIT: string;

/** The version `src/build.ts` compiled, such as 0.1.0 or a release's 0.1.0-20261116T154210Z. Defined only in the executable. */
declare const OFFICE_VERSION: string;

const root = Bun.isStandaloneExecutable ? import.meta.dir : resolve(import.meta.dir, "..");

/** The tool's GitHub repository, which publishes its releases and first-party packages. */
export const toolRepository = "meeaster/opencode-office";

/** A path inside the tool's files, such as "template/office" or "packages/knowledge". */
export function toolPath(path: string): string {
  return join(root, path);
}

/**
 * The asset folders and files `src/build.ts` embeds as they are, each a path relative to the
 * repository root (`sdk` is the SDK's source, which sync writes beside an office's packages for
 * editors). It also embeds `packages/` as offices get the built-in packages, staged per build.
 */
export const assets = ["template", "LICENSE", "image", "compose.yaml", "sdk"];

/**
 * The built-in packages whose `plugin/` an office gets as one bundled `index.js`, because the
 * plugin imports the tool's own code: the office.yaml schema and its libraries, or the applied
 * settings reader, `@office/sdk/applied-settings`.
 */
export const bundledPlugins = ["aws-emulator", "browser", "design", "office"];

/**
 * A built-in package's plugin bundled into one `index.js` with what it imports, so an office's
 * copy needs no packages. The header says where it comes from.
 */
export async function bundlePlugin(name: string): Promise<string> {
  // Bun names each bundled module in a comment, relative to the current folder; building from the
  // repository keeps the bundle the same wherever `office` runs, and free of the machine's paths.
  const previous = process.cwd();

  process.chdir(root);

  const result = await Bun.build({
    entrypoints: [toolPath(`packages/${name}/plugin/index.ts`)],
    target: "bun",
    banner: `// The ${name} package's plugin, bundled by the office tool from its packages/${name}/plugin/. \`office sync\` restores this copy; change the tool's.`,
  }).finally(() => process.chdir(previous));

  const [output] = result.outputs;

  if (!result.success || output === undefined) throw new AggregateError(result.logs, `bundling the ${name} plugin failed`);

  return output.text();
}

/** The names of the built-in packages: every folder of the tool's `packages/`. */
export function builtinPackages(): string[] {
  return readdirSync(toolPath("packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

/** A built-in package's tests, which stay in the tool: `pnpm test` runs them, and an office never does. */
export const packageTests = "test/";

/**
 * The files of a built-in package as an office holds it, by path: the package without its tests,
 * with the tool's licence, and a bundled plugin as its one built `plugin/index.js`. The executable embeds them
 * that way (`src/build.ts`); run from a checkout, the plugin is bundled now.
 */
export async function builtinFiles(name: string): Promise<Map<string, string>> {
  const folder = `packages/${name}`;
  const bundled = !Bun.isStandaloneExecutable && bundledPlugins.includes(name);
  const files = new Map<string, string>();

  for (const file of toolFiles(folder)) {
    if (!file.startsWith(packageTests) && !(bundled && file.startsWith("plugin/"))) files.set(file, readFileSync(toolPath(`${folder}/${file}`), "utf8"));
  }

  if (bundled) files.set("plugin/index.js", await bundlePlugin(name));

  files.set("LICENSE", readFileSync(toolPath("LICENSE"), "utf8"));

  return new Map([...files].sort(([a], [b]) => a.localeCompare(b)));
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

/** The full commit of the checkout, for a run from source; "+uncommitted" when the tree has changes. */
export function checkoutCommit(): string {
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

  return `${git(["rev-parse", "HEAD"])}${git(["status", "--porcelain"]) === "" ? "" : "+uncommitted"}`;
}

/** The full commit the tool was built from (run from a checkout, its HEAD), and whether the tree had changes. */
export function buildCommit() {
  const [sha = "", dirty] = (Bun.isStandaloneExecutable ? OFFICE_COMMIT : checkoutCommit()).split("+");

  return { sha, dirty: dirty !== undefined };
}

/** What an `office` was built from: its version, the commit's 12-character hash, and whether the tree had changes. */
export type Build = { version: string; commit: string; dirty: boolean };

export function build(): Build {
  const { sha, dirty } = buildCommit();

  return { version: Bun.isStandaloneExecutable ? OFFICE_VERSION : manifest.version, commit: sha.slice(0, 12), dirty };
}

/** `office --version`: the version and the commit it was built from. */
export function version(): string {
  const { version: built, commit, dirty } = build();

  return `office ${built} (commit ${commit}${dirty ? ", built with uncommitted changes" : ""})`;
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
