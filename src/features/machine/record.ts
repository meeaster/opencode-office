import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync } from "node:fs";
import * as v from "valibot";

import { atomicWrite } from "../../lib/atomic-write.ts";
import { sha256 } from "../../lib/hash.ts";
import { type Office, OfficeError, readConfig } from "../../office.ts";
import { check } from "../../parse.ts";
import { hostVariable } from "../../loader/sources/manifest-schema.ts";
import { envFilePath, machineRecordPath } from "./paths.ts";

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

export type LinkFile = Extract<MachineFile, { kind: "link" }>;

export type RealFile = Extract<MachineFile, { kind: "file" }>;

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
export function writeMachine(record: MachineRecord): void {
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


/**
 * Records the user's yes: this office now manages the machine. Refuses when another office does;
 * a moved office keeps its entries, which the next sync relinks.
 */
export function grantConsent(office: Office, grantedMessage: string): string {
  const current = claim(office);

  if (current.kind === "other") throw new OfficeError(ownedElsewhere(current.record));

  if (current.kind === "ours") return `office ${office.name} already manages this machine (${machineRecordPath()})`;

  writeMachine({ office: { name: office.name, dir: office.dir }, consented: new Date().toISOString(), files: [] });

  return grantedMessage;
}

/** Replaces the previous receipt (all entries at this path when no receipt was selected), appending the new one. */
export function replaceReceipt(record: MachineRecord, file: MachineFile, previous?: MachineFile): void {
  const files = record.files.filter((entry) => previous === undefined ? entry.path !== file.path : entry !== previous);

  writeMachine({ ...record, files: [...files, file] });
}

/** Removes one receipt from this snapshot and returns the snapshot for the next removal. */
export function removeReceipt(record: MachineRecord, file: MachineFile): MachineRecord {
  const next = { ...record, files: record.files.filter((entry) => entry !== file) };

  writeMachine(next);

  return next;
}
