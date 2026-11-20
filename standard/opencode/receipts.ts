// Machine-local proof of creation. Neither a selection nor a committed symlink is a receipt.
import { Database } from "bun:sqlite";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import * as v from "valibot";
import { OfficeError, type Office } from "../../src/office.ts";
import { check } from "../../src/schema.ts";

const ledger = ".office/resolved/opencode-links.sqlite";

const receipt = v.pipe(v.strictObject({
  owner: v.pipe(v.string(), v.regex(/^[a-z0-9][a-z0-9-]*$/)), path: v.string(), target: v.string(), identity: v.pipe(v.string(), v.regex(/^\d+:\d+:\d+$/)),
}), v.check(row => row.path === `.opencode/plugins/${row.owner}` &&
  (row.target === `../../packages/${row.owner}/plugin` || row.target === `../../.office/packages/${row.owner}/plugin`)));

type Receipt = v.InferOutput<typeof receipt>;

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
  const read = check(v.safeParse(v.array(receipt), rows));

  if (!read.ok) throw new OfficeError("invalid OpenCode creation receipt; restore a known ledger or move it aside and resolve the unowned links manually");

  return new Map(read.value.map(row => [row.owner, row]));
}

export function readReceipts(office: Office) {
  const path = ledgerPath(office);
  const before = lstatSync(path, { bigint: true, throwIfNoEntry: false });

  if (!before) return new Map<string, Receipt>();

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

  return receipts(db, office);
}

/** Serialize Office link writers. A crash between symlink creation and commit leaves an
 * unowned link; a rolled-back receipt for a removed inode cannot authorize a replacement. */
export function reconcileReceipts(office: Office, apply: (recorded: Map<string, Receipt>, created: (receipt: Receipt) => void, forget: (owner: string) => void) => string[]) {
  const path = ledgerPath(office);
  mkdirSync(dirname(path), { recursive: true });
  using db = new Database(path, { create: true });
  db.exec("PRAGMA busy_timeout=10000; PRAGMA journal_mode=DELETE");
  const root = realpathSync(office.dir);

  return db.transaction(() => {
    db.exec("CREATE TABLE IF NOT EXISTS links (office TEXT NOT NULL, root TEXT NOT NULL, owner TEXT NOT NULL, path TEXT NOT NULL, target TEXT NOT NULL, identity TEXT NOT NULL, PRIMARY KEY (office, root, owner))");

    return apply(receipts(db, office),
      row => db.run("INSERT OR REPLACE INTO links VALUES (?, ?, ?, ?, ?, ?)", [office.name, root, row.owner, row.path, row.target, row.identity]),
      owner => db.run("DELETE FROM links WHERE office=? AND root=? AND owner=?", [office.name, root, owner]));
  }).immediate();
}
