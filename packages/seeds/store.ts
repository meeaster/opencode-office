// The seeds package's files in the office, all under `.office/seeds/`, which is committed: the
// stored bytes of every seed a receipt's hash names (`<sha256>`), the receipts (`receipts.json`),
// and a `.gitattributes` that stops Git converting either. Office never deletes a stored seed: a
// merge of two branches can reuse a seed one of them dropped.
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** The seed store, office-relative. */
export const seedStore = ".office/seeds";

/** The receipts file, office-relative. */
export const receiptsFile = `${seedStore}/receipts.json`;

/** Stops Git converting the store's files at add and at checkout, so each keeps the bytes its name hashes. */
const seedAttributes = "* -text -filter -ident -working-tree-encoding\n";

/** Where the store's files are staged before their rename: excluded from commits, unlike the store. */
const staging = ".office";

/**
 * A path's receipt: the package that handled it, and either the SHA-256 of the bytes office wrote
 * (office created it) or `existing: true` (a file was already there, so the office owns it).
 */
export type Receipt = { package: string; sha256: string } | { package: string; existing: true };

/** The receipts, by office-relative path. A Map, so a path named like an Object property is kept as itself. */
export type Receipts = Map<string, Receipt>;

export function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Writes `content` to `path` whole, through a uniquely named file in `staging` and a rename. The
 * staged file gets `mode` exactly, whatever the umask.
 */
export function atomicWrite(path: string, content: string | Buffer, mode: number, stagingDir: string): void {
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(stagingDir, { recursive: true });
  const temporary = join(stagingDir, `${basename(path)}.${randomBytes(8).toString("hex")}.new`);

  try {
    writeFileSync(temporary, content, { mode, flag: "wx" });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** `path` as one shell word in a printed command: as it is when plain, single-quoted otherwise. */
function shellWord(path: string): string {
  return /^[\w./@%+=:,-]+$/.test(path) ? path : `'${path.replaceAll("'", `'\\''`)}'`;
}

/**
 * The `office seeds <verb>` command for seeded path `path`, ready to paste. A path that starts with
 * a dash comes after `--`, so the CLI passes it to the command as typed instead of reading it as an
 * option (`--help`, `--office=…`); the seeds commands drop that leading `--`.
 */
export function seedsCommand(verb: "diff" | "settle", path: string): string {
  return `office seeds ${verb} ${path.startsWith("-") ? "-- " : ""}${shellWord(path)}`;
}

/** Whether `path` is a plain office-relative path: no leading slash, `.`, `..` or empty parts, and no backslash, line break or NUL. */
export function plainPath(path: string): boolean {
  return path !== "" && !path.includes("\\") && !/[\n\r\0]/.test(path) && path.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

/** What is at `path`, not following a link; undefined when nothing is, including when a folder on the way is a file. */
function entryAt(path: string) {
  try {
    return lstatSync(path, { throwIfNoEntry: false });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOTDIR") return undefined;
    throw error;
  }
}

const packageName = /^[a-z0-9][a-z0-9-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One receipt read from the file, or why it isn't one. */
function parseReceipt(path: string, value: unknown): Receipt | string {
  if (!plainPath(path)) return `${path}: must be a path relative to the office`;

  if (!isRecord(value) || typeof value.package !== "string" || !packageName.test(value.package)) return `${path}: must be { package, sha256 } or { package, existing: true }, with a package name`;
  const keys = Object.keys(value).sort().join(",");

  if (keys === "package,sha256" && typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256)) return { package: value.package, sha256: value.sha256 };

  if (keys === "existing,package" && value.existing === true) return { package: value.package, existing: true };

  return `${path}: must be { package, sha256 } with 64 lowercase hex digits, or { package, existing: true }`;
}

/**
 * The receipts in the office at `dir`; none when the file is missing. Throws naming the file when
 * it is anything but a file, a link too, or isn't valid JSON of the right shape: it is never read
 * as empty.
 */
export function readReceipts(dir: string): Receipts {
  const file = join(dir, receiptsFile);
  const info = entryAt(file);

  if (info === undefined) return new Map();

  if (!info.isFile()) throw new Error(`${receiptsFile} is not a file (${info.isSymbolicLink() ? "a link" : "a folder or other entry"}); restore it from Git`);
  let document: unknown;

  try {
    document = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${receiptsFile} is not valid JSON: ${message(error)}; restore it from Git`);
  }

  if (!isRecord(document) || Object.keys(document).join(",") !== "receipts" || !isRecord(document.receipts)) throw new Error(`${receiptsFile} is not valid: it must be { "receipts": { "<path>": … } }; restore it from Git`);
  const receipts: Receipts = new Map();
  const problems: string[] = [];

  // JSON.parse defines every key as an own property, so `__proto__` is read as a path too.
  for (const [path, value] of Object.entries(document.receipts)) {
    const receipt = parseReceipt(path, value);

    if (typeof receipt === "string") problems.push(receipt);
    else receipts.set(path, receipt);
  }

  if (problems.length) throw new Error(`${receiptsFile} is not valid: ${problems.join("; ")}; restore it from Git`);

  return receipts;
}

/** A map's entries sorted by their path keys: the order of the receipts file and of every listing. */
export function byPath<T>(map: ReadonlyMap<string, T>): [string, T][] {
  return [...map].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

/** The receipts file's text: paths sorted, one receipt per line, so a commit's diff shows one line per changed receipt. */
export function renderReceipts(receipts: Receipts): string {
  const lines = byPath(receipts).map(([path, receipt]) => {
    const fields = "sha256" in receipt ? `"sha256": ${JSON.stringify(receipt.sha256)}` : `"existing": true`;

    return `    ${JSON.stringify(path)}: { "package": ${JSON.stringify(receipt.package)}, ${fields} }`;
  });

  return lines.length ? `{\n  "receipts": {\n${lines.join(",\n")}\n  }\n}\n` : `{\n  "receipts": {}\n}\n`;
}

/** Writes the receipts of the office at `dir`, whole by rename. */
export function writeReceipts(dir: string, receipts: Receipts): void {
  atomicWrite(join(dir, receiptsFile), renderReceipts(receipts), 0o644, join(dir, staging));
}

/** Whether two receipt maps hold the same receipts. */
export function sameReceipts(left: Receipts, right: Receipts): boolean {
  return renderReceipts(left) === renderReceipts(right);
}

/**
 * How to restore stored seed `hash` from Git or the office's file; sync, check and
 * the seeds commands all give it.
 */
export function restoreAdvice(hash: string): string {
  const stored = `${seedStore}/${hash}`;

  return `restore it from Git (git checkout -- ${stored}) or, if it was never committed, copy the file as office laid it down (for an unchanged file, the office's file) to ${stored}`;
}

/** Stored seed `hash` in the office at `dir`: its bytes, `missing`, or `not a file` for a folder, a link or anything else office won't read as one. */
function storedEntry(dir: string, hash: string): Buffer | "missing" | "not a file" {
  const path = join(dir, seedStore, hash);
  const info = entryAt(path);

  if (info === undefined) return "missing";

  return info.isFile() ? readFileSync(path) : "not a file";
}

/** The stored seed `hash` in the office at `dir`, or undefined when it isn't stored as a file. */
export function readStoredSeed(dir: string, hash: string): Buffer | undefined {
  const entry = storedEntry(dir, hash);

  return entry === "missing" || entry === "not a file" ? undefined : entry;
}

/** What is wrong with a stored seed's entry for `hash`, and how to repair it, or undefined when nothing is. */
function entryFault(entry: Buffer | "missing" | "not a file", hash: string): { what: string; repair: string } | undefined {
  if (entry === "missing") return { what: "is missing", repair: restoreAdvice(hash) };

  if (entry === "not a file") return { what: "is not a file", repair: `remove it, then ${restoreAdvice(hash)}` };

  return sha256(entry) === hash ? undefined : { what: "doesn't hash to its name", repair: restoreAdvice(hash) };
}

/**
 * What is wrong with stored seed `hash` in the office at `dir`, with how to repair it: missing, not
 * a file, bytes that don't hash to its name, or nothing.
 */
export function storedSeedFault(dir: string, hash: string): string | undefined {
  const fault = entryFault(storedEntry(dir, hash), hash);

  return fault && `${fault.what}; ${fault.repair}`;
}

/**
 * Keeps `bytes`, whose SHA-256 is `hash`, in the seed store of the office at `dir`, written whole by
 * rename. Only a missing seed is written. One already stored is left as it is; when its bytes don't
 * hash to its name, or it isn't a file, it throws, as it does when the store can't be written,
 * naming the seed's place in the store.
 */
export function storeSeed(dir: string, hash: string, bytes: Buffer): void {
  const stored = `${seedStore}/${hash}`;
  let fault: ReturnType<typeof entryFault>;

  try {
    const entry = storedEntry(dir, hash);

    if (entry === "missing") atomicWrite(join(dir, stored), bytes, 0o644, join(dir, staging));
    else fault = entryFault(entry, hash);
  } catch (error) {
    throw new Error(`could not store it as ${stored}, so it isn't copied: ${message(error)}`);
  }

  if (fault !== undefined) throw new Error(`${stored} ${fault.what}, so it isn't copied; ${fault.repair}`);
}

/**
 * Keeps the store's `.gitattributes`, rewriting it when it is missing or differs, once the store of
 * the office at `dir` holds anything else, or when `receipts` says the receipts file is about to be
 * written into it. Returns a line when it wrote it; throws naming it when it can't.
 */
export function keepSeedAttributes(dir: string, receipts = false): string[] {
  const attributes = `${seedStore}/.gitattributes`;

  try {
    if (!receipts && (!existsSync(join(dir, seedStore)) || !readdirSync(join(dir, seedStore)).some(name => name !== ".gitattributes"))) return [];

    if (existsSync(join(dir, attributes)) && readFileSync(join(dir, attributes), "utf8") === seedAttributes) return [];
    atomicWrite(join(dir, attributes), seedAttributes, 0o644, join(dir, staging));
  } catch (error) {
    throw new Error(`could not write ${attributes}, which stops Git converting stored seeds: ${message(error)}`);
  }

  return [`wrote ${attributes}`];
}
