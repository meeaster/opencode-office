// The links in `.agents/skills/`: which are this package's is what its receipt records, never a
// guess from a link's text. A link whose target is still the recorded one is the package's to
// replace or remove; anything else there, a dangling link included, is the owner's.
import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { linkFolder } from "./catalog.ts";
import { stateFolder } from "./git.ts";
import { skillId } from "./settings.ts";

/** The receipt: each office-relative link the package made, with its target text. Not committed. */
export const receiptFile = `${stateFolder}/links.json`;

export type Receipt = Map<string, string>;

/**
 * The receipt; empty only when there is none. Throws naming it when it isn't a file, doesn't read,
 * or records anything but links at `.agents/skills/<id>`.
 */
export function readReceipt(office: string): Receipt {
  const path = join(office, receiptFile);
  const info = lstatSync(path, { throwIfNoEntry: false });
  const aside = "move it aside, and the links it recorded count as the owner's";

  if (info === undefined) return new Map();

  if (!info.isFile()) throw new Error(`${receiptFile} isn't a file; ${aside}`);
  let text: string;

  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`${receiptFile} can't be read (${error instanceof Error ? error.message : String(error)}); ${aside}`, { cause: error });
  }

  const invalid = new Error(`${receiptFile} isn't a record of links in ${linkFolder}/; ${aside}`);
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid;
  }

  if (typeof parsed !== "object" || parsed === null || !("links" in parsed) || typeof parsed.links !== "object" || parsed.links === null || Array.isArray(parsed.links)) throw invalid;
  const links: Receipt = new Map();

  for (const [link, target] of Object.entries(parsed.links)) {
    if (typeof target !== "string" || !link.startsWith(`${linkFolder}/`) || !skillId.test(link.slice(linkFolder.length + 1))) throw invalid;
    links.set(link, target);
  }

  return links;
}

/** The recorded links that are no longer what the package placed: gone, or changed since, so the owner's. */
export function lostLinks(office: string, receipt: Receipt): string[] {
  return [...receipt].flatMap(([path, target]) => linkAt(office, path) === target ? [] : [path]);
}

function writeReceipt(office: string, receipt: Receipt) {
  const path = join(office, receiptFile);
  const temporary = `${path}.${randomUUID()}`;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temporary, `${JSON.stringify({ links: Object.fromEntries([...receipt].sort(([a], [b]) => a.localeCompare(b))) }, null, 2)}\n`);
  renameSync(temporary, path);
}

/** A link's target text, or undefined when nothing is there; `false` for an entry that isn't a link. */
function linkAt(office: string, path: string): string | false | undefined {
  const info = lstatSync(join(office, path), { throwIfNoEntry: false });

  if (info === undefined) return undefined;

  return info.isSymbolicLink() ? readlinkSync(join(office, path)) : false;
}

/** One change to `.agents/skills/`, and what it reports. */
export type Change =
  | { kind: "link"; path: string; target: string; label: string }
  | { kind: "relink"; path: string; from: string; target: string; label: string }
  | { kind: "unlink"; path: string; from: string }
  | { kind: "release"; path: string; why: string };

/**
 * What makes `.agents/skills/` hold `wanted` (office-relative link → target, with a label for
 * messages), from the receipt: the changes, and the problems that stop all of them, each naming
 * the occupied path.
 */
export function planLinks(office: string, wanted: ReadonlyMap<string, { target: string; label: string }>, receipt: Receipt) {
  const changes: Change[] = [];
  const problems: string[] = [];

  for (const folder of [dirname(linkFolder), linkFolder]) {
    const info = lstatSync(join(office, folder), { throwIfNoEntry: false });

    if (info !== undefined && !info.isDirectory()) problems.push(`${folder} isn't a folder of the office (it is a link or a file), so no skill is linked through it`);
  }

  if (problems.length) return { changes, problems };

  for (const [path, { target, label }] of wanted) {
    const current = linkAt(office, path);
    const recorded = receipt.get(path);

    if (current === undefined) changes.push({ kind: "link", path, target, label });
    else if (recorded === undefined || current !== recorded) problems.push(`${path} is already there and isn't a link this package recorded; move it aside or disable that skill`);
    else if (current !== target) changes.push({ kind: "relink", path, from: current, target, label });
  }

  for (const [path, recorded] of receipt) {
    if (wanted.has(path)) continue;
    const current = linkAt(office, path);

    if (current === undefined) changes.push({ kind: "release", path, why: "it is gone" });
    else if (current === recorded) changes.push({ kind: "unlink", path, from: recorded });
    else changes.push({ kind: "release", path, why: "it changed since this package linked it, so it is the owner's" });
  }

  return { changes, problems };
}

/** Places a link through a staged one renamed into place, so a replaced link is never missing. */
function place(office: string, path: string, target: string) {
  const staged = join(office, stateFolder, `link-${randomUUID()}`);

  mkdirSync(dirname(staged), { recursive: true });
  mkdirSync(dirname(join(office, path)), { recursive: true });
  symlinkSync(target, staged);

  try {
    renameSync(staged, join(office, path));
  } finally {
    rmSync(staged, { force: true });
  }
}

/** Applies planned changes and records the links the package now holds. Returns one line per change. */
export function applyLinks(office: string, changes: readonly Change[], receipt: Receipt): string[] {
  const held = new Map(receipt);
  const lines: string[] = [];

  for (const change of changes) {
    const { path } = change;

    // Checked again just before: an edit since the plan is the owner's.
    if (change.kind === "link") {
      if (linkAt(office, path) !== undefined) throw new Error(`${path} appeared during sync; left as it is`);
      place(office, path, change.target);
      held.set(path, change.target);
      lines.push(`linked ${path} (${change.label})`);
    } else if (change.kind === "relink") {
      if (linkAt(office, path) !== change.from) throw new Error(`${path} changed during sync; left as it is`);
      place(office, path, change.target);
      held.set(path, change.target);
      lines.push(`relinked ${path} (${change.label})`);
    } else if (change.kind === "unlink") {
      if (linkAt(office, path) !== change.from) throw new Error(`${path} changed during sync; left as it is`);
      unlinkSync(join(office, path));
      held.delete(path);
      lines.push(`unlinked ${path}`);
    } else {
      held.delete(path);
      lines.push(`stopped managing ${path}: ${change.why}`);
    }

    writeReceipt(office, held);
  }

  return lines;
}
