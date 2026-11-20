// The git operations sync needs: shallow clones of a ref, kept current by fetching that ref, and
// copies of one folder of a repository.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { streamChecked } from "./report/index.ts";

export function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function head(dir: string): string {
  return git(["rev-parse", "HEAD"], dir);
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
 * Removes what a failed shallow clone left in `dir`, so the next sync clones again and reports
 * the real error. Returns whether there was one.
 */
export function discardFailedClone(dir: string): boolean {
  if (!unbornClone(dir)) return false;

  rmSync(join(dir, ".git"), { recursive: true, force: true });

  return true;
}

/**
 * Runs a shallow clone's steps in `dir`, which isClone found missing or empty; when one fails it
 * removes what the clone made, so no half-initialised `.git` is left for the next sync.
 */
async function shallowInto<T>(dir: string, steps: () => T | Promise<T>): Promise<T> {
  const existed = existsSync(dir);

  try {
    return await steps();
  } catch (error) {
    rmSync(existed ? join(dir, ".git") : dir, { recursive: true, force: true });

    throw error;
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

/** `cloneShallow`, without blocking. */
export async function cloneShallowStreamed(url: string, ref: string | undefined, dir: string, options: GitOptions = {}): Promise<"cloned"> {
  mkdirSync(dirname(dir), { recursive: true });

  return shallowInto(dir, async () => {
    git(["init", "--quiet", dir]);
    git(["remote", "add", "origin", url], dir);
    await gitStreamed(["fetch", "--depth", "1", "origin", ref ?? "HEAD"], dir, options);
    git(["checkout", "--quiet", "--detach", "FETCH_HEAD"], dir);

    return "cloned" as const;
  });
}

/** `refreshClone`, without blocking. */
export async function refreshCloneStreamed(ref: string | undefined, dir: string, options: GitOptions = {}): Promise<"updated" | "current"> {
  const before = head(dir);

  await gitStreamed(["fetch", "--depth", "1", "origin", ref ?? "HEAD"], dir, options);
  git(["checkout", "--quiet", "--force", "--detach", "FETCH_HEAD"], dir);

  return head(dir) === before ? "current" : "updated";
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
