// Staging one exact release of a shared tool beside whatever is active, without activating it
// (src/features/tools/applied.ts does that).
//
// - A mise-managed tool installs fresh into a new mise data folder of its own in the office's tool
//   state, never into one an earlier install or another tool used, from an isolated folder: its
//   mise.toml names the exact version, no config of the caller's, the office's or the machine's is
//   read, its downloads and package store are in a throwaway folder, and mise runs behind the
//   office's Socket Firewall (src/features/tools/host.ts). mise verifies the artifact as its backend does; office adds no check
//   of its own and turns none of mise's off, and any failure of mise's, a missing prerequisite
//   included, fails the stage with mise's own words. An npm tool installs with pnpm, whose
//   transitive releases wait the tool's age. Every path mise names must be inside that data folder.
// - A provided tool runs its package's own mise task, behind Socket Firewall, in the package's real
//   folder, which is the only config mise reads, with the applied tools first on PATH and the
//   version and an empty staging folder in its environment. mise must find the task in a file of
//   that folder, or it doesn't run. Each executable it leaves must be a regular file with the
//   SHA-256 the provider's release list states for that version; only then does the folder become
//   that version's. A version's folder that is there already is used only when it still matches;
//   anything else there, or a link anywhere on the way, is refused, never replaced.
//
// Either way the staged executables' paths and SHA-256 are what activation records: what office
// identifies them by, and later sees drift against, not proof of who published them.
import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import * as v from "valibot";

import type { Release } from "../../../packages/tools/handles.ts";
import { releaseAgeVariables } from "../host/sfw.ts";
import { type AppliedExecutable, ownedFolder, projectionPath, toolsState } from "./applied.ts";
import { isolatedEnvironment, type Run, type SelectionInputs } from "./selection.ts";

/** A staged release: its identity (each executable's SHA-256 as staged), and each executable's path and SHA-256. */
export type Staged = { version: string; identity: string; bin: Record<string, AppliedExecutable> };

/** What staging needs: mise (behind sfw), how to run it, the environment to start from, and the runtimes' folders. */
export type StagingInputs = Pick<SelectionInputs, "mise" | "run" | "env" | "runtimes">;

function sha256(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);

    return true;
  } catch {
    return false;
  }
}

/** The last few lines of mise's error output that say what went wrong, without its version and verbosity notes. */
function lastLines(text: string): string {
  return text.trim().split("\n").filter(line => !/^mise ERROR (Version:|Run with --verbose)|^hint:/.test(line)).slice(-3).join(" | ");
}

function attempt(run: Run, argv: readonly string[], options: Parameters<Run>[1], what: string): string {
  const result = run(argv, options);

  if (result.status !== 0) throw new Error(`${what} failed (exit ${result.status}): ${lastLines(result.stderr || result.stdout)}`);

  return result.stdout;
}

/** A tool's own folder name: one per backend-qualified name, and never the same for two (`a/b` and `a-b` included), or a path. */
function toolFolder(tool: string): string {
  return encodeURIComponent(tool).replaceAll(".", "%2E");
}

/** A version as a folder name; throws for one that would be a path. */
function versionFolder(tool: string, version: string): string {
  if (version === "" || version.includes("/") || version.includes("\\") || /^\.+$/.test(version)) throw new Error(`tool ${tool}'s version ${JSON.stringify(version)} can't name a folder`);

  return version;
}

/** Whether `path` is `folder` or inside it, both real paths. */
function inside(folder: string, path: string): boolean {
  const way = relative(folder, path);

  return way === "" || (way !== ".." && !way.startsWith(`..${sep}`) && !way.startsWith(sep));
}

/** The identity of staged executables: each one's name and SHA-256. */
function identityOf(bin: Readonly<Record<string, AppliedExecutable>>): string {
  return Object.entries(bin).map(([name, { sha256: digest }]) => `${name} ${digest}`).join(", ");
}

/** A mise-managed tool to stage: its backend-qualified name, exact version, its executables and its consumers' age. */
export type ManagedRelease = { tool: string; version: string; bin: readonly string[]; age: string };

/**
 * Installs `release` fresh with mise into a new data folder of its own in the office's tool state,
 * every executable inside that folder. Throws naming the tool and mise's error, removing the folder.
 */
export function stageManaged(office: { state: string }, release: ManagedRelease, { mise, run, env, runtimes = [] }: StagingInputs): Staged {
  const spec = `${release.tool}@${release.version}`;

  const data = mkdtempSync(join(ownedFolder(join(ownedFolder(join(ownedFolder(toolsState(office)), "managed")), toolFolder(release.tool))), `${versionFolder(release.tool, release.version)}-`));
  const root = mkdtempSync(join(tmpdir(), "office-tool-stage-"));
  const stage = join(root, "stage");

  try {
    mkdirSync(stage);
    writeFileSync(join(stage, "mise.toml"), `[tools]\n${JSON.stringify(release.tool)} = ${JSON.stringify(release.version)}\n`);
    // An npm tool installs with pnpm, which waits the tool's age for every dependency.
    const npm = Object.fromEntries(release.tool.startsWith("npm:") ? [["MISE_NPM_PACKAGE_MANAGER", "pnpm"]] : []);
    // Nothing an earlier install downloaded or stored is reused: pnpm's store and npm's cache are this run's.
    const fresh = { pnpm_config_store_dir: join(root, "pnpm-store"), npm_config_cache: join(root, "npm-cache") };
    const environment = { ...isolatedEnvironment(env, root, stage, runtimes), ...Object.fromEntries(releaseAgeVariables(release.age)), ...fresh, ...npm, MISE_DATA_DIR: data, MISE_YES: "1" };
    const real = realpathSync(data);

    const contained = (path: string, what: string): string => {
      if (!existsSync(path) || !inside(real, realpathSync(path))) throw new Error(`tool ${spec}: mise names ${path} for ${what}, which isn't inside its fresh install in ${data}`);

      return path;
    };

    attempt(run, [...mise, "install"], { cwd: stage, env: environment }, `installing tool ${spec}`);
    contained(attempt(run, [...mise, "where", spec], { cwd: stage, env: environment }, `finding tool ${spec}`).trim(), "its install");

    const bin: Record<string, AppliedExecutable> = {};

    for (const name of release.bin) {
      const path = contained(attempt(run, [...mise, "which", name, "--tool", spec], { cwd: stage, env: environment }, `finding executable ${name} of tool ${spec}`).trim(), `executable ${name}`);

      if (!executable(path)) throw new Error(`tool ${spec} has no executable ${name} at ${path}`);
      bin[name] = { path, sha256: sha256(path) };
    }

    return { version: release.version, identity: identityOf(bin), bin };
  } catch (error) {
    rmSync(data, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const taskInfo = v.object({ source: v.string() });

/** The real path of the file mise read a task from, as `mise tasks info --json` says; undefined when it doesn't say. */
function taskSource(json: string): string | undefined {
  let parsed: unknown;

  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }

  const read = v.safeParse(taskInfo, parsed);

  return read.success && existsSync(read.output.source) ? realpathSync(read.output.source) : undefined;
}

/** A provided tool to stage: its name, exact version, executables, the package folder whose task stages it, the task, and the provider's releases. */
export type ProvidedRelease = { tool: string; version: string; bin: readonly string[]; folder: string; task: string; releases: readonly Pick<Release, "version" | "digests">[] };

/** Where a provided tool's version is kept once staged. */
function providedFolder(office: { state: string }, tool: string, version: string): string {
  return join(toolsState(office), "provided", toolFolder(tool), versionFolder(tool, version));
}

/** Each executable in `folder` against the release's digest; the first that doesn't match, or undefined. */
function mismatch(folder: string, release: Pick<Release, "digests">, bin: readonly string[]): string | undefined {
  for (const name of bin) {
    const path = join(folder, name);
    const wanted = release.digests[name];

    if (wanted === undefined) return `the release list states no digest for executable ${name}`;

    if (!lstatSync(path, { throwIfNoEntry: false })?.isFile() || !executable(path)) return `it left no executable ${name}, as a regular file`;
    const actual = sha256(path);

    if (actual !== wanted) return `executable ${name} is ${actual}, not the ${wanted} its release list states`;
  }

  return undefined;
}

/**
 * Why `release` can't be staged into its version's folder, or undefined: a link or other file on
 * the way there, or a folder there already that isn't that release's staged output. Office
 * neither follows nor replaces either.
 */
export function providedDestination(office: { state: string }, release: Pick<ProvidedRelease, "tool" | "version" | "bin" | "releases">): string | undefined {
  const spec = `${release.tool}@${release.version}`;
  const target = providedFolder(office, release.tool, release.version);
  const tools = toolsState(office);
  const listed = release.releases.find(item => item.version === release.version);

  for (let path = target; inside(tools, path); path = dirname(path)) {
    const info = lstatSync(path, { throwIfNoEntry: false });

    if (info !== undefined && !info.isDirectory()) return `tool ${spec}: ${path} is a link or not a folder, so office doesn't stage there; move it aside`;

    if (path === tools) break;
  }

  if (existsSync(target) && (listed === undefined || mismatch(target, listed, release.bin) !== undefined)) return `tool ${spec}: ${target} is there already and isn't this release's staged output, so office doesn't replace it; move it aside`;

  return undefined;
}

/**
 * Stages `release` with its package's own mise task into an empty folder, which becomes the
 * version's folder once every executable matches the release list. A version already staged and
 * still matching is used as it is; any other occupant is refused (`providedDestination`). Throws
 * naming the tool.
 */
export function stageProvided(office: { state: string }, release: ProvidedRelease, { mise, run, env, runtimes = [] }: StagingInputs): Staged {
  const spec = `${release.tool}@${release.version}`;
  const listed = release.releases.find(item => item.version === release.version);

  if (listed === undefined) throw new Error(`tool ${spec} isn't among the releases its provider lists`);
  const refusal = providedDestination(office, release);

  if (refusal !== undefined) throw new Error(refusal);
  const target = providedFolder(office, release.tool, release.version);
  const staged = (folder: string): Staged => ({ version: release.version, identity: release.bin.map(name => `${name} ${listed.digests[name]}`).join(", "), bin: Object.fromEntries(release.bin.map(name => [name, { path: join(folder, name), sha256: sha256(join(folder, name)) }])) });

  if (existsSync(target)) return staged(target);
  const parent = ownedFolder(join(ownedFolder(join(ownedFolder(toolsState(office)), "provided")), toolFolder(release.tool)));
  const output = mkdtempSync(join(parent, `.stage-${release.version}-`));
  const root = mkdtempSync(join(tmpdir(), "office-tool-task-"));

  try {
    const source = realpathSync(release.folder);
    // Only the package's own folder is config: discovery stops above it, and nothing else is trusted.
    // The applied shared tools come first on PATH, so a task finds the office's bun.
    const isolated = isolatedEnvironment(env, root, source, runtimes);
    const environment = { ...isolated, PATH: [projectionPath(office), isolated.PATH].filter(Boolean).join(":"), MISE_CEILING_PATHS: dirname(source), OFFICE_TOOL_NAME: release.tool, OFFICE_TOOL_VERSION: release.version, OFFICE_STAGE_DIR: output };
    const owned = taskSource(attempt(run, [...mise, "tasks", "info", release.task, "--json"], { cwd: source, env: environment }, `finding task ${release.task} of tool ${spec}'s package`));

    if (owned === undefined || !owned.startsWith(`${source}/`)) throw new Error(`tool ${spec}: task ${release.task} isn't its package's own (mise finds it in ${owned ?? "no file"}, not under ${source})`);

    attempt(run, [...mise, "run", release.task], { cwd: source, env: environment }, `staging tool ${spec} with its package's task ${release.task}`);
    const wrong = mismatch(output, listed, release.bin);

    if (wrong !== undefined) throw new Error(`tool ${spec} didn't stage: ${wrong}`);
    renameSync(output, target);

    return staged(target);
  } finally {
    rmSync(output, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
}
