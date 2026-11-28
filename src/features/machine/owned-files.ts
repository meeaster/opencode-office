import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { GatheredPackage } from "../../gather.ts";
import { failure, type Change } from "../../lib/change.ts";
import { sha256 } from "../../lib/hash.ts";
import type { Office } from "../../office.ts";
import { machineRecordPath } from "./paths.ts";
import { claim, type LinkFile, type MachineFile, type MachineRecord, ownedElsewhere, type RealFile, writeMachine } from "./record.ts";

/** A link, a file sync writes, or a file it leaves as recorded for another command to install. */
export type WantedFile = { file: LinkFile; what: string; made: string } | { file: RealFile; what: string; made: string; text: string | undefined };

/** The packages a run gathered, with the selected ones it couldn't read. */
export type MachinePackages = { unread: ReadonlySet<string>; packages: GatheredPackage[] };

export type PlanContext = MachinePackages & { office: Office; record: MachineRecord };

export type WantedFiles = { wanted: WantedFile[]; problems: string[] };

/** One line of `office check` about the machine. */
export type MachineLine = { ok: boolean | "warn"; name: string; detail: string };

type ReleaseHooks = {
  removeManagedFile: RemoveManagedFile;
  removeEmptyFolders(): void;
};

export type Reconciliation = ReleaseHooks & {
  plan(context: PlanContext): WantedFiles;
  currentManagedFile(office: Office, file: MachineFile): boolean;
  removalReason(office: Office, file: MachineFile): string;
  prepareFolders(): void;
  syncWithoutConsent(office: Office): string;
  afterPlacement(office: Office, lines: readonly Change[], files: readonly MachineFile[]): string | undefined;
  initialReport(): MachineLine[];
  reportWithoutConsent(): MachineLine;
  reportDeferredFile(office: Office, file: MachineFile, mode: "record-only" | "wanted"): MachineLine | undefined;
  missingDeferredFile(office: Office, file: MachineFile): string | undefined;
};

/** A recorded file against what is on disk. */
export type FileState = "present" | "changed" | "missing" | "dangling";

export function fileState(file: MachineFile): FileState {
  let stats;

  try {
    stats = lstatSync(file.path);
  } catch {
    return "missing";
  }

  if (file.kind === "link") {
    if (!stats.isSymbolicLink() || readlinkSync(file.path) !== file.target) return "changed";

    return existsSync(file.path) ? "present" : "dangling";
  }

  return stats.isFile() && sha256(readFileSync(file.path)) === file.sha256 ? "present" : "changed";
}

/** Whether anything, a dangling link included, is at `path`. */
export function occupied(path: string): boolean {
  try {
    lstatSync(path);

    return true;
  } catch {
    return false;
  }
}

/** Whether a recorded file is gone, and what to say about it. */
type Removal = { removed: boolean; line: Change | undefined };

/** True if the feature handled the removal; false to remove an ordinary owned file. */
export type RemoveManagedFile = (file: MachineFile, missing: boolean) => boolean;

/** Removes a recorded file that is still as the office wrote it. A changed one stays, reported. */
export function removeFile(file: MachineFile, why: string, removeManagedFile: RemoveManagedFile): Removal {
  const state = fileState(file);

  if (state === "changed") return { removed: false, line: failure(`FAILED to remove ${file.path}: it changed since office wrote it, so it stays; delete it yourself`) };

  try {
    if (removeManagedFile(file, state === "missing")) return { removed: true, line: `removed ${file.path}, ${why}` };
  } catch (error) {
    return { removed: false, line: failure(`FAILED to remove ${file.path}: ${error instanceof Error ? error.message : String(error)}`) };
  }

  if (state === "missing") return { removed: true, line: undefined };

  unlinkSync(file.path);

  return { removed: true, line: `removed ${file.path}, ${why}` };
}

/** Removes every file the record lists and the record itself, ending this office's management of the machine. */
function release(record: MachineRecord, why: string, hooks: ReleaseHooks): Change[] {
  const lines: Change[] = [];
  const kept: MachineFile[] = [];

  for (const file of record.files) {
    const result = removeFile(file, why, hooks.removeManagedFile);

    if (result.line !== undefined) lines.push(result.line);

    if (!result.removed) kept.push(file);
  }

  hooks.removeEmptyFolders();

  if (kept.length > 0) {
    writeMachine({ ...record, files: kept });

    return [...lines, failure(`FAILED to release this machine: ${machineRecordPath()} still lists what couldn't be removed; deal with it, then run office sync --release-machine again`)];
  }

  rmSync(machineRecordPath(), { force: true });

  return [...lines, `office ${record.office.name} no longer manages this machine: deleted ${machineRecordPath()}; office setup asks again before it writes there`];
}

/** `office sync --release-machine`: removes everything this office wrote on the machine and its consent. */
export function releaseMachine(office: Office, hooks: ReleaseHooks): Change[] {
  const current = claim(office);

  if (current.kind === "free") return [`office ${office.name} doesn't manage this machine; nothing to remove`];

  if (current.kind === "other") return [failure(`FAILED: ${ownedElsewhere(current.record)}`)];

  return release(current.record, "as office sync --release-machine asked", hooks);
}

/** What to say about a wanted link, and what the record lists at its path afterwards. */
type Placement = { line: Change | undefined; file: MachineFile | undefined };

/** Writes or links one wanted file in place, its folder made first. */
function make(wanted: WantedFile): void {
  mkdirSync(dirname(wanted.file.path), { recursive: true });

  if (wanted.file.kind === "link") {
    symlinkSync(wanted.file.target, wanted.file.path);

    return;
  }

  const text = "text" in wanted ? wanted.text : undefined;

  if (text === undefined) return;

  writeFileSync(wanted.file.path, text);
  chmodSync(wanted.file.path, text.startsWith("#!") ? 0o755 : 0o644);
}

/** Whether a recorded file is the wanted one, as it is on disk. */
function same(recorded: MachineFile, wanted: MachineFile): boolean {
  if (recorded.kind === "link") return wanted.kind === "link" && recorded.target === wanted.target;

  return wanted.kind === "file" && recorded.sha256 === wanted.sha256;
}

/** Whether an earlier receipt at this path still matches the wanted file on disk. */
export function stillRecorded(record: MachineRecord, file: MachineFile): boolean {
  return record.files.some(prior => prior.path === file.path && same(prior, file) && fileState(prior) === "present");
}

/**
 * Makes one wanted file: created, rewritten or relinked from what the record says it was, or
 * refused. A file without text is only kept as recorded.
 */
function place(wanted: WantedFile, recorded: MachineFile | undefined): Placement {
  const { file, what } = wanted;
  const verb = file.kind === "link" ? "link" : "write";

  if ("text" in wanted && wanted.text === undefined) return { line: undefined, file: recorded };

  if (recorded === undefined) {
    if (occupied(file.path)) return { line: failure(`FAILED to ${verb} ${what}: ${file.path} exists and ${machineRecordPath()} doesn't list it, so office leaves it; move it away and run office sync`), file: undefined };

    make(wanted);

    return { line: file.kind === "link" ? `linked ${file.path} to ${what}${wanted.made}` : `wrote ${file.path}, ${what}${wanted.made}`, file };
  }

  const state = fileState(recorded);

  if (state === "changed") return { line: failure(`FAILED to ${verb} ${what}: ${file.path} changed since office wrote it, so office leaves it; delete it and run office sync`), file: recorded };

  if (state === "present" && same(recorded, file)) return { line: undefined, file };

  if (state !== "missing") unlinkSync(file.path);

  make(wanted);

  const again = state === "missing" ? "restored" : file.kind === "link" ? "relinked" : "rewrote";

  return { line: file.kind === "link" ? `${again} ${file.path} to ${what}` : `${again} ${file.path}, ${what}`, file };
}

/**
 * `office sync`'s part on the machine. In host mode, with consent, it makes the global conf.d hold
 * a link to each of the office's machine-wide files, removes links whose file is gone, and repairs links
 * of an office that moved; in container mode it removes everything the office wrote and the record.
 * Returns one line per change; a refusal starts with FAILED.
 */
export function syncMachine(office: Office, hooks: Reconciliation, packages?: MachinePackages): Change[] {
  const current = claim(office);

  if (office.opencode.mode !== "host") return current.kind === "ours" ? release(current.record, "as the office now runs OpenCode in its container", hooks) : [];

  if (current.kind === "other") return [failure(`FAILED to link this office's tools on the machine: ${ownedElsewhere(current.record)}`)];

  if (current.kind === "free") return [hooks.syncWithoutConsent(office)];

  if (packages === undefined) throw new Error("linking a host office's machine files needs its gathered packages");
  const { record, movedFrom } = current;
  const { wanted, problems } = hooks.plan({ office, record, packages: packages.packages, unread: packages.unread });
  const lines = [...(movedFrom === undefined ? [] : [`office ${office.name} moved from ${movedFrom}; ${machineRecordPath()} now names ${office.dir}`]), ...problems.map((problem) => failure(`FAILED ${problem}`))];
  const files: MachineFile[] = [];

  for (const file of record.files) {
    if (hooks.currentManagedFile(office, file)) {
      files.push(file);

      continue;
    }

    if (wanted.some((entry) => entry.file.path === file.path)) continue;

    const result = removeFile(file, hooks.removalReason(office, file), hooks.removeManagedFile);

    if (result.line !== undefined) lines.push(result.line);

    if (!result.removed) files.push(file);
  }

  hooks.removeEmptyFolders();
  hooks.prepareFolders();

  for (const entry of wanted) {
    const result = place(entry, record.files.find((file) => file.path === entry.file.path));

    if (result.line !== undefined) lines.push(result.line);

    if (result.file !== undefined) files.push(result.file);
  }

  const notice = hooks.afterPlacement(office, lines, files);

  if (notice !== undefined) lines.push(notice);

  const next: MachineRecord = { ...record, office: { name: office.name, dir: office.dir }, files };

  if (JSON.stringify(next) !== JSON.stringify(record)) writeMachine(next);

  return lines;
}

/**
 * What `office check` says of the machine: who manages it, and each file the office wrote or wants
 * there. Without `packages` (the gathering was incomplete), what packages want isn't compared; each
 * recorded file is still checked against the record.
 */
export function machineReport(office: Office, hooks: Reconciliation, packages?: MachinePackages): MachineLine[] {
  const current = claim(office);
  const lines = hooks.initialReport();

  if (office.opencode.mode !== "host") {
    if (current.kind === "ours") lines.push({ ok: false, name: "machine", detail: `${machineRecordPath()} still names this container-mode office; office sync removes its files and the record` });

    return lines;
  }

  if (current.kind === "other") return [...lines, { ok: false, name: "machine", detail: ownedElsewhere(current.record) }];

  if (current.kind === "free") return [...lines, hooks.reportWithoutConsent()];

  const { record, movedFrom } = current;

  lines.push(
    movedFrom === undefined
      ? { ok: true, name: "machine", detail: `managed by this office since ${record.consented}, recorded in ${machineRecordPath()}` }
      : { ok: false, name: "machine", detail: `the record names ${movedFrom}, where this office was; office sync moves it here and relinks its tools` },
  );

  // Without every package's claims, nothing says which files the office wants now.
  if (packages === undefined) {
    for (const file of record.files) {
      if (hooks.currentManagedFile(office, file)) continue;

      lines.push(hooks.reportDeferredFile(office, file, "record-only") ?? recordedLine(file));
    }

    return lines;
  }

  const { wanted, problems } = hooks.plan({ office, record, packages: packages.packages, unread: packages.unread });

  lines.push(...problems.map((problem) => ({ ok: false, name: "machine", detail: problem })));

  for (const file of record.files) {
    if (hooks.currentManagedFile(office, file)) continue;

    const want = wanted.find((entry) => entry.file.path === file.path);

    lines.push((want === undefined ? undefined : hooks.reportDeferredFile(office, file, "wanted")) ?? fileLine(file, want));
  }

  for (const entry of wanted) {
    if (record.files.some((file) => file.path === entry.file.path)) continue;

    const { file } = entry;
    const missing = hooks.missingDeferredFile(office, file) ?? (file.kind === "link" ? `not linked yet; office sync links ${entry.what}` : `not written yet; office sync writes ${entry.what}`);

    lines.push({ ok: false, name: `machine ${file.path}`, detail: occupied(file.path) ? `exists but isn't in the record, so office won't put ${entry.what} there; move it away` : missing });
  }

  return lines;
}

/** One recorded file's line: present and as wanted, changed, missing, dangling, or no longer wanted. */
function fileLine(file: MachineFile, want: WantedFile | undefined): MachineLine {
  const state = fileState(file);
  const target = file.kind === "link" ? ` to ${file.target}` : "";
  const stale = want !== undefined && !same(file, want.file);
  const repair = want === undefined ? "removes it" : stale ? (file.kind === "link" && want.file.kind === "link" ? `relinks it to ${want.file.target}` : "rewrites it") : "restores it";
  const done = file.kind === "link" ? `links${target}` : "written";

  const details: Record<FileState, string> = {
    present: want === undefined ? `${done}, which the office no longer wants; office sync ${repair}` : stale ? `${done}, but differs from ${want.what} as office sync writes it now; office sync ${repair}` : `${done}: ${want.what}`,
    changed: `changed since office wrote it${target}; office leaves it: delete it, then office sync`,
    missing: `missing; office sync ${want === undefined ? "drops it from the record" : repair}`,
    dangling: `dangling: ${file.kind === "link" ? file.target : file.path} is gone, so mise skips it silently; office sync ${repair}`,
  };

  return { ok: state === "present" && want !== undefined && !stale, name: `machine ${file.path}`, detail: details[state] };
}

/** One recorded file's line against the record alone: as office wrote it, changed, missing or dangling. */
function recordedLine(file: MachineFile): MachineLine {
  const state = fileState(file);
  const target = file.kind === "link" ? ` to ${file.target}` : "";

  const details: Record<FileState, string> = {
    present: `${file.kind === "link" ? `links${target}` : "written"}, as office wrote it`,
    changed: `changed since office wrote it${target}; office leaves it: delete it, then office sync`,
    missing: "missing since office wrote it; office sync settles it once every package loads",
    dangling: `dangling: ${file.kind === "link" ? file.target : file.path} is gone, so mise skips it silently; office sync settles it once every package loads`,
  };

  return { ok: state === "present", name: `machine ${file.path}`, detail: details[state] };
}
