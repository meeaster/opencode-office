import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { editorLinks } from "./package-imports.ts";
import { git } from "./git.ts";
import { officeEntries } from "../standard/opencode/ownership.ts";
import { atomicWrite } from "./secrets.ts";
import { type Office, OfficeError } from "./office.ts";
import { changeText, failure, type Change } from "./change.ts";
import * as v from "valibot";

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
  const wanted = ["/.office/*", ...[...committed].sort().map(folder => `!/${folder}`), `/${dirname(editorLinks)}/`, ...links.map(literal)];

  return editExcludeBlock(office, () => wanted);
}

/** An office-relative path as an exclude line naming that one path: leading slash, pattern characters escaped. */
function literal(path: string) {
  return `/${path.replaceAll(/[\\*?[]/g, "\\$&").replace(/ $/, "\\ ")}`;
}

/**
 * Changes only the given paths' lines in the exclude block, at once: each of `remove` stops being
 * excluded and each of `add` is excluded, every other line of the block and the file kept. For a
 * package that placed or gave up paths outside a whole sync, which rewrites the block from every
 * package's paths: its command, or its sync that is about to stop the rest.
 */
export function updateExcluded(office: Office, { add = [], remove = [] }: { add?: readonly string[]; remove?: readonly string[] }): string[] {
  const adding = add.map(path => literal(excludedPath(path)));
  const removing = new Set(remove.map(path => literal(excludedPath(path))));

  return editExcludeBlock(office, block => {
    const kept = block.filter(line => !removing.has(line) || adding.includes(line));

    return [...kept, ...adding.filter(line => !kept.includes(line))];
  }).map(changeText);
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
    return ["could not locate the office repository's info/exclude; Office's plumbing is not excluded from commits"];
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
