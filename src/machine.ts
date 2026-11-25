// What a host-mode office writes on its machine, outside its folder and its state: a link in mise's
// global conf.d to each of the office's machine-wide mise files, its `machine.toml`, the packages'
// tools in `machine.packages.toml` and their setup in `.office/mise/`, which mise loads nowhere else,
// so the office's tools apply in every folder; and, in the office tool's data folder
// (src/host-env.ts), the environment file agents and the user's terminal share, Socket Firewall's
// wrappers and sfw itself. The rules, for every such file:
//
// - Whole files only, each named `office-<office name>-…` in a folder others share (a real file also
//   starts with a marker line; sfw, a program, can't, and its record holds its release's SHA-256).
//   The office never edits a file it didn't write, and never replaces a path the machine record
//   doesn't list: it reports it instead.
// - The machine record, `$XDG_DATA_HOME/office/machine.json`, lists each file with its kind, the
//   package it belongs to and what it points at or its hash, and names the one office that manages
//   the machine. A second host-mode office, in another folder, is refused; the same office (by
//   name) that moved folders takes its entries along and relinks them.
// - The record exists only once the user said yes: `office setup` asks (or takes
//   `--manage-machine`) and writes it. Until then `office sync` writes nothing here and says what to
//   run.
// - `office sync` removes a file when its fragment goes or Socket Firewall turns off, and everything
//   (with the record) when the office leaves host mode or `office sync --release-machine` asks;
//   `office down` leaves them. `office sync` writes the generated files; `office up` installs sfw at
//   the version it applies, as it applies the office's other pins.
//
// OFFICE_MACHINE_RECORD replaces the record's path, and OFFICE_MISE_CONFIG_DIR the mise config
// folder whose conf.d gets the links, and OFFICE_MACHINE_DIR the office tool's data folder, so
// tests and scratch offices never touch the real ones. A scratch office that runs mise sets
// MISE_CONFIG_DIR to the same folder, so mise reads the links.
import { changeText, failure, isFailure, type Change } from "./change.ts";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";

import * as v from "valibot";

import { fetchBytes } from "./download.ts";
import { envFilePath, hostEnvironment, hostLayout, hostWrappers, realMise } from "./host-env.ts";
import { type ServerPlan, serverUnit, serverUnitPath, userSystemd } from "./host-server.ts";
import type { GatheredPackage } from "./gather.ts";
import { type Office, OfficeError, readConfig } from "./office.ts";
import { fragmentOwner, machineFile, machineFiles, ownerProjection, packagesFile } from "./package-tools.ts";
import { heldKeys } from "../standard/tools/admission.ts";
import { platformAsset } from "./releases.ts";
import { check, hostVariable, type Lock } from "./schema.ts";
import { atomicWrite } from "./secrets.ts";
import { envScript, wrapperFiles } from "./sfw.ts";
import { defaultPins, hostPlatform, readApplied, wantedPins } from "./versions.ts";
import { say } from "./report/index.ts";

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
  v.strictObject({ kind: v.literal("file"), ...owned, sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)), service: v.optional(v.literal("opencode")), program: v.optional(absolute),
    contributions: v.optional(v.array(v.object({ name: v.string(), path: v.array(absolute), variables: v.array(v.tuple([hostVariable, v.string()])) }))),
  }),
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

  return parseRecord(readFileSync(path, "utf8"), path);
}

function parseRecord(text: string, path: string): MachineRecord {
  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new OfficeError(`${path} is not JSON; fix or delete it`);
  }

  const result = check(v.safeParse(recordSchema, data));

  if (!result.ok) throw new OfficeError(`${path} is not a machine record office can read: ${result.errors.join("; ")}; fix or delete it`);

  return result.value;
}

// These bytes authorize a shell at unit startup. Check the open file, not a prior stat
// of its pathname. O_NONBLOCK lets us refuse a FIFO without hanging the unit.
function readLaunchFile(path: string): Buffer | undefined {
  let fd: number;

  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;

    throw new OfficeError(`cannot open ${path} as a regular host service file (symlinks are not followed); check ownership and permissions`);
  }

  try {
    const stat = fstatSync(fd);

    if (!stat.isFile() || stat.uid !== process.geteuid?.() || !(stat.mode & 0o400) || (stat.mode & 0o022)) {
      throw new OfficeError(`unsafe host service file ${path}: expected a user-owned readable regular file without group or other write permission`);
    }

    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Compare the installed identity, even after a rename or release. Never discover an office here. */
export function serviceEnvironment(office: MachineRecord["office"]): string {
  const recordPath = machineRecordPath();
  const text = readLaunchFile(recordPath);

  if (!text) return "";
  const record = parseRecord(text.toString("utf8"), recordPath);

  if (record.office.dir !== office.dir || record.office.name !== office.name) return "";
  const path = envFilePath();
  const matches = record.files.filter(entry => entry.path === path);
  const [file] = matches;

  if (matches.length === 1 && file?.kind === "file" && file.package === null && file.service === undefined) {
    const bytes = readLaunchFile(path);

    if (bytes && sha256(bytes) === file.sha256) return bytes.toString("utf8");
  }

  throw new OfficeError(`the claimed host environment ${path} is missing, changed or unrecorded; check machine ownership and run office sync`);
}

/** This record authorizes host launches; don't make it group-writable even under umask 002. */
function writeMachine(record: MachineRecord): void {
  atomicWrite(machineRecordPath(), `${JSON.stringify(record, null, 2)}\n`);
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
  const firewall = office.socketFirewall ? `, Socket Firewall (sfw) and its wrappers for npm, pnpm, pip, uv, cargo and mise in ${hostLayout("").root}` : "";
  const server = office.opencode.managed === undefined ? "" : ` It also enables ${serverUnit(office)} for OpenCode.`;

  return `Office ${office.name} runs OpenCode on this machine (host mode), so it manages the machine: it links its machine.toml, the packages' tools in machine.packages.toml and their setup in .office/mise/ into ${globalConfD()} as office-${office.name}-…toml, so its tools apply in every folder (without the links they apply nowhere), and writes ${envFilePath()}, the environment your shell and agents share${firewall}.${server} It lists each file it writes in ${machineRecordPath()}, changes no file it didn't write, and never edits your shell's startup files; office sync --release-machine removes them all. Allow it? [yes/no]`;
}

/**
 * Records the user's yes: this office now manages the machine. Refuses when another office does;
 * a moved office keeps its entries, which the next sync relinks.
 */
export function grantConsent(office: Office): string {
  const current = claim(office);

  if (current.kind === "other") throw new OfficeError(ownedElsewhere(current.record));

  if (current.kind === "ours") return `office ${office.name} already manages this machine (${machineRecordPath()})`;

  writeMachine({ office: { name: office.name, dir: office.dir }, consented: new Date().toISOString(), files: [] });

  return `office ${office.name} now manages this machine; office sync links its tools into ${globalConfD()} and records them in ${machineRecordPath()}`;
}

/**
 * A link's name in the global conf.d, where mise loads files by name and the last wins:
 * machine.packages.toml first (the packages' tools), then each package's fragment (its setup), then
 * machine.toml, so the owner's choices win over the packages' versions. The container's entrypoint
 * names them the same way.
 */
export function linkName(office: Office, file: string): string {
  if (file === join(office.dir, machineFile)) return `office-${office.name}-2-machine.toml`;

  if (file === join(office.dir, packagesFile)) return `office-${office.name}-0-packages.toml`;

  return `office-${office.name}-1-${basename(file, ".toml")}.toml`;
}

type LinkFile = Extract<MachineFile, { kind: "link" }>;

type RealFile = Extract<MachineFile, { kind: "file" }>;

/**
 * A file the office wants on the machine, with what to call it in messages and what to add when it
 * is made: a link, a file sync writes (`text`), or sfw, which `office up` installs (no text).
 */
type Wanted = { file: LinkFile; what: string; made: string } | { file: RealFile; what: string; made: string; text: string | undefined };

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** The links the office wants in the global conf.d: one per machine-wide file, machine.packages.toml, each package's fragment and machine.toml. */
function wantedLinks(office: Office): Wanted[] {
  return machineFiles(office).map((target) => {
    const file: LinkFile = { kind: "link", path: join(globalConfD(), linkName(office, target)), package: fragmentOwner(target) ?? null, target };
    const packages = target === join(office.dir, packagesFile);

    return { file, what: `${relative(office.dir, target)} (${packages ? "the packages' tools" : owner(file)})`, made: packages || file.package === null ? ", so its tools apply in every folder on this machine" : ", so its setup applies in every folder on this machine" };
  });
}

/**
 * machine.toml's entry: its link, or, while it holds shared tools the packages require, a file
 * of it without them (ownerProjection), so mise's global config activates none of their desired
 * versions; only office's applied tools run them.
 */
function ownerFile(office: Office, entry: Wanted, packages: readonly GatheredPackage[]): Wanted {
  if (entry.file.kind !== "link" || entry.file.target !== join(office.dir, machineFile)) return entry;
  const held = heldKeys(office, packages);

  if (held.size === 0) return entry;
  const text = ownerProjection(readFileSync(entry.file.target, "utf8"), held);

  return { file: { kind: "file", path: entry.file.path, package: null, sha256: sha256(text) }, what: `${machineFile} without the shared tools office installs (${[...held].join(", ")})`, made: ", so its other tools apply in every folder on this machine", text };
}

/** The sfw pin `office up` runs: the one it last applied, else office.yaml's, else the tool's default. */
function appliedSfw(office: Office): Lock["sfw"] {
  const applied = readApplied(office)?.pins.sfw;

  if (applied !== undefined) return applied;

  try {
    return wantedPins(office).sfw;
  } catch {
    return defaultPins.sfw;
  }
}

/** The SHA-256 of a pin's release file for this machine, in hex, or undefined where office installs no sfw. */
function sfwDigest(pin: Lock["sfw"]): string | undefined {
  const platform = hostPlatform();

  return platform === undefined ? undefined : pin.platforms?.[platform]?.replace(/^sha256:/, "");
}

/**
 * Everything the office wants on the machine in host mode: the links, the environment file, and
 * while Socket Firewall is on, the wrappers (the mise wrapper only where a real mise is found)
 * and sfw. Problems in what packages declare come back as lines.
 */
/** What the office wants on the machine, and the problems that kept something out. */
type WantedFiles = { wanted: Wanted[]; problems: string[] };

/** The packages a run gathered, with the selected ones it couldn't read (src/gather.ts). */
export type MachinePackages = { unread: ReadonlySet<string>; packages: GatheredPackage[] };

function wantedFiles(office: Office, record: MachineRecord, packages: MachinePackages): WantedFiles {
  const previous = record.files.find(file => file.path === envFilePath());
  const retained = previous?.kind === "file" ? previous.contributions?.filter(item => packages.unread.has(item.name)) : [];
  const { environment, problems, contributions } = hostEnvironment(office, packages.packages, retained);
  const envText = envScript(`the environment of office ${office.name}, which agents and your terminal share`, envFilePath(), environment);
  const links = wantedLinks(office).filter(({ file }) => file.package === null || !packages.unread.has(file.package) || record.files.some(prior => prior.path === file.path && same(prior, file) && fileState(prior) === "present")).map(entry => ownerFile(office, entry, packages.packages));
  const wanted: Wanted[] = [...links, { file: { kind: "file", path: envFilePath(), package: null, sha256: sha256(envText), contributions }, what: "the office's environment file", made: "; source it from your shell's startup file (office setup prints the line)", text: envText }];

  if (!office.socketFirewall) return { wanted, problems };

  const mise = realMise();
  const files = wrapperFiles(hostLayout(mise ?? ""));
  const digest = sfwDigest(appliedSfw(office));

  wanted.push({ file: { kind: "file", path: files.script.path, package: null, sha256: sha256(files.script.text) }, what: "the Socket Firewall wrapper script", made: "", text: files.script.text });

  for (const link of files.links) wanted.push({ file: { kind: "link", path: link.path, package: null, target: link.target }, what: `the Socket Firewall wrapper for ${basename(link.path)}`, made: "" });

  if (mise !== undefined) wanted.push({ file: { kind: "file", path: files.mise.path, package: null, sha256: sha256(files.mise.text) }, what: `the mise wrapper, which runs ${mise}'s installs through Socket Firewall`, made: "", text: files.mise.text });
  else problems.push(`no mise program found on PATH or in office's host-tools, so ${files.mise.path} isn't written and mise installs don't go through Socket Firewall; install mise (office setup --install-deps) and run office sync`);

  if (digest !== undefined) wanted.push({ file: { kind: "file", path: hostLayout("").sfw, package: null, sha256: digest }, what: "Socket Firewall", made: "", text: undefined });

  return { wanted, problems };
}

/** Whether a wanted file is sfw, which `office up` installs rather than sync. */
function isSfw(file: MachineFile): boolean {
  return file.path === hostLayout("").sfw;
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
type Removal = { removed: boolean; line: Change | undefined };

/** Removes a recorded file that is still as the office wrote it. A changed one stays, reported. */
function removeFile(file: MachineFile, why: string): Removal {
  const state = fileState(file);

  if (state === "changed") return { removed: false, line: failure(`FAILED to remove ${file.path}: it changed since office wrote it, so it stays; delete it yourself`) };

  if (file.kind === "file" && file.service === "opencode") {
    try {
      stopServerFile(file, true);

      if (state !== "missing") unlinkSync(file.path);
      userSystemd(["daemon-reload"]);

      return { removed: true, line: `removed ${file.path}, ${why}` };
    } catch (error) {
      return { removed: false, line: failure(`FAILED to remove ${file.path}: ${error instanceof Error ? error.message : String(error)}`) };
    }
  }

  if (state === "missing") return { removed: true, line: undefined };

  unlinkSync(file.path);

  return { removed: true, line: `removed ${file.path}, ${why}` };
}

/** What a file is, for messages. */
function owner(file: MachineFile): string {
  return file.package === null ? "the office's own" : `package ${file.package}`;
}

/** Why sync removes a recorded file the office no longer wants, for messages. */
function removalReason(office: Office, file: MachineFile): string {
  if (file.kind === "file" && file.service === "opencode") return "as office no longer manages this OpenCode unit";

  if (file.package !== null) return `as ${owner(file)} no longer has a fragment`;

  if (file.kind === "link" && file.target === join(office.dir, packagesFile)) return `as ${packagesFile} is gone`;

  if (file.path.startsWith(`${hostLayout("").root}/`)) return office.socketFirewall ? "as office no longer writes it" : "as office.yaml turns Socket Firewall off";

  return `as ${machineFile} is gone`;
}

/** Removes the sfw folders when removing their files left them empty. */
function removeEmptyFolders(): void {
  for (const folder of [hostWrappers(), hostLayout("").root]) {
    if (existsSync(folder) && readdirSync(folder).length === 0) rmdirSync(folder);
  }
}

/** Removes every file the record lists and the record itself, ending this office's management of the machine. */
function release(record: MachineRecord, why: string): Change[] {
  const lines: Change[] = [];
  const kept: MachineFile[] = [];

  for (const file of record.files) {
    const result = removeFile(file, why);

    if (result.line !== undefined) lines.push(result.line);

    if (!result.removed) kept.push(file);
  }

  removeEmptyFolders();

  if (kept.length > 0) {
    writeMachine({ ...record, files: kept });

    return [...lines, failure(`FAILED to release this machine: ${machineRecordPath()} still lists what couldn't be removed; deal with it, then run office sync --release-machine again`)];
  }

  rmSync(machineRecordPath(), { force: true });

  return [...lines, `office ${record.office.name} no longer manages this machine: deleted ${machineRecordPath()}; office setup asks again before it writes there`];
}

/** `office sync --release-machine`: removes everything this office wrote on the machine and its consent. */
export function releaseMachine(office: Office): Change[] {
  const current = claim(office);

  if (current.kind === "free") return [`office ${office.name} doesn't manage this machine; nothing to remove`];

  if (current.kind === "other") return [failure(`FAILED: ${ownedElsewhere(current.record)}`)];

  return release(current.record, "as office sync --release-machine asked");
}

/** What to say about a wanted link, and what the record lists at its path afterwards. */
type Placement = { line: Change | undefined; file: MachineFile | undefined };

/** Writes or links one wanted file in place, its folder made first. */
function make(wanted: Wanted): void {
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

/**
 * Makes one wanted file: created, rewritten or relinked from what the record says it was, or
 * refused. sfw is only kept as recorded: `office up` installs it.
 */
function place(wanted: Wanted, recorded: MachineFile | undefined): Placement {
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

function managedFile(file: MachineFile): file is RealFile & { service: "opencode" } {
  return file.kind === "file" && file.service === "opencode";
}

function stopServerFile(file: RealFile, remove: boolean): void {
  const unit = basename(file.path);
  const fragment = userSystemd(["show", "--property=FragmentPath", "--value", unit]);

  if (fileState(file) === "changed") throw new OfficeError(`${file.path} changed since office wrote it; office leaves it alone`);

  if (fragment !== "" && fragment !== file.path) throw new OfficeError(`${unit} is loaded from ${fragment}, not the office's file`);

  if (fragment === file.path) userSystemd(["stop", unit]);

  if (remove && (fragment === file.path || existsSync(file.path))) userSystemd(["disable", unit]);
}

export function requireServerConsent(office: Office): MachineRecord {
  const current = claim(office);

  if (current.kind === "other") throw new OfficeError(ownedElsewhere(current.record));

  if (current.kind === "free") throw new OfficeError(`managed OpenCode requires consent to manage the machine; run ${consentCommand}`);

  return current.record;
}

export function matchesServerUnit(office: Office, plan: ServerPlan): boolean {
  const current = claim(office);
  const file = current.kind === "ours" ? current.record.files.find((entry) => managedFile(entry) && entry.path === plan.path) : undefined;

  return file?.kind === "file" && file.sha256 === sha256(plan.text) && fileState(file) === "present";
}

/** The recorded launch paths, unchanged on disk. The updater does not plan or rewrite the unit. */
export function recordedAgentUpdate(office: Office) {
  const { files } = requireServerConsent(office);
  const server = files.find((file) => managedFile(file) && file.path === serverUnitPath(office));
  const env = files.find((file) => file.path === envFilePath() && file.kind === "file");
  const sfw = files.find((file) => file.path === hostLayout("").sfw && file.kind === "file");

  if (server?.kind !== "file" || server.program === undefined || fileState(server) !== "present") throw new OfficeError("the managed OpenCode unit needs to match the machine record; run office up first");

  if (env === undefined || fileState(env) !== "present") throw new OfficeError("the host environment needs to match the machine record; run office sync first");

  let screened: string | undefined;

  try {
    if (office.socketFirewall && sfw !== undefined && fileState(sfw) === "present") screened = sfw.path;
  } catch {
    // Clause applies to OpenCode only; an unreadable firewall must not prevent Claude's update.
  }

  return { program: server.program, env: env.path, sfw: screened };
}

export function writeServerUnit(office: Office, plan: ServerPlan): boolean {
  const record = requireServerConsent(office);
  const env = record.files.find((file) => file.path === envFilePath());

  if (env === undefined || fileState(env) !== "present") throw new OfficeError(`managed OpenCode needs the recorded environment file at ${envFilePath()}; run office sync`);

  const file: RealFile = { kind: "file", path: plan.path, package: null, service: "opencode", program: plan.program, sha256: sha256(plan.text) };
  const previous = record.files.find((entry) => entry.path === file.path);

  if (previous === undefined) {
    if (occupied(file.path)) throw new OfficeError(`${file.path} exists but is not in the machine record; office leaves it alone`);
  } else {
    if (!managedFile(previous)) throw new OfficeError(`${file.path} isn't recorded as the managed OpenCode service`);

    const state = fileState(previous);

    if (state === "changed") throw new OfficeError(`${file.path} changed since office wrote it; office leaves it alone`);

    if (state === "present" && same(previous, file) && previous.program === file.program) return false;
  }

  atomicWrite(file.path, plan.text, 0o644);
  writeMachine({ ...record, files: [...record.files.filter((entry) => entry !== previous), file] });
  say(`${previous === undefined ? "wrote" : "updated"} ${file.path}`, "office: ");

  return true;
}

export function stopRecordedServer(office: Office): void {
  const current = claim(office);

  if (current.kind !== "ours") return;

  for (const file of current.record.files) {
    if (managedFile(file)) stopServerFile(file, false);
  }
}

/** `up` reconciles an installed server even when the option has just been removed. */
export function removeUnwantedServer(office: Office): void {
  const current = claim(office);

  if (current.kind !== "ours") return;

  let files = current.record.files;

  for (const file of current.record.files) {
    if (!managedFile(file) || (office.opencode.managed !== undefined && file.path === serverUnitPath(office))) continue;

    const result = removeFile(file, removalReason(office, file));

    if (!result.removed) throw new OfficeError(result.line === undefined ? undefined : changeText(result.line));

    files = files.filter((entry) => entry !== file);
    writeMachine({ ...current.record, files });

    if (result.line !== undefined) say(changeText(result.line));
  }
}

/**
 * `office sync`'s part on the machine. In host mode, with consent, it makes the global conf.d hold
 * a link to each of the office's machine-wide files, removes links whose file is gone, and repairs links
 * of an office that moved; in container mode it removes everything the office wrote and the record.
 * Returns one line per change; a refusal starts with FAILED.
 */
export function syncMachine(office: Office, packages?: MachinePackages): Change[] {
  const current = claim(office);

  if (office.opencode.mode !== "host") return current.kind === "ours" ? release(current.record, "as the office now runs OpenCode in its container") : [];

  if (current.kind === "other") return [failure(`FAILED to link this office's tools on the machine: ${ownedElsewhere(current.record)}`)];

  if (current.kind === "free") {
    const firewall = office.socketFirewall ? ", and package downloads don't go through Socket Firewall" : "";

    return [`not linking machine.toml, machine.packages.toml and .office/mise/ into ${globalConfD()} or writing ${envFilePath()} yet, so the office's tools apply nowhere${firewall}: office writes outside its folder only once you agree; run ${consentCommand}`];
  }

  if (packages === undefined) throw new Error("linking a host office's machine files needs its gathered packages");
  const { record, movedFrom } = current;
  const { wanted, problems } = wantedFiles(office, record, packages);
  const lines = [...(movedFrom === undefined ? [] : [`office ${office.name} moved from ${movedFrom}; ${machineRecordPath()} now names ${office.dir}`]), ...problems.map((problem) => failure(`FAILED ${problem}`))];
  const files: MachineFile[] = [];

  for (const file of record.files) {
    if (managedFile(file) && office.opencode.managed !== undefined && file.path === serverUnitPath(office)) {
      files.push(file);

      continue;
    }

    if (wanted.some((entry) => entry.file.path === file.path)) continue;

    const result = removeFile(file, removalReason(office, file));

    if (result.line !== undefined) lines.push(result.line);

    if (!result.removed) files.push(file);
  }

  removeEmptyFolders();
  mkdirSync(globalConfD(), { recursive: true });

  for (const entry of wanted) {
    const result = place(entry, record.files.find((file) => file.path === entry.file.path));

    if (result.line !== undefined) lines.push(result.line);

    if (result.file !== undefined) files.push(result.file);
  }

  if (office.socketFirewall && lines.some((line) => !isFailure(line) && line.startsWith(`wrote ${hostLayout("").script}`)) && !files.some(isSfw)) {
    lines.push(`Socket Firewall itself isn't installed yet, so the wrappers refuse to run downloads: office up installs sfw ${appliedSfw(office).version}`);
  }

  const next: MachineRecord = { ...record, office: { name: office.name, dir: office.dir }, files };

  if (JSON.stringify(next) !== JSON.stringify(record)) writeMachine(next);

  return lines;
}

/** One line of `office check` about the machine. */
export type MachineLine = { ok: boolean | "warn"; name: string; detail: string };

/**
 * What `office check` says of the machine: who manages it, and each file the office wrote or wants
 * there. Without `packages` (the gathering was incomplete), what packages want isn't compared; each
 * recorded file is still checked against the record.
 */
export function machineReport(office: Office, packages?: MachinePackages): MachineLine[] {
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

  if (current.kind === "free") {
    // mise loads machine.toml, machine.packages.toml and .office/mise/ only through the links, so without them a host-mode office has none of its tools.
    return [...lines, { ok: false, name: "machine", detail: `no consent for this office to manage this machine, so machine.toml and the packages' tools in machine.packages.toml apply nowhere and ${envFilePath()} isn't written; run ${consentCommand}, then office sync` }];
  }

  const { record, movedFrom } = current;

  lines.push(
    movedFrom === undefined
      ? { ok: true, name: "machine", detail: `managed by this office since ${record.consented}, recorded in ${machineRecordPath()}` }
      : { ok: false, name: "machine", detail: `the record names ${movedFrom}, where this office was; office sync moves it here and relinks its tools` },
  );

  // Without every package's claims, each recorded file is checked against the record alone (sfw
  // against office.lock): nothing says which files the office wants now.
  if (packages === undefined) {
    for (const file of record.files) {
      if (managedFile(file) && office.opencode.managed !== undefined && file.path === serverUnitPath(office)) continue;

      lines.push(isSfw(file) && office.socketFirewall ? sfwLine(office, file) : recordedLine(file));
    }

    return lines;
  }

  const { wanted, problems } = wantedFiles(office, record, packages);

  lines.push(...problems.map((problem) => ({ ok: false, name: "machine", detail: problem })));

  for (const file of record.files) {
    if (managedFile(file) && office.opencode.managed !== undefined && file.path === serverUnitPath(office)) continue;

    const want = wanted.find((entry) => entry.file.path === file.path);

    lines.push(isSfw(file) && want !== undefined ? sfwLine(office, file) : fileLine(file, want));
  }

  for (const entry of wanted) {
    if (record.files.some((file) => file.path === entry.file.path)) continue;

    const { file } = entry;
    const missing = isSfw(file) ? `not installed; office up installs sfw ${appliedSfw(office).version}, and until then the wrappers refuse to run downloads` : file.kind === "link" ? `not linked yet; office sync links ${entry.what}` : `not written yet; office sync writes ${entry.what}`;

    lines.push({ ok: false, name: `machine ${file.path}`, detail: occupied(file.path) ? `exists but isn't in the record, so office won't put ${entry.what} there; move it away` : missing });
  }

  return lines;
}

/** One recorded file's line: present and as wanted, changed, missing, dangling, or no longer wanted. */
function fileLine(file: MachineFile, want: Wanted | undefined): MachineLine {
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

/** sfw's line: the version installed against the one office up applied and the one office.yaml pins. */
function sfwLine(office: Office, file: MachineFile): MachineLine {
  const state = fileState(file);
  const name = `machine ${file.path}`;
  const applied = appliedSfw(office);
  const installed = file.kind === "file" && file.sha256 === sfwDigest(applied) ? applied.version : undefined;

  if (state === "changed") return { ok: false, name, detail: "changed since office installed it; office leaves it: delete it, then office up" };

  if (state !== "present") return { ok: false, name, detail: `missing, so the wrappers refuse to run downloads; office up installs sfw ${applied.version}` };

  if (installed === undefined) return { ok: false, name, detail: `Socket Firewall, but not the sfw ${applied.version} office applies; office up installs it` };

  let pending = "";

  try {
    const wanted = wantedPins(office).sfw.version;

    if (wanted !== applied.version) pending = `; office.yaml pins ${wanted}, which office up --upgrade installs`;
  } catch (error) {
    pending = `; ${error instanceof Error ? error.message : String(error)}`;
  }

  return { ok: pending === "" ? true : "warn", name, detail: `Socket Firewall ${installed}, matching office.lock's SHA-256 for this machine${pending}` };
}

/**
 * `office up`'s part on the machine in host mode: installs sfw at `pin`, checked against office.lock's
 * SHA-256 for this machine and its own `--version`, and records it. Nothing without consent, or with
 * Socket Firewall off; an installed copy at the same digest stays. Returns one line per change.
 */
export async function installSfw(office: Office, pin: Lock["sfw"], download: (url: string, what: string) => Promise<Uint8Array> = fetchBytes): Promise<string[]> {
  if (!office.socketFirewall || office.opencode.mode !== "host") return [];

  const current = claim(office);

  if (current.kind !== "ours") return [`office: Socket Firewall isn't installed: office writes outside its folder only once you agree; run ${consentCommand}, then office sync and office up`];

  const platform = hostPlatform();
  const digest = sfwDigest(pin);

  if (platform === undefined || digest === undefined) throw new OfficeError(`office installs Socket Firewall on Linux and macOS, x64 and arm64, not ${process.platform}-${process.arch}; give sfw enabled: false under tools in office.yaml`);

  const path = hostLayout("").sfw;
  const record = current.record;
  const recorded = record.files.find((file) => file.path === path);

  if (recorded !== undefined && fileState(recorded) === "present" && recorded.kind === "file" && recorded.sha256 === digest) return [];

  if (recorded === undefined ? occupied(path) : fileState(recorded) === "changed") throw new OfficeError(`${path} ${recorded === undefined ? `exists and ${machineRecordPath()} doesn't list it` : "changed since office installed it"}, so office leaves it; move it away and run office up`);

  const bytes = await download(platformAsset("sfw", pin.version, platform), `sfw ${pin.version}`);

  if (sha256(bytes) !== digest) throw new OfficeError(`sfw ${pin.version} for ${platform} doesn't match office.lock's SHA-256; nothing was installed`);

  // Written beside the final file and renamed, so the wrappers never run half a download.
  const staging = `${path}.new`;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(staging, bytes, { mode: 0o755 });

  let reported = "";

  try {
    reported = execFileSync(staging, ["--version"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    reported = "";
  }

  if (!reported.includes(`version ${pin.version}`)) {
    rmSync(staging, { force: true });

    throw new OfficeError(`the downloaded sfw doesn't report version ${pin.version}; nothing was installed`);
  }

  renameSync(staging, path);

  const file: MachineFile = { kind: "file", path, package: null, sha256: digest };

  writeMachine({ ...record, files: [...record.files.filter((entry) => entry.path !== path), file] });

  return [`office: installed Socket Firewall ${pin.version} in ${path}, checked against office.lock`];
}
