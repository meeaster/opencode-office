// The git operations sync needs: shallow clones of a ref, kept current by fetching that ref, and
// copies of one folder of a repository.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, type BigIntStats } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import * as v from "valibot";

import type { ReferenceGit } from "../packages/references/tasks/refresh.ts";
import { RenameError, renameNoReplace } from "./no-replace.ts";
import { streamChecked } from "./report/index.ts";
import { check } from "./schema.ts";

function gitOutput(args: string[], cwd?: string, checkoutFd?: number): string {
  // Explicit POSIX stdio mapping: child fd 3 duplicates the ALREADY locked
  // description. Even SIGKILL of this process cannot drop Git's duplicate.
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: checkoutFd === undefined ? ["ignore", "pipe", "pipe"] : ["ignore", "pipe", "pipe", checkoutFd] });
}

export function git(args: string[], cwd?: string): string {
  return gitOutput(args, cwd).trim();
}

function head(dir: string): string {
  return git(["rev-parse", "HEAD"], dir);
}

/** Compare the configured fetch origin before even cleaning up an unborn reference clone.
 * Git resolves a relative file remote from the checkout, independent of the CLI's cwd. */
export function referenceOriginProblem(dir: string, wanted: string): string | undefined {
  if ([dir, dirname(dir)].some(path => lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink())) return `${dir} is reached through a link; refusing to update it`;

  if (!existsSync(join(dir, ".git"))) return undefined;
  let actual;

  try {
    const urls = gitOutput(["config", "--null", "--get-all", "remote.origin.url"], dir).split("\0").slice(0, -1);

    if (urls.length !== 1) return `expected one origin ${wanted}, found ${urls.join(", ")}; checkout left unchanged`;
    [actual] = urls;
  } catch {
    return `expected origin ${wanted}, but ${dir} has no readable origin; checkout left unchanged`;
  }

  if (actual === wanted) return;

  // Git may store an absolute local origin for a relative clone argument. Require the
  // same existing path; lexical normalization alone doesn't establish that through links.
  if (![actual, wanted].some(url => /^[^/]+:/.test(url))) {
    const local = (url: string) => realpathSync.native(isAbsolute(url) ? url : `${dir}/${url}`);

    try {
      if (local(actual) === local(wanted)) return;
    } catch {
      // An unavailable path cannot establish equivalence.
    }
  }

  return `expected origin ${wanted}, found ${actual}; checkout left unchanged`;
}

// Stored with the checkout, only after a successful fetch and checkout. A package-only
// sync can publish a new desired ref without ever applying it to an existing clone.
const appliedReference = "office.appliedReference";
const appliedPair = v.strictObject({ origin: v.string(), ref: v.string(), commit: v.string() });

function recordReference(dir: string, origin: string, ref: string, commit: string, checkoutFd?: number): void {
  if (head(dir) !== commit) throw new Error(`reference ${dir}: HEAD is not the fetched commit ${commit}; not recording success`);
  gitOutput(["config", "--local", "--replace-all", appliedReference, JSON.stringify({ origin, ref, commit })], dir, checkoutFd);
}

/** Older ref-only or pair-only records cannot prove the commit in this worktree. */
export function appliedReferenceProblem(dir: string, origin: string, ref = "HEAD"): string | undefined {
  const missing = `desired ${origin} @ ${ref}, no unambiguous applied origin and ref with a verified commit; run a healthy reference sync`;

  try {
    const read = check(v.safeParse(appliedPair, JSON.parse(git(["config", "--local", "--get-all", appliedReference], dir))));

    if (!read.ok) return missing;
    const pair = read.value;

    if (pair.origin !== origin || pair.ref !== ref) return `desired ${origin} @ ${ref}, last applied ${pair.origin} @ ${pair.ref}; run a healthy reference sync`;
    const actual = head(dir);

    if (actual !== pair.commit) return `expected applied commit ${pair.commit}, found HEAD ${actual}; run a healthy reference sync`;
  } catch {
    return missing;
  }
}

/**
 * Whether `dir` is a clone of its own, with its own `.git`, which sync fetches into; false when
 * nothing, or an empty folder, is there to clone into. Anything else throws, naming what is
 * there: git run in it would act on whatever repository contains it, such as the office.
 */
export function isClone(dir: string): boolean {
  if (existsSync(join(dir, ".git"))) return true;

  let entry;

  try {
    entry = lstatSync(dir);
  } catch {
    // Nothing there.
    return false;
  }

  const found = entry.isSymbolicLink() ? `a link to ${readlinkSync(dir)}` : !entry.isDirectory() ? "a file" : readdirSync(dir).length > 0 ? "a folder that isn't a repository of its own (no .git)" : undefined;

  if (found === undefined) return false;

  throw new Error(`${dir} holds ${found}, not a clone; move it away so office sync can clone there`);
}

/**
 * Whether `dir` holds only a `.git` whose HEAD names no commit: what a shallow clone that failed
 * left before clones cleaned up after themselves. Nothing is lost by removing it.
 */
function unbornClone(dir: string): boolean {
  if (!existsSync(join(dir, ".git")) || readdirSync(dir).some((name) => name !== ".git")) return false;

  try {
    git(["rev-parse", "--verify", "--quiet", "HEAD"], dir);

    return false;
  } catch {
    return true;
  }
}

/**
 * Clones `url` at `ref` (a branch, tag or commit; the default branch when undefined) into `dir`,
 * shallowly. Returns "cloned"; a failed clone leaves nothing behind.
 */
export function cloneShallow(url: string, ref: string | undefined, dir: string): "cloned" {
  const existed = existsSync(dir);

  mkdirSync(dirname(dir), { recursive: true });

  try {
    git(["init", "--quiet", dir]);
    git(["remote", "add", "origin", url], dir);
    git(["fetch", "--quiet", "--depth", "1", "origin", ref ?? "HEAD"], dir);
    git(["checkout", "--quiet", "--detach", "FETCH_HEAD"], dir);
  } catch (error) {
    rmSync(existed ? join(dir, ".git") : dir, { recursive: true, force: true });

    throw error;
  }

  return "cloned";
}

/**
 * Brings a read-only clone to the newest commit of `ref`, discarding local changes: references
 * and plugin clones are never edited in place. Returns "updated" or "current".
 */
export function refreshClone(ref: string | undefined, dir: string): "updated" | "current" {
  const before = head(dir);

  git(["fetch", "--quiet", "--depth", "1", "origin", ref ?? "HEAD"], dir);
  git(["checkout", "--quiet", "--force", "--detach", "FETCH_HEAD"], dir);

  return head(dir) === before ? "current" : "updated";
}

const licenseNames = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"];

/**
 * Copies the folder `path` of `repo` at `ref` into `to`, with the repository's licence when the
 * folder has none of its own, and returns the commit copied. `ref` is a branch, a tag or a full
 * commit SHA: git fetches nothing by an abbreviated SHA.
 */
export function copyFromRepository({ repo, ref, path }: { repo: string; ref?: string; path: string }, to: string): string {
  return withCheckout(repo, ref, (checkout) => {
    copyFolder(checkout, path, to, undefined, `${repo}${ref === undefined ? "" : `@${ref}`}`);

    return head(checkout);
  });
}

/**
 * Runs `use` on a shallow checkout of `repo` at `ref` in a temporary folder, removed afterwards.
 * A failed fetch of what looks like an abbreviated SHA says so.
 */
export function withCheckout<Result>(repo: string, ref: string | undefined, use: (checkout: string) => Result): Result {
  const checkout = mkdtempSync(join(tmpdir(), "office-copy-"));

  try {
    try {
      cloneShallow(repo, ref, checkout);
    } catch (error) {
      const hint = ref !== undefined && /^[0-9a-f]{4,39}$/.test(ref) ? ` (${ref} looks like an abbreviated commit; use the full 40-character SHA)` : "";

      throw new Error(`${error instanceof Error ? error.message.trim() : String(error)}${hint}`, { cause: error });
    }

    return use(checkout);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
}

/** The commit a checkout is at. */
export function checkoutCommit(checkout: string): string {
  return head(checkout);
}

/**
 * Copies the folder `path` of a checkout into `to`, with the repository's licence when the folder
 * has none of its own. When required, `marker` must exist; `label` names the checkout in the error.
 */
export function copyFolder(checkout: string, path: string, to: string, marker: string | undefined, label: string): void {
  const source = join(checkout, path);

  if (marker !== undefined && !existsSync(join(source, marker))) throw new Error(`${label} has no ${path}/${marker}`);

  cpSync(source, to, { recursive: true });

  const license = licenseNames.find((name) => existsSync(join(checkout, name)));

  if (license !== undefined && !licenseNames.some((name) => existsSync(join(to, name)))) cpSync(join(checkout, license), join(to, license));
}

/** A working clone that agents commit in: cloned in full when missing, otherwise only fetched. */
export function cloneOrFetch(url: string, ref: string | undefined, dir: string): "cloned" | "fetched" {
  if (!isClone(dir)) {
    mkdirSync(dirname(dir), { recursive: true });
    git(["clone", "--quiet", ...(ref === undefined ? [] : ["--branch", ref]), url, dir]);

    return "cloned";
  }

  git(["fetch", "--quiet", "origin"], dir);

  return "fetched";
}

// The same operations without blocking, for sync, which runs several at once while a spinner
// shows them. Each line git prints goes to `line`; on failure the error carries git's stderr, as
// execFileSync's does. `verbose` asks git for its progress meter, which it prints only on request
// when its output isn't a terminal; otherwise git stays quiet and prints only what went wrong.
type GitOptions = { line?: (text: string) => void; verbose?: boolean };

async function gitStreamed(args: string[], cwd: string | undefined, { line = () => {}, verbose = false }: GitOptions): Promise<void> {
  const [command, ...rest] = args;
  const flags = verbose && (command === "fetch" || command === "clone") ? ["--progress"] : command === "fetch" || command === "clone" ? ["--quiet"] : [];

  await streamChecked("git", [command, ...flags, ...rest], { cwd, line, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
}

async function fetchNewShallow(url: string, ref: string | undefined, dir: string, options: GitOptions, verifyCheckout?: () => void) {
  git(["init", "--quiet", dir]);
  git(["remote", "add", "origin", url], dir);
  verifyCheckout?.();
  await gitStreamed(["fetch", "--depth", "1", "origin", ref ?? "HEAD"], dir, options);
}

function sameEntry(path: string, original: BigIntStats) {
  const entry = lstatSync(path, { bigint: true, throwIfNoEntry: false });

  return entry?.dev === original.dev && entry.ino === original.ino;
}

/** A plugin refusal whose message is safe to show: it never quotes Git output or URLs. */
export class PluginCheckoutProblem extends Error {}

export const existingPluginDestination = "existing folder at the plugin destination kept; office sync clones only into a path that does not exist. Move it aside, then sync again";

/** The commit a checkout's HEAD names, read without fetching missing promisor objects; undefined
 * when it names none (an unborn or broken checkout). Changes nothing in the checkout. */
export function verifiedHead(dir: string): string | undefined {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], {
      cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, GIT_NO_LAZY_FETCH: "1" },
    }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Office's rename into place: atomic, and never over an entry someone else put there. */
function publish(from: string, to: string) {
  try {
    renameNoReplace(from, to);
  } catch (error) {
    const code = error instanceof RenameError ? error.code : "unavailable";

    if (code === "EEXIST") throw new PluginCheckoutProblem(existingPluginDestination);
    throw new PluginCheckoutProblem(`cannot place the plugin without risking replacing an entry (${code}); nothing was published`);
  }
}

/**
 * Moves `path` into the private `holding` path and keeps it there only while it is still
 * `original` (and, with `empty`, holds nothing). Anything else, which someone substituted, goes
 * straight back without replacing anything. Returns whether `path` was ours.
 */
function withdraw(path: string, original: BigIntStats, holding: string, empty: boolean): boolean {
  try {
    renameNoReplace(path, holding);
  } catch (error) {
    if (error instanceof RenameError && error.code === "ENOENT") return false;
    throw error;
  }

  if (sameEntry(holding, original) && (!empty || readdirSync(holding).length === 0)) return true;

  try {
    renameNoReplace(holding, path);
  } catch {
    throw new PluginCheckoutProblem(`an entry that appeared at ${path} during delivery is kept at ${holding}; move it back yourself`);
  }

  return false;
}

/**
 * First delivery of a plugin clone to `dir`, which must not exist. The destination is claimed
 * with a folder made in a private staging folder and renamed into place without replacement, so
 * an owner's folder (even an empty one) is never adopted. Git fetches with the final gitdir, so
 * path-specific Git config applies, then checks out into the staging folder. Publication withdraws
 * the claim and renames the complete tree into place, again without replacement: OpenCode sees at
 * most the empty claim with its `.git`, then the whole checkout. Anything that replaces or enters
 * the claim meanwhile stays where its author put it, with the same inode and metadata.
 */
export async function clonePluginStreamed(url: string, ref: string | undefined, dir: string, officeDir: string, verifyCheckout: () => void): Promise<"cloned"> {
  mkdirSync(dirname(dir), { recursive: true });
  const work = mkdtempSync(join(officeDir, ".office-plugin-"));
  const claim = join(work, "claim");
  const tree = join(work, "tree");
  const metadata = join(dir, ".git");
  mkdirSync(join(claim, ".git"), { recursive: true });
  const folder = lstatSync(claim, { bigint: true });
  const owned = lstatSync(join(claim, ".git"), { bigint: true });
  let keep = false;

  const verify = () => {
    verifyCheckout();

    if (!sameEntry(dir, folder) || !sameEntry(metadata, owned)) throw new PluginCheckoutProblem("plugin destination changed during delivery; nothing was published");
  };

  try {
    publish(claim, dir);

    try {
      await fetchNewShallow(url, ref, dir, {}, verify);
      verify();
      mkdirSync(tree);
      git(["--work-tree", tree, "checkout", "--quiet", "--detach", "FETCH_HEAD"], dir);
      verify();

      if (!withdraw(metadata, owned, join(tree, ".git"), false) || !withdraw(dir, folder, join(work, "released"), true)) {
        throw new PluginCheckoutProblem("plugin destination changed during delivery; kept what appeared there and published nothing");
      }

      publish(tree, dir);

      return "cloned";
    } catch (error) {
      // Take back only our own claim; withdraw restores a substituted entry.
      if (withdraw(metadata, owned, join(work, "metadata"), false)) withdraw(dir, folder, join(work, "released"), true);
      throw error;
    }
  } catch (error) {
    // Keep the staging folder if it now holds an entry that could not be put back.
    if (error instanceof PluginCheckoutProblem && error.message.includes(work)) keep = true;
    throw error;
  } finally {
    if (!keep) rmSync(work, { recursive: true, force: true });
  }
}

/** `refreshClone` for a plugin checkout already verified to name a commit, without blocking. */
export async function refreshCloneStreamed(ref: string | undefined, dir: string, options: GitOptions, verifyCheckout: () => void): Promise<"updated" | "current"> {
  const before = verifiedHead(dir);

  if (!before) throw new PluginCheckoutProblem("plugin checkout has no commit; left unchanged");
  await gitStreamed(["fetch", "--depth", "1", "origin", ref ?? "HEAD"], dir, options);
  verifyCheckout(); // The fetch may have waited while another process redirected the checkout.
  git(["checkout", "--quiet", "--force", "--detach", "FETCH_HEAD"], dir);

  return head(dir) === before ? "current" : "updated";
}

/** Fetch independently; only the ticket holder may publish a clone or force its worktree. */
export function referenceGit(
  { dir, url, ref = "HEAD" }: { dir: string; url: string; ref?: string },
  guard: <T extends string | void>(apply: (fd: number) => T) => T,
): ReferenceGit {
  function targetProblem(present: boolean) {
    const problem = referenceOriginProblem(dir, url);

    if (problem) return problem;

    if (isClone(dir) !== present) return `reference checkout ${present ? "disappeared" : "already exists"}; retry sync`;
  }

  const stageClone: ReferenceGit["stageClone"] = async (options, verify) => {
    mkdirSync(dirname(dir), { recursive: true });
    const staging = mkdtempSync(join(dirname(dir), `.office-${basename(dir)}-`));
    let moved = false;

    try {
      await fetchNewShallow(url, ref, staging, options);
      git(["checkout", "--quiet", "--detach", "FETCH_HEAD"], staging);
      recordReference(staging, url, ref, head(staging));
      guard(() => {
        verify();
        renameSync(staging, dir);
        moved = true;
      });

      return "cloned";
    } finally {
      if (!moved) rmSync(staging, { recursive: true, force: true });
    }
  };

  const fetchExisting: ReferenceGit["fetchExisting"] = async (options, verify) => {
    const pending = `refs/office-fetch/${randomUUID()}`;

    try {
      await gitStreamed(["fetch", "--depth", "1", "--no-write-fetch-head", "--no-tags", "--refmap=", "--", "origin", `${ref}:${pending}`], dir, options);

      return guard(fd => {
        verify();
        const commit = git(["rev-parse", "--verify", `${pending}^{commit}`], dir);
        const before = unbornClone(dir) ? undefined : head(dir);
        // A failed/interrupted local checkout cannot leave a previous success as authority.
        gitOutput(["config", "--local", "--replace-all", appliedReference, "null"], dir, fd);
        gitOutput(["checkout", "--quiet", "--force", "--detach", commit], dir, fd);
        recordReference(dir, url, ref, commit, fd);

        return before === commit ? "current" : "updated";
      });
    } finally {
      if (existsSync(join(dir, ".git"))) git(["update-ref", "-d", pending], dir);
    }
  };

  return {
    targetProblem, appliedProblem: () => appliedReferenceProblem(dir, url, ref),
    checkBeforeFetch: verify => guard(() => verify()), stageClone, fetchExisting,
  };
}

/** `cloneOrFetch`, without blocking. */
export async function cloneOrFetchStreamed(url: string, ref: string | undefined, dir: string, options: GitOptions = {}): Promise<"cloned" | "fetched"> {
  if (!isClone(dir)) {
    mkdirSync(dirname(dir), { recursive: true });
    await gitStreamed(["clone", ...(ref === undefined ? [] : ["--branch", ref]), url, dir], undefined, options);

    return "cloned";
  }

  await gitStreamed(["fetch", "origin"], dir, options);

  return "fetched";
}
