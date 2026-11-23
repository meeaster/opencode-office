// Git sources: one checkout per repository and commit under `.office/skills/git/`, never a copy
// in the office's history. A checkout that is there is used as it is, offline; one that isn't is
// fetched at exactly its commit. `office skills update` finds where a track points with
// `git ls-remote`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

/** Where the package keeps what it fetches and records, inside the office's uncommitted `.office/`. */
export const stateFolder = ".office/skills";

const environment = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: environment }).trim();
}

/** A commit for messages: its first twelve characters. */
export function short(commit: string): string {
  return commit.slice(0, 12);
}

/** The office-relative folder of `repo`'s checkout at `commit`. */
export function checkoutFolder(repo: string, commit: string): string {
  return `${stateFolder}/git/${createHash("sha256").update(repo).digest("hex").slice(0, 16)}/${commit}`;
}

/** The commit a checkout is at, or undefined when it isn't one git can read. */
function head(dir: string): string | undefined {
  try {
    return git(["rev-parse", "HEAD"], dir);
  } catch {
    return undefined;
  }
}

/** What is wrong with `repo`'s checkout at `commit` when one is there, read without fetching or writing. */
export function checkoutProblem(office: string, repo: string, commit: string): string | undefined {
  const folder = checkoutFolder(repo, commit);
  const dir = join(office, folder);

  if (existsSync(dir) && head(dir) !== commit) return `${folder} isn't a checkout of ${short(commit)}; remove it and sync again`;
}

/**
 * Makes `repo`'s checkout at `commit` present, fetching it only when it is missing. Returns the
 * office-relative folder and whether it was fetched. Throws, leaving nothing behind, when the
 * commit can't be fetched or the folder holds something else.
 */
export function ensureCheckout(office: string, repo: string, commit: string) {
  const folder = checkoutFolder(repo, commit);
  const dir = join(office, folder);
  const problem = checkoutProblem(office, repo, commit);

  if (problem !== undefined) throw new Error(problem);

  if (existsSync(dir)) return { folder, fetched: false };

  mkdirSync(join(office, stateFolder), { recursive: true });
  const staging = mkdtempSync(join(office, stateFolder, "fetch-"));

  try {
    git(["init", "--quiet", staging]);

    try {
      git(["fetch", "--quiet", "--depth", "1", repo, commit], staging);
    } catch {
      // A server that refuses to fetch a commit by its SHA still serves its branches and tags.
      git(["fetch", "--quiet", repo, "+refs/heads/*:refs/remotes/source/*", "+refs/tags/*:refs/tags/*"], staging);
    }

    git(["-c", "advice.detachedHead=false", "checkout", "--quiet", "--detach", commit], staging);

    if (head(staging) !== commit) throw new Error("the checkout isn't at that commit");
    mkdirSync(dirname(dir), { recursive: true });
    renameSync(staging, dir);

    return { folder, fetched: true };
  } catch {
    // Git's own output can quote a URL with its credentials, so it isn't repeated here.
    throw new Error(`could not fetch ${short(commit)} from ${repo}; check the repository URL, the commit, the network and this machine's git credentials`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/** A track, resolved: the commit and how it was chosen, for messages. */
export type Resolved = { commit: string; via: string };

// A stable version at the end of a tag, after a prefix that ends in neither a digit nor a dot.
const stableTag = /^(?:.*[^0-9.])?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function remoteRefs(repo: string, args: string[]): { name: string; commit: string }[] {
  let output: string;

  try {
    output = git(["ls-remote", ...args, repo]);
  } catch {
    throw new Error(`could not list ${repo}'s refs; check the repository URL, the network and this machine's git credentials`);
  }

  return output.split("\n").flatMap(line => {
    const [commit, name] = line.split("\t");

    return commit !== undefined && name !== undefined && /^[0-9a-f]{40}$/.test(commit) ? [{ name, commit }] : [];
  });
}

function compareVersions(left: number[], right: number[]): number {
  return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
}

/** Where `track` of `repo` points now: a branch's commit, or that of the highest stable tag matching a pattern with `*`. */
export function resolveTrack(repo: string, track: string): Resolved {
  if (!track.includes("*")) {
    const branch = remoteRefs(repo, ["--heads"]).find(ref => ref.name === `refs/heads/${track}`);

    if (branch === undefined) throw new Error(`${repo} has no branch ${track}`);

    return { commit: branch.commit, via: `branch ${track}` };
  }

  const glob = new RegExp(`^${track.split("*").map(part => part.replaceAll(/[.+?^${}()|[\]\\/]/g, "\\$&")).join(".*")}$`);
  const tags = new Map<string, string>();

  // An annotated tag is listed twice; its peeled line (^{}) names the commit.
  for (const { name, commit } of remoteRefs(repo, ["--tags"])) {
    const tag = name.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, "");

    if (name.endsWith("^{}") || !tags.has(tag)) tags.set(tag, commit);
  }

  let best: { tag: string; commit: string; version: number[] } | undefined;

  for (const [tag, commit] of [...tags].sort(([a], [b]) => a.localeCompare(b))) {
    const parts = stableTag.exec(tag);

    if (parts === null || !glob.test(tag)) continue;
    const version = [Number(parts[1]), Number(parts[2]), Number(parts[3])];

    // Of equal versions, the first name in sort order stays.
    if (best === undefined || compareVersions(version, best.version) > 0) best = { tag, commit, version };
  }

  if (best === undefined) throw new Error(`no stable SemVer tag of ${repo} matches ${track}`);

  return { commit: best.commit, via: `tag ${best.tag}` };
}

/** A page comparing two commits, for repositories on GitHub. */
export function comparison(repo: string, from: string, to: string): string | undefined {
  const github = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(repo);

  return github === null ? undefined : `https://github.com/${github[1]}/compare/${from}...${to}`;
}
