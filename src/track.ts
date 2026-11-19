// What a tracked pin moves to: the commit a branch names, or the commit of the highest stable
// SemVer tag matching a pattern such as `v2.*`. Read with `git ls-remote`, so any Git host works
// and no release API is involved; `office skills update` and `office packages update` record the
// full commit SHA it returns.
import { execFileSync } from "node:child_process";

/** A tracked ref, resolved: the full commit SHA and how it was chosen, for messages. */
export type Resolved = { commit: string; via: string };

/** A tag as `git ls-remote --tags` lists it: its name and the commit it points to. */
export type RemoteTag = { name: string; commit: string };

/** Whether `track` is a tag pattern rather than a branch. */
export function isTagPattern(track: string): boolean {
  return track.includes("*");
}

// A stable version at the end of a tag, after a prefix that ends in neither a digit nor a dot:
// v2.10.0 and release-1.2.3 are versions, v2.1.0-rc.1, v2.1 and v2.1.0.1 are not.
const stableTag = /^(?:.*[^0-9.])?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function globRegex(pattern: string): RegExp {
  return new RegExp(`^${pattern.split("*").map((part) => part.replaceAll(/[.+?^${}()|[\]\\/]/g, "\\$&")).join(".*")}$`);
}

/**
 * The tag matching `pattern` with the highest stable version, compared as numbers (v2.10.0 is
 * above v2.9.0), and how many matched; undefined when none does. Equal versions go to the first
 * name in sort order, so the choice never depends on the order tags were pushed.
 */
export function highestTag(pattern: string, tags: RemoteTag[]): { tag: RemoteTag; matched: number } | undefined {
  const glob = globRegex(pattern);
  let best: { tag: RemoteTag; version: number[] } | undefined;
  let matched = 0;

  for (const tag of tags) {
    const parts = stableTag.exec(tag.name);

    if (parts === null || !glob.test(tag.name)) continue;

    matched += 1;

    const version = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
    const order = best === undefined ? 1 : compare(version, best.version) || (tag.name < best.tag.name ? 1 : -1);

    if (order > 0) best = { tag, version };
  }

  return best === undefined ? undefined : { tag: best.tag, matched };
}

function compare(left: number[], right: number[]): number {
  for (const [index, part] of left.entries()) {
    if (part !== right[index]) return part > right[index] ? 1 : -1;
  }

  return 0;
}

function lsRemote(repo: string, args: string[]): { name: string; commit: string }[] {
  const output = execFileSync("git", ["ls-remote", ...args, repo], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });

  return output.split("\n").flatMap((line) => {
    const [commit, name] = line.split("\t");

    return commit !== undefined && name !== undefined && /^[0-9a-f]{40,64}$/.test(commit) ? [{ name, commit }] : [];
  });
}

/** The tags of `repo`, each at the commit it points to (an annotated tag's own commit, not the tag object). */
export function remoteTags(repo: string): RemoteTag[] {
  const tags = new Map<string, string>();

  for (const { name, commit } of lsRemote(repo, ["--tags"])) {
    const peeled = name.endsWith("^{}");
    const tag = name.replace(/^refs\/tags\//, "").replace(/\^\{\}$/, "");

    if (peeled || !tags.has(tag)) tags.set(tag, commit);
  }

  return [...tags].map(([name, commit]) => ({ name, commit }));
}

/**
 * Where `track` of `repo` is now: the branch's commit, or the highest stable tag matching the
 * pattern. Throws with a message saying what was looked for when nothing matches.
 */
export function resolveTrack(repo: string, track: string): Resolved {
  if (!isTagPattern(track)) {
    const branch = lsRemote(repo, ["--heads"]).find((ref) => ref.name === `refs/heads/${track}`);

    if (branch === undefined) throw new Error(`${repo} has no branch ${track}`);

    return { commit: branch.commit, via: `branch ${track}` };
  }

  const tags = remoteTags(repo);
  const found = highestTag(track, tags);

  if (found === undefined) throw new Error(`no stable SemVer tag of ${repo} matches ${track} (of ${tags.length} ${tags.length === 1 ? "tag" : "tags"}; prereleases don't count)`);

  return { commit: found.tag.commit, via: `tag ${found.tag.name}, the highest of ${found.matched} stable ${found.matched === 1 ? "tag" : "tags"} matching ${track}` };
}

/** A commit for messages: its first twelve characters. */
export function short(commit: string): string {
  return /^[0-9a-f]{40,64}$/.test(commit) ? commit.slice(0, 12) : commit;
}
