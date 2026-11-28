import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { redactUrl } from "../../../sdk/redact-url.ts";
import { pulledFolder } from "../../bound-paths.ts";
import { copyFromRepository } from "../../git.ts";
import { failure, type Change } from "../../lib/change.ts";
import { sha256 } from "../../lib/hash.ts";
import type { Office, PackageEntry } from "../../office.ts";
import { build, buildCommit } from "../../tool.ts";
import { pulledDir, type ResolvedPackage } from "./selection.ts";
import { describeRecord, embeddedPackage, fileHashes, localEdits, officeFile, officeText, type PackageRecord, readOnlyNote, readRecord, records, replaceFolder, sourceFile, writeJson } from "./records.ts";

export { readRecord, sourceFile } from "./records.ts";

function builtinRecordFor(hashes: PackageRecord["files"]): PackageRecord {
  return { office: build().version, commit: buildCommit().sha, files: hashes };
}

/** This executable's copy of the built-in packages, for messages. */
function thisCopy(): string {
  return describeRecord(builtinRecordFor({}));
}

export function builtinSource(hashes: PackageRecord["files"]): string {
  return `built-in:${filesDigest(hashes)}`;
}

function filesDigest(hashes: PackageRecord["files"]): string {
  return sha256(JSON.stringify(Object.keys(hashes).sort().map(path => [path, hashes[path]])));
}

/** What a Git selection is: its repository, path and ref. */
export function gitSelection(source: NonNullable<PackageEntry["source"]>) {
  return `git:${sha256(JSON.stringify([source.repo, source.path, source.ref]))}`;
}

async function installBuiltinFiles(entry: PackageEntry, dir: string, wanted: Map<string, string>, hashes: PackageRecord["files"]) {
  const where = join(".office/packages", entry.name);
  const record = readRecord(dir);

  if (existsSync(dir) && Bun.deepEquals(fileHashes(dir), hashes)) {
    if (record !== undefined && !("repo" in record) && Bun.deepEquals(record.files, hashes)) return [];

    writeJson(join(dir, sourceFile), builtinRecordFor(hashes));

    return [`recorded ${where} as ${thisCopy()}`];
  }

  const edits = record === undefined ? [] : localEdits(dir, record);

  await replaceFolder(dir, async (staging) => {
    for (const [file, content] of wanted) {
      mkdirSync(dirname(join(staging, file)), { recursive: true });
      writeFileSync(join(staging, file), content);
    }

    writeJson(join(staging, sourceFile), builtinRecordFor(hashes));
  });

  if (record === undefined) return [`installed ${where}, the built-in ${entry.name} package`];

  if (edits.length > 0) return [`restored ${where}, undoing edits to ${edits.join(", ")}; ${readOnlyNote}`];

  return [`updated ${where} from ${describeRecord(record)} to ${thisCopy()}`];
}

const sourceFields = ["repo", "path", "ref"] as const;

type GitSource = Pick<NonNullable<PackageEntry["source"]>, typeof sourceFields[number]>;

export function sourceDifferences(record: GitSource, selected: GitSource) {
  return sourceFields.filter(field => record[field] !== selected[field]);
}

/** A full commit SHA. */
export const fullCommit = /^[a-f0-9]{40}$/i;

/** Whether `commit` is a full SHA, and the one `ref` names when `ref` is a full SHA itself. */
export function verifiedCommit(ref: string, commit: string): boolean {
  return fullCommit.test(commit) && (!fullCommit.test(ref) || ref.toLowerCase() === commit.toLowerCase());
}

/**
 * Copies or updates a package declared with a repository into `.office/packages/<name>/`: it
 * installs a missing one, replaces one whose record differs from the entry's repository, path or
 * ref, and restores one whose files were edited. Returns one line per change; a failure starts
 * with FAILED.
 */
async function fetchPackage(office: Office, entry: PackageEntry, source: NonNullable<PackageEntry["source"]>, boundCommit?: string, destination?: string): Promise<Change[]> {
  const { name } = entry;
  const dir = destination ?? pulledDir(office, name);
  const where = join(".office/packages", name);
  const record = readRecord(dir);
  const current = record !== undefined && "repo" in record && !sourceDifferences(record, source).length;
  const edits = record === undefined ? [] : localEdits(dir, record);

  const known = current && verifiedCommit(source.ref, record.commit) && (!boundCommit || record.commit === boundCommit);
  const revision = boundCommit ?? (known ? record.commit : source.ref);

  try {
    if (boundCommit && !verifiedCommit(source.ref, boundCommit)) throw new Error(`invalid locked commit ${boundCommit} for ${source.ref}`);

    if (known && edits.length === 0) return [];

    if (!boundCommit && (record === undefined || (current && !known)) && existsSync(dir) && readdirSync(dir).length > 0 && !fullCommit.test(source.ref)) {
      throw new Error(`cannot repair from ${source.ref} without the recorded commit; restore ${where}/${sourceFile} from office history or pin a full commit SHA`);
    }

    const commit = await replaceFolder(dir, async (staging) => {
      const copied = copyFromRepository({ ...source, ref: revision }, staging);

      if (!verifiedCommit(revision, copied)) throw new Error(`expected ${revision}, got ${copied}`);

      // A package shared from another office's packages/ carries that office's records; its
      // records describe that office, not this one.
      for (const file of records) rmSync(join(staging, file), { force: true });

      writeJson(join(staging, sourceFile), { repo: source.repo, path: source.path, ref: source.ref, commit: copied, files: fileHashes(staging), copied: new Date().toISOString() });

      return copied;
    });

    if (record === undefined) return [redactUrl(`installed ${where} from ${source.repo} at ${commit}`)];

    if (current && !known) return [`restored ${where} to ${commit} for ${source.ref}; its record named commit ${record.commit}`];

    if (current) return [`restored ${where} to its copy of ${source.ref}${commit === source.ref ? "" : ` (${commit})`}, undoing edits to ${edits.join(", ")}; ${readOnlyNote}`];

    return [`updated ${where} from ${describeRecord(record)} to ${source.ref} (${commit})`];
  } catch (error) {
    return [failure(redactUrl(`FAILED ${where} from ${source.repo}:${source.path} @ ${source.ref} (revision ${revision}): ${error instanceof Error ? error.message.trim() : String(error)}`))];
  }
}

/** Materialization does no evaluation. All managed peers live at their final paths
 * before a fresh process loads the first definition. */
export async function materializePackage(office: Office, item: ResolvedPackage, folder: string, bound?: string) {
  const dir = join(folder, item.entry.name);

  if (item.kind === "built-in") {
    const { wanted, hashes } = await embeddedPackage(item.entry.name);

    return { changes: await installBuiltinFiles(item.entry, dir, wanted, hashes) };
  }

  if (!item.entry.source) throw new Error(`missing source for ${item.entry.name}`);

  return { changes: await fetchPackage(office, item.entry, item.entry.source, bound, dir) };
}

/**
 * Removes a pulled-in package whose entry left office.yaml: its folder goes, unless `retained`
 * names a copy kept elsewhere. Returns one line per change.
 */
export function removePackage(office: Office, name: string, retained?: string): string[] {
  if (!retained) rmSync(pulledDir(office, name), { recursive: true });

  return [`removed ${join(pulledFolder, name)}/, which office.yaml no longer lists`];
}

/** A pulled-in copy must match its record; a local package isn't checked. */
export function verifyCopy({ kind, entry, dir }: ResolvedPackage) {
  if (kind === "local") return;

  const record = readRecord(dir);

  if (record === undefined) throw new Error(`no readable ${sourceFile}; ${kind === "built-in" ? "office sync restores the built-in copy" : "restore it from office history or run office sync with an exact pin"}`);

  if (kind === "built-in" && "repo" in record) throw new Error("the installed copy is remote, not built-in; run office sync");

  if (kind === "remote" && !("repo" in record && entry.source && !sourceDifferences(record, entry.source).length)) {
    throw new Error("the installed copy is not from the selected source and ref; run office sync");
  }

  if ("repo" in record && !verifiedCommit(record.ref, record.commit)) throw new Error(`invalid recorded commit ${record.commit} for ${record.ref}; run office sync`);

  const edits = localEdits(dir, record);

  if (edits.length > 0) throw new Error(`package files edited: ${edits.join(", ")}; office sync restores them`);

  return record;
}

/** Writes a package's .office.json. Returns one line per change. */
export function writeOfficeDeclaration(office: Office, installed: Pick<ResolvedPackage, "dir">): string[] {
  const officePath = join(installed.dir, officeFile);
  const declared = officeText(office);

  if (existsSync(officePath) && readFileSync(officePath, "utf8") === declared) return [];
  writeFileSync(officePath, declared);

  return [`wrote ${relative(office.dir, officePath)} (opencode: ${office.opencode.mode})`];
}
