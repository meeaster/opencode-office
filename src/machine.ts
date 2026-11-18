// What a host-mode office writes on its machine, outside its folder and its state: for now, a link
// in mise's global conf.d to each of the office's machine-wide mise files, its `machine.toml` and
// the packages' fragments in `.office/mise/`, which mise loads nowhere else, so the office's tools
// apply in every folder. The rules, for every such file:
//
// - Whole files only, each named `office-<office name>-…` (a real file also starts with a marker
//   line). The office never edits a file it didn't write, and never replaces a path the machine
//   record doesn't list: it reports it instead.
// - The machine record, `$XDG_DATA_HOME/office/machine.json`, lists each file with its kind, the
//   package it belongs to and what it points at or its hash, and names the one office that manages
//   the machine. A second host-mode office, in another folder, is refused; the same office (by
//   name) that moved folders takes its entries along and relinks them.
// - The record exists only once the user said yes: `office setup` asks (or takes
//   `--manage-machine`) and writes it. Until then `office sync` writes nothing here and says what to
//   run.
// - `office sync` removes a file when its fragment goes, and everything (with the record) when the
//   office leaves host mode or `office sync --release-machine` asks; `office down` leaves them.
//
// OFFICE_MACHINE_RECORD replaces the record's path, and OFFICE_MISE_CONFIG_DIR the mise config
// folder whose conf.d gets the links, so tests and scratch offices never touch the real ones. A
// scratch office that runs mise sets MISE_CONFIG_DIR to the same folder, so mise reads the links.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";

import * as v from "valibot";

import { type Office, OfficeError, readConfig } from "./office.ts";
import { fragmentOwner, machineFile, machineFiles } from "./package-tools.ts";
import { check } from "./schema.ts";

/** Replace the machine record's path and the global mise config folder, for tests and scratch offices. */
export const machineRecordVariable = "OFFICE_MACHINE_RECORD";

export const miseConfigVariable = "OFFICE_MISE_CONFIG_DIR";

/** The machine record: `$OFFICE_MACHINE_RECORD`, else `$XDG_DATA_HOME/office/machine.json`. */
export function machineRecordPath(): string {
  return process.env[machineRecordVariable] || join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "office/machine.json");
}

/** mise's global config folder: `$OFFICE_MISE_CONFIG_DIR`, else as mise finds it, `$MISE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/mise`, else `~/.config/mise`. */
export function miseConfigDir(): string {
  return process.env[miseConfigVariable] || process.env.MISE_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "mise");
}

/** Where the office's machine-wide files are linked: the global conf.d, which mise loads in every folder. */
export function globalConfD(): string {
  return join(miseConfigDir(), "conf.d");
}

const absolute = v.pipe(v.string(), v.check((path) => path.startsWith("/"), "must be an absolute path"));

const owned = { path: absolute, package: v.nullable(v.string()) };

const fileSchema = v.variant("kind", [
  // A symbolic link to a file in the office.
  v.strictObject({ kind: v.literal("link"), ...owned, target: absolute }),
  // A real file the office wrote, starting with its marker line.
  v.strictObject({ kind: v.literal("file"), ...owned, sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)) }),
]);

const recordSchema = v.strictObject({
  office: v.strictObject({ name: v.string(), dir: absolute }),
  /** When the user agreed to this office managing the machine. */
  consented: v.string(),
  files: v.array(fileSchema),
});

export type MachineFile = v.InferOutput<typeof fileSchema>;

export type MachineRecord = v.InferOutput<typeof recordSchema>;

/** The machine record, or undefined when no office manages this machine. */
export function readMachine(): MachineRecord | undefined {
  const path = machineRecordPath();

  if (!existsSync(path)) return undefined;

  let data;

  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new OfficeError(`${path} is not JSON (${error instanceof Error ? error.message : String(error)}); fix or delete it`);
  }

  const result = check(v.safeParse(recordSchema, data));

  if (!result.ok) throw new OfficeError(`${path} is not a machine record office can read: ${result.errors.join("; ")}; fix or delete it`);

  return result.value;
}

/** Writes the record whole, renamed into place so a reader never sees half of it. */
function writeMachine(record: MachineRecord): void {
  const path = machineRecordPath();

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.new`, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(`${path}.new`, path);
}

/**
 * Whose machine this is, for `office`: no office's yet, this office's (possibly from the folder it
 * moved from), or another office's.
 */
export type Claim = { kind: "free" } | { kind: "ours"; record: MachineRecord; movedFrom: string | undefined } | { kind: "other"; record: MachineRecord };

/** Whether `dir` holds an office named `name`. */
function officeAt(dir: string, name: string): boolean {
  try {
    return readConfig(dir).name === name;
  } catch {
    return false;
  }
}

export function claim(office: Office): Claim {
  const record = readMachine();

  if (record === undefined) return { kind: "free" };

  if (record.office.dir === office.dir) return { kind: "ours", record, movedFrom: undefined };

  // The same office in a new folder, when the old folder no longer holds it; a copy beside it is another office.
  if (record.office.name === office.name && !officeAt(record.office.dir, office.name)) return { kind: "ours", record, movedFrom: record.office.dir };

  return { kind: "other", record };
}

/** Why another office's machine refuses this one, for messages. */
export function ownedElsewhere(record: MachineRecord): string {
  return `this machine is managed by office ${record.office.name} in ${record.office.dir} (${machineRecordPath()}), and a machine has one host-mode office; switch one of them to opencode: container, or run office sync --release-machine in that one`;
}

/** The command that gives consent, for messages. */
export const consentCommand = "office setup (unattended: office setup --manage-machine)";

/** What the office will do on the machine once allowed, for the consent question. */
export function consentQuestion(office: Office): string {
  return `Office ${office.name} runs OpenCode on this machine (host mode), so it manages the machine: it links its machine.toml and each package's tools in .office/mise/ into ${globalConfD()} as office-${office.name}-…toml, so its tools apply in every folder (without the links they apply nowhere), and lists each file it writes in ${machineRecordPath()}. It changes no file it didn't write; office sync --release-machine removes them all. Allow it? [yes/no]`;
}

/**
 * Records the user's yes: this office now manages the machine. Refuses when another office does;
 * a moved office keeps its entries, which the next sync relinks.
 */
export function grantConsent(office: Office): string {
  const current = claim(office);

  if (current.kind === "other") throw new OfficeError(ownedElsewhere(current.record));

  if (current.kind === "ours") return `Machine: office ${office.name} already manages this machine (${machineRecordPath()})`;

  writeMachine({ office: { name: office.name, dir: office.dir }, consented: new Date().toISOString(), files: [] });

  return `Machine: office ${office.name} now manages this machine; office sync links its tools into ${globalConfD()} and records them in ${machineRecordPath()}`;
}

/** A link's name in the global conf.d. Package fragments come first and machine.toml last, so it wins over them (mise loads conf.d by name, the last winning). */
export function linkName(office: Office, file: string): string {
  return file === join(office.dir, machineFile) ? `office-${office.name}-2-machine.toml` : `office-${office.name}-1-${basename(file, ".toml")}.toml`;
}

/** The links the office wants: one per machine-wide file, machine.toml and each package's fragment. */
function wantedLinks(office: Office): Extract<MachineFile, { kind: "link" }>[] {
  return machineFiles(office).map((target) => ({ kind: "link", path: join(globalConfD(), linkName(office, target)), package: fragmentOwner(target) ?? null, target }));
}

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

  return stats.isFile() && createHash("sha256").update(readFileSync(file.path)).digest("hex") === file.sha256 ? "present" : "changed";
}

/** Whether anything, a dangling link included, is at `path`. */
function occupied(path: string): boolean {
  try {
    lstatSync(path);

    return true;
  } catch {
    return false;
  }
}

/** Whether a recorded file is gone, and what to say about it. */
type Removal = { removed: boolean; line: string | undefined };

/** Removes a recorded file that is still as the office wrote it. A changed one stays, reported. */
function removeFile(file: MachineFile, why: string): Removal {
  const state = fileState(file);

  if (state === "missing") return { removed: true, line: undefined };

  if (state === "changed") return { removed: false, line: `FAILED to remove ${file.path}: it changed since office wrote it, so it stays; delete it yourself` };

  unlinkSync(file.path);

  return { removed: true, line: `removed ${file.path}, ${why}` };
}

/** What a file is, for messages. */
function owner(file: MachineFile): string {
  return file.package === null ? "the office's own" : `package ${file.package}`;
}

/** Why sync removes a recorded file the office no longer wants, for messages. */
function removalReason(file: MachineFile): string {
  return file.package === null ? `as ${machineFile} is gone` : `as ${owner(file)} no longer has a fragment`;
}

/** Removes every file the record lists and the record itself, ending this office's management of the machine. */
function release(record: MachineRecord, why: string): string[] {
  const lines: string[] = [];
  const kept: MachineFile[] = [];

  for (const file of record.files) {
    const result = removeFile(file, why);

    if (result.line !== undefined) lines.push(result.line);

    if (!result.removed) kept.push(file);
  }

  if (kept.length > 0) {
    writeMachine({ ...record, files: kept });

    return [...lines, `FAILED to release this machine: ${machineRecordPath()} still lists what couldn't be removed; deal with it, then run office sync --release-machine again`];
  }

  rmSync(machineRecordPath(), { force: true });

  return [...lines, `office ${record.office.name} no longer manages this machine: deleted ${machineRecordPath()}; office setup asks again before it writes there`];
}

/** `office sync --release-machine`: removes everything this office wrote on the machine and its consent. */
export function releaseMachine(office: Office): string[] {
  const current = claim(office);

  if (current.kind === "free") return [`office ${office.name} doesn't manage this machine; nothing to remove`];

  if (current.kind === "other") return [`FAILED: ${ownedElsewhere(current.record)}`];

  return release(current.record, "as office sync --release-machine asked");
}

/** What to say about a wanted link, and what the record lists at its path afterwards. */
type Placement = { line: string | undefined; file: MachineFile | undefined };

/** Makes one wanted link: created, relinked from what the record says it was, or refused. */
function placeLink(office: Office, wanted: Extract<MachineFile, { kind: "link" }>, recorded: MachineFile | undefined): Placement {
  const what = `${relative(office.dir, wanted.target)} (${owner(wanted)})`;

  if (recorded === undefined) {
    if (occupied(wanted.path)) return { line: `FAILED to link ${what}: ${wanted.path} exists and ${machineRecordPath()} doesn't list it, so office leaves it; move it away and run office sync`, file: undefined };

    symlinkSync(wanted.target, wanted.path);

    return { line: `linked ${wanted.path} to ${what}, so its tools apply in every folder on this machine`, file: wanted };
  }

  const state = fileState(recorded);

  if (state === "changed") return { line: `FAILED to link ${what}: ${wanted.path} changed since office wrote it, so office leaves it; delete it and run office sync`, file: recorded };

  if (state === "present" && recorded.kind === "link" && recorded.target === wanted.target) return { line: undefined, file: wanted };

  if (state !== "missing") unlinkSync(wanted.path);

  symlinkSync(wanted.target, wanted.path);

  return { line: `${state === "missing" ? "restored" : "relinked"} ${wanted.path} to ${what}`, file: wanted };
}

/**
 * `office sync`'s part on the machine. In host mode, with consent, it makes the global conf.d hold
 * a link to each of the office's machine-wide files, removes links whose file is gone, and repairs links
 * of an office that moved; in container mode it removes everything the office wrote and the record.
 * Returns one line per change; a refusal starts with FAILED.
 */
export function syncMachine(office: Office): string[] {
  const current = claim(office);

  if (office.opencode.mode !== "host") return current.kind === "ours" ? release(current.record, "as the office now runs OpenCode in its container") : [];

  if (current.kind === "other") return [`FAILED to link this office's tools on the machine: ${ownedElsewhere(current.record)}`];

  const wanted = wantedLinks(office);

  if (current.kind === "free") return wanted.length === 0 ? [] : [`not linking machine.toml and .office/mise/ into ${globalConfD()} yet, so the office's tools apply nowhere: office writes outside its folder only once you agree; run ${consentCommand}`];

  const { record, movedFrom } = current;
  const lines = movedFrom === undefined ? [] : [`office ${office.name} moved from ${movedFrom}; ${machineRecordPath()} now names ${office.dir}`];
  const files: MachineFile[] = [];

  for (const file of record.files) {
    if (wanted.some((link) => link.path === file.path)) continue;

    const result = removeFile(file, removalReason(file));

    if (result.line !== undefined) lines.push(result.line);

    if (!result.removed) files.push(file);
  }

  mkdirSync(globalConfD(), { recursive: true });

  for (const link of wanted) {
    const result = placeLink(office, link, record.files.find((file) => file.path === link.path));

    if (result.line !== undefined) lines.push(result.line);

    if (result.file !== undefined) files.push(result.file);
  }

  const next: MachineRecord = { ...record, office: { name: office.name, dir: office.dir }, files };

  if (JSON.stringify(next) !== JSON.stringify(record)) writeMachine(next);

  return lines;
}

/** One line of `office check` about the machine. */
export type MachineLine = { ok: boolean | "warn"; name: string; detail: string };

/** What `office check` says of the machine: who manages it, and each file the office wrote or wants there. */
export function machineReport(office: Office): MachineLine[] {
  const current = claim(office);
  const lines: MachineLine[] = [];

  if (process.env.MISE_GLOBAL_CONFIG_FILE) {
    lines.push({ ok: "warn", name: "machine", detail: `MISE_GLOBAL_CONFIG_FILE is set here, which makes mise ignore its global conf.d and so the office's linked tools; unset it` });
  }

  if (office.opencode.mode !== "host") {
    if (current.kind === "ours") lines.push({ ok: false, name: "machine", detail: `${machineRecordPath()} still names this container-mode office; office sync removes its files and the record` });

    return lines;
  }

  if (current.kind === "other") return [...lines, { ok: false, name: "machine", detail: ownedElsewhere(current.record) }];

  const wanted = wantedLinks(office);

  if (current.kind === "free") {
    if (wanted.length === 0) return [...lines, { ok: "warn", name: "machine", detail: "no consent for this office to manage this machine, and nothing to write outside the office yet" }];

    // mise loads machine.toml and .office/mise/ only through the links, so without them a host-mode office has none of its tools.
    return [...lines, { ok: false, name: "machine", detail: `no consent for this office to manage this machine, so machine.toml and the packages' tools in .office/mise/ apply nowhere; run ${consentCommand}, then office sync` }];
  }

  const { record, movedFrom } = current;

  lines.push(
    movedFrom === undefined
      ? { ok: true, name: "machine", detail: `managed by this office since ${record.consented}, recorded in ${machineRecordPath()}` }
      : { ok: false, name: "machine", detail: `the record names ${movedFrom}, where this office was; office sync moves it here and relinks its tools` },
  );

  for (const file of record.files) {
    const state = fileState(file);
    const target = file.kind === "link" ? ` to ${file.target}` : "";
    const want = wanted.find((link) => link.path === file.path);
    const retarget = want !== undefined && file.kind === "link" && want.target !== file.target;
    const repair = want === undefined ? "removes it" : retarget ? `relinks it to ${want.target}` : "restores it";

    const details: Record<FileState, string> = {
      present: want === undefined || retarget ? `links${target}, which the office no longer wants; office sync ${repair}` : `${file.kind === "link" ? "links" : "written"}${target} (${owner(file)})`,
      changed: `changed since office wrote it${target}; office leaves it: delete it, then office sync`,
      missing: `missing; office sync ${want === undefined ? "drops it from the record" : repair}`,
      dangling: `dangling: ${file.kind === "link" ? file.target : file.path} is gone, so mise skips it silently; office sync ${repair}`,
    };

    lines.push({ ok: state === "present" && want !== undefined && !retarget, name: `machine ${file.path}`, detail: details[state] });
  }

  for (const link of wanted) {
    if (record.files.some((file) => file.path === link.path)) continue;

    lines.push({ ok: false, name: `machine ${link.path}`, detail: occupied(link.path) ? `exists but isn't in the record, so office sync won't link ${relative(office.dir, link.target)} there; move it away` : `not linked yet; office sync links ${relative(office.dir, link.target)}` });
  }

  return lines;
}
