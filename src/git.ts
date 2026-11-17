// The git operations sync needs: shallow clones of a ref, kept current by fetching that ref, and
// copies of one folder of a repository.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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
 * Clones `url` at `ref` (a branch, tag or commit; the default branch when undefined) into `dir`,
 * shallowly. Returns "cloned".
 */
export function cloneShallow(url: string, ref: string | undefined, dir: string): "cloned" {
  mkdirSync(dirname(dir), { recursive: true });
  git(["init", "--quiet", dir]);
  git(["remote", "add", "origin", url], dir);
  git(["fetch", "--quiet", "--depth", "1", "origin", ref ?? "HEAD"], dir);
  git(["checkout", "--quiet", "--detach", "FETCH_HEAD"], dir);

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
 * folder has none of its own, and returns the commit copied. The folder must hold `marker`, such
 * as SKILL.md. `ref` is a branch, a tag or a full commit SHA: git fetches nothing by an
 * abbreviated SHA.
 */
export function copyFromRepository({ repo, ref, path }: { repo: string; ref?: string; path: string }, to: string, marker: string): string {
  const checkout = mkdtempSync(join(tmpdir(), "office-copy-"));

  try {
    try {
      cloneShallow(repo, ref, checkout);
    } catch (error) {
      const hint = ref !== undefined && /^[0-9a-f]{4,39}$/.test(ref) ? ` (${ref} looks like an abbreviated commit; use the full 40-character SHA)` : "";

      throw new Error(`${error instanceof Error ? error.message.trim() : String(error)}${hint}`, { cause: error });
    }

    const source = join(checkout, path);

    if (!existsSync(join(source, marker))) throw new Error(`${repo}${ref === undefined ? "" : `@${ref}`} has no ${path}/${marker}`);

    cpSync(source, to, { recursive: true });

    const license = licenseNames.find((name) => existsSync(join(checkout, name)));

    if (license !== undefined && !licenseNames.some((name) => existsSync(join(to, name)))) cpSync(join(checkout, license), join(to, license));

    return head(checkout);
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
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
