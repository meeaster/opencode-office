import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { editorLinks } from "./package-imports.ts";
import { git } from "./git.ts";
import { officeEntries } from "../standard/opencode/ownership.ts";
import { atomicWrite } from "./secrets.ts";
import { type Office, OfficeError } from "./office.ts";
import { changeText, failure, isFailure, type Change } from "./change.ts";
import * as v from "valibot";
import { appliedSettingsPath } from "../sdk/applied-settings.ts";

// A package's code gives the path: its type is checked here, not trusted.
const excludable = v.pipe(v.string(), v.check(path => {
  const normal = normalize(path);

  return path !== "" && !isAbsolute(path) && normal === path && normal !== ".." && !normal.startsWith(`..${sep}`) && !/[\n\r]/.test(path) && normal !== ".office" && !normal.startsWith(`.office${sep}`);
}));

/**
 * An office-relative path a package's sync function excludes from commits, checked: inside the
 * office, outside `.office/` (excluded whole already) and on one line.
 */
export function excludedPath(path: string): string {
  const read = v.safeParse(excludable, path);

  if (!read.success) throw new OfficeError(`can't exclude ${JSON.stringify(path)}: it must be a normalized path inside the office and outside .office/`);

  return read.output;
}

export const excludeStart = "# office sync: its plumbing, rewritten on each sync. Add your own lines outside this block.";
export const excludeEnd = "# end of office sync";

/**
 * The applied settings' folder, listed apart from `/.office/*` so it can be excluded on its own
 * before the first whole block is written: sync publishes the snapshot before packages' sync
 * functions, any of which can stop the rest.
 */
const runtimeLine = `/${dirname(appliedSettingsPath)}/`;

const unlocated = "could not locate the office repository's info/exclude; Office's plumbing is not excluded from commits";

/**
 * Keeps Office's plumbing out of commits without touching the owner's .gitignore: one block in the
 * repository's info/exclude naming every entry of `.office/` (packages, clones, staging and
 * generated state) but the `committed` folders packages declare, sorted, each written
 * `.office/<name>/`, which are committed, each Office plugin link, and each path packages' sync
 * functions `excluded`, with a leading slash and no trailing one so a link matches, and a path's
 * pattern characters escaped so it names that one path. Lines outside the block are the
 * owner's and stay, byte for byte, CRLF endings included. An office that isn't a Git repository's
 * root gets nothing.
 *
 * A file whose markers don't form exactly one block is left alone and reported: guessing where an
 * unterminated block ends could delete the owner's lines. The file is replaced whole by rename, from
 * a read made just before, so a reader (Git, or another sync) never sees it truncated. Two syncs
 * writing at once each keep every owner line they read, and the last rename wins; only an owner
 * edit made within that moment, between a sync's read and its rename, can be overwritten.
 */
export function excludePlumbing(office: Office, committed: readonly string[], excluded: readonly string[] = []): Change[] {
  const links = [...new Set([...officeEntries(office), ...excluded])].sort();
  const wanted = ["/.office/*", runtimeLine, ...[...committed].sort().map(folder => `!/${folder}`), `/${dirname(editorLinks)}/`, ...links.map(literal)];

  return editExcludeBlock(office, () => wanted);
}

/** An office-relative path as an exclude line naming that one path: leading slash, pattern characters escaped. */
function literal(path: string) {
  return `/${path.replaceAll(/[\\*?[]/g, "\\$&").replace(/ $/, "\\ ")}`;
}

/**
 * Excludes the applied settings' folder at once, every other line kept, so a first sync that
 * publishes them and then stops doesn't leave them to be committed. A sync that completes writes
 * the same line in its whole block. Fails, for the caller not to publish, when Git still wouldn't
 * ignore them.
 */
export function excludeAppliedSettings(office: Office): Change[] {
  // Unlike the whole block's, an unlocated exclude file fails here: the caller must not publish.
  const changes = editExcludeBlock(office, block => (block.includes(runtimeLine) ? [...block] : [...block, runtimeLine])).map(change => (change === unlocated ? failure(`FAILED ${unlocated}`) : change));

  if (changes.some(isFailure)) return changes;
  const committable = appliedSettingsCommittable(office);

  return committable === undefined ? changes : [...changes, failure(`FAILED ${committable}`)];
}

/**
 * Why Git would commit the applied settings, asked of Git with the office's real index, or nothing
 * when it ignores them. An owner's rule can re-include what the block excludes, and an office
 * inside another repository's worktree has no block of its own; an office in no worktree has
 * nothing to commit. When Git can't say whether the office is in a worktree (missing, or failing),
 * a `.git` in its folder or one above means it may be.
 */
function appliedSettingsCommittable(office: Office): string | undefined {
  const ask = (...args: string[]) => spawnSync("git", args, { cwd: office.dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  const unasked = (result: SpawnSyncReturns<string>) => `couldn't ask Git whether it ignores ${appliedSettingsPath}: ${result.error?.message ?? result.stderr.trim()}`;

  if (!existsSync(join(office.dir, ".git"))) {
    const inside = ask("rev-parse", "--is-inside-work-tree");

    if (inside.status !== 0) {
      const marker = gitMarkerAbove(office.dir);

      return marker === undefined ? undefined : `${unasked(inside)}; ${marker} may make the office part of a Git worktree, so it could be committed. Make Git work there and sync again`;
    }
  }

  const tracked = ask("ls-files", "-z", "--cached", "--", appliedSettingsPath);

  if (tracked.status !== 0) return unasked(tracked);

  if (tracked.stdout !== "") return `${appliedSettingsPath} is tracked in Git's index, so its changes would be committed; take it out of the index (git rm --cached ${appliedSettingsPath}) and sync again`;
  const ignored = ask("check-ignore", "-q", "--", appliedSettingsPath);

  if (ignored.status === 0) return undefined;

  if (ignored.status !== 1) return unasked(ignored);

  // Verbose also names a negating rule and exits 0 for it, so it only explains. The rule that
  // re-includes the file can be one on a folder above it, which Git names only for that folder.
  for (let path = appliedSettingsPath; path !== "."; path = dirname(path)) {
    const [rule = ""] = ask("check-ignore", "-v", "-n", "--", path).stdout.split("\t");

    if (rule !== "" && rule !== "::") return `Git doesn't ignore ${appliedSettingsPath}: ${rule} re-includes ${path}, so it would be committed; make Git ignore it and sync again`;
  }

  return `Git doesn't ignore ${appliedSettingsPath}, so it would be committed; make Git ignore it and sync again`;
}

/**
 * The nearest `.git`, a repository folder or a linked worktree's file, in the folder or one above,
 * found without Git. Walks the real folders, as Git does from its working folder.
 */
function gitMarkerAbove(dir: string): string | undefined {
  for (let at = realpathSync(dir); ; at = dirname(at)) {
    const marker = statSync(join(at, ".git"), { throwIfNoEntry: false });

    if (marker?.isDirectory() || marker?.isFile()) return join(at, ".git");

    if (dirname(at) === at) return undefined;
  }
}

/**
 * Changes only the given paths' lines in the exclude block, at once: each of `remove` stops being
 * excluded and each of `add` is excluded, every other line of the block and the file kept. For a
 * package that placed or gave up paths outside a whole sync, which rewrites the block from every
 * package's paths: its command, or its sync that is about to stop the rest.
 */
export function updateExcluded(office: Office, change: { add?: readonly string[]; remove?: readonly string[] }): string[] {
  return exclusionChanges(office, change).map(changeText);
}

/** `updateExcluded` for an up, which places what it excludes next: throws, naming why, when the block can't be changed. */
export function updateExcludedOrThrow(office: Office, change: { add?: readonly string[]; remove?: readonly string[] }): string[] {
  const changes = exclusionChanges(office, change);
  const failed = changes.flatMap(each => (isFailure(each) ? [each.failure.replace(/^FAILED /, "")] : each === unlocated ? [unlocated] : []));

  if (failed.length) throw new OfficeError(failed.join("; "));

  return changes.map(changeText);
}

function exclusionChanges(office: Office, { add = [], remove = [] }: { add?: readonly string[]; remove?: readonly string[] }): Change[] {
  const adding = add.map(path => literal(excludedPath(path)));
  const removing = new Set(remove.map(path => literal(excludedPath(path))));

  return editExcludeBlock(office, block => {
    const kept = block.filter(line => !removing.has(line) || adding.includes(line));

    return [...kept, ...adding.filter(line => !kept.includes(line))];
  });
}

/**
 * Replaces the lines of Office's block in info/exclude with what `next` makes of them (none when
 * there is no block yet), and returns one line per exclusion added or removed.
 */
function editExcludeBlock(office: Office, next: (block: readonly string[]) => string[]): Change[] {
  if (!existsSync(join(office.dir, ".git"))) return [];

  let exclude: string;

  try {
    // In a worktree office .git is a file; Git names the exclude file the worktrees share.
    exclude = resolve(office.dir, git(["rev-parse", "--git-path", "info/exclude"], office.dir));
  } catch {
    return [unlocated];
  }

  if (existsSync(exclude)) exclude = realpathSync(exclude);
  const text = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  const raw = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const lines = raw.map((line) => line.replace(/\r$/, ""));
  const starts = lines.flatMap((line, index) => (line === excludeStart ? [index] : []));
  const ends = lines.flatMap((line, index) => (line === excludeEnd ? [index] : []));

  if (starts.length > 1 || ends.length !== starts.length || (starts.length === 1 && ends[0] < starts[0])) {
    const at = relative(office.dir, exclude).startsWith("..") ? exclude : relative(office.dir, exclude);

    return [failure(`FAILED ${at} has ${starts.length} "${excludeStart}" and ${ends.length} "${excludeEnd}" lines, not one block; left unchanged, so Office's plumbing may not be excluded from commits. Delete the stray marker lines (or the whole block, which office sync writes again), keeping your own lines, then sync again`)];
  }

  // The block stays where it is; a file without one gets it at the end.
  const [start, end] = starts.length === 1 ? [starts[0], ends[0]] : [raw.length, raw.length - 1];
  const block = lines.slice(start + 1, end);
  const wanted = next(block);

  if (starts.length === 0 && wanted.length === 0) return [];
  const [before, after] = [raw.slice(0, start), raw.slice(end + 1)];
  // Office's lines take the file's line ending: CRLF when all of its lines have one.
  const cr = text.includes("\r\n") && !/(^|[^\r])\n/.test(text) ? "\r" : "";
  const updated = `${[...before, ...[excludeStart, ...wanted, excludeEnd].map((line) => line + cr), ...after].join("\n")}\n`;

  if (updated === text) return [];

  atomicWrite(exclude, updated, 0o644);

  const added = wanted.filter((line) => !block.includes(line));
  const removed = block.filter((line) => !wanted.includes(line));

  // A `!` line takes a path back out of the exclusions, so adding one stops excluding the path.
  const describe = (line: string, adding: boolean) => `${adding !== line.startsWith("!") ? "excluded" : "stopped excluding"} ${line.replace(/^!/, "")} from commits (info/exclude)`;

  return [
    ...added.map((line) => describe(line, true)),
    ...removed.map((line) => describe(line, false)),
  ];
}
