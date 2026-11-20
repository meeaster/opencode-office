// Machine-local proof of creation. Neither a selection nor a committed symlink is a receipt.
import { Database } from "bun:sqlite";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import * as v from "valibot";
import { OfficeError, type Office } from "../../src/office.ts";
import { check } from "../../src/schema.ts";
import { assetPaths, packageTarget } from "./assets.ts";

const ledger = ".office/resolved/opencode-links.sqlite";

const receipt = v.pipe(v.strictObject({
  owner: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]*$/)), path: v.string(), target: v.string(), identity: v.pipe(v.string(), v.regex(/^\d+:\d+:\d+$/)),
}), v.check(row => row.path === `.opencode/plugins/${row.owner}` && packageTarget(row.owner, row.target)));

type Receipt = v.InferOutput<typeof receipt>;

const declaration = v.union([
  v.strictObject({ state: v.literal("unavailable") }),
  v.strictObject({ state: v.literal("declared"), binding: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)), paths: assetPaths }),
]);

export type Declaration = v.InferOutput<typeof declaration>;

function ledgerPath(office: Office) {
  for (const parent of [".office", dirname(ledger)]) {
    const info = lstatSync(join(office.dir, parent), { throwIfNoEntry: false });

    if (info && !info.isDirectory()) throw new OfficeError("cannot verify OpenCode link receipts through a redirected ledger directory");
  }

  const path = join(office.dir, ledger);
  const info = lstatSync(path, { throwIfNoEntry: false });

  if (info && !info.isFile()) throw new OfficeError("OpenCode link ledger is not a regular file");

  return path;
}

/** Also check the symlink inode, not only its text: an owner can replace a link at the same path. */
export function linkIdentity(path: string) {
  const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });

  return stat?.isSymbolicLink() ? `${stat.dev}:${stat.ino}:${stat.ctimeNs}` : undefined;
}

function receipts(db: Database, office: Office) {
  const rows = db.query("SELECT owner, path, target, identity FROM links WHERE office=? AND root=?").all(office.name, realpathSync(office.dir));
  const original = v.pipe(receipt, v.check(row => [`../../packages/${row.owner}/plugin`, `../../.office/packages/${row.owner}/plugin`].includes(row.target)));

  if (!v.is(v.array(original), rows)) throw new OfficeError("invalid conventional OpenCode link receipt");

  // Older readers understand only the two conventional targets in `links`.
  const custom = db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='asset_links'").get()
    ? db.query("SELECT owner,path,target,identity FROM asset_links WHERE office=? AND root=?").all(office.name, realpathSync(office.dir))
    : [];

  const read = check(v.safeParse(v.array(receipt), [...rows, ...custom]));

  if (!read.ok) throw new OfficeError("invalid OpenCode creation receipt; restore a known ledger or move it aside and resolve the unowned links manually");

  const found = new Map<string, Receipt>();

  for (const row of read.value) {
    if (!found.has(row.owner) || linkIdentity(join(office.dir, row.path)) === row.identity) found.set(row.owner, row);
  }

  return found;
}

function readLedger<T>(office: Office, read: (db: Database, office: Office) => Map<string, T>) {
  const path = ledgerPath(office);
  const before = lstatSync(path, { bigint: true, throwIfNoEntry: false });

  if (!before) return new Map<string, T>();

  // Even SQLITE_OPEN_READONLY may create WAL/SHM files. Inspect stable rollback-mode bytes
  // in memory; don't recover a journal, borrow uncommitted rows, or open the on-disk DB.
  const busy = () => existsSync(`${path}-journal`) || existsSync(`${path}-wal`);
  const unavailable = "OpenCode link ledger is changing or needs recovery; retry after office sync --packages";

  if (busy()) throw new OfficeError(unavailable);
  const bytes = readFileSync(path);
  const after = lstatSync(path, { bigint: true });

  if (busy() || before.dev !== after.dev || before.ino !== after.ino || before.ctimeNs !== after.ctimeNs ||
    bytes[18] !== 1 || bytes[19] !== 1) throw new OfficeError(unavailable);

  using db = Database.deserialize(bytes, true);

  return read(db, office);
}

export function readReceipts(office: Office) {
  return readLedger(office, receipts);
}

/** Last collection, for observation only. No declaration confers custody of a link. */
export function readDeclarations(office: Office) {
  return readLedger(office, (db, office) => {
    const found = new Map<string, Declaration>();

    if (!db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='assets'").get()) return found;
    const rows = db.query<{ owner: string; declaration: string }, [string,string]>("SELECT owner,declaration FROM assets WHERE office=? AND root=?").all(office.name, realpathSync(office.dir));

    for (const row of rows) {
      const read = check(v.safeParse(declaration, JSON.parse(row.declaration)));

      if (!read.ok) throw new OfficeError("invalid recorded OpenCode declaration; run office sync --packages");
      found.set(row.owner, read.value);
    }

    return found;
  });
}

/** Serialize Office link writers. A crash between symlink creation and commit leaves an
 * unowned link; a rolled-back receipt for a removed inode cannot authorize a replacement. */
export function reconcileReceipts(office: Office, declarations: Map<string, Declaration>, apply: (recorded: Map<string, Receipt>, created: (receipt: Receipt) => void, forget: (owner: string) => void) => string[]) {
  const path = ledgerPath(office);
  mkdirSync(dirname(path), { recursive: true });
  using db = new Database(path, { create: true });
  db.exec("PRAGMA busy_timeout=10000; PRAGMA journal_mode=DELETE");
  const root = realpathSync(office.dir);

  return db.transaction(() => {
    db.exec("CREATE TABLE IF NOT EXISTS links (office TEXT NOT NULL, root TEXT NOT NULL, owner TEXT NOT NULL, path TEXT NOT NULL, target TEXT NOT NULL, identity TEXT NOT NULL, PRIMARY KEY (office, root, owner))");

    db.exec("CREATE TABLE IF NOT EXISTS asset_links (office TEXT NOT NULL, root TEXT NOT NULL, owner TEXT NOT NULL, path TEXT NOT NULL, target TEXT NOT NULL, identity TEXT NOT NULL, PRIMARY KEY (office, root, owner))");

    const forget = (owner: string) => {
      for (const table of ["links", "asset_links"]) db.run(`DELETE FROM ${table} WHERE office=? AND root=? AND owner=?`, [office.name, root, owner]);
    };

    const result = apply(receipts(db, office), row => {
      forget(row.owner);
      const table = [`../../packages/${row.owner}/plugin`, `../../.office/packages/${row.owner}/plugin`].includes(row.target) ? "links" : "asset_links";
      db.run(`INSERT INTO ${table} VALUES (?, ?, ?, ?, ?, ?)`, [office.name, root, row.owner, row.path, row.target, row.identity]);
    }, forget);

    db.exec("CREATE TABLE IF NOT EXISTS assets (office TEXT NOT NULL, root TEXT NOT NULL, owner TEXT NOT NULL, declaration TEXT NOT NULL, PRIMARY KEY (office,root,owner))");

    for (const { owner } of db.query<{ owner: string }, [string, string]>("SELECT owner FROM assets WHERE office=? AND root=?").all(office.name, root)) {
      if (!declarations.has(owner)) db.run("DELETE FROM assets WHERE office=? AND root=? AND owner=?", [office.name, root, owner]);
    }

    for (const [owner, claim] of declarations) db.run("INSERT INTO assets VALUES (?,?,?,?) ON CONFLICT(office,root,owner) DO UPDATE SET declaration=excluded.declaration WHERE declaration<>excluded.declaration", [office.name, root, owner, JSON.stringify(claim)]);

    return result;
  }).immediate();
}
