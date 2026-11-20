import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type Office, OfficeError, readConfig } from "./office.ts";
import { inputHash, readSnapshot, referenceFile, type ReferenceSnapshot } from "./reference-snapshot.ts";
import type { Parsed } from "./schema.ts";

export type ReferencePublication = {
  previous: ReferenceSnapshot | undefined;
  /** Returns true when the desired list changed, rather than just its input fingerprint. */
  publish(candidate: ReferenceSnapshot): boolean;
};

/** Only the short admission and publication steps take a kernel-backed SQLite writer lock.
 * The ticket orders attempts (including empty/no-op syncs); JSON remains the portable reader input.
 * A collector may pause or die without holding a lock or preventing the next sync. */
export function beginReferencePublication(office: Office): Parsed<ReferencePublication> {
  const path = join(office.dir, referenceFile);
  const folder = dirname(path);
  mkdirSync(folder, { recursive: true });
  const ticket = randomUUID();
  const inputs = inputHash(office);

  function locked<T>(action: (db: Database) => T): T {
    using db = new Database(join(folder, "publication.sqlite"), { create: true });
    db.exec("PRAGMA busy_timeout=5000");

    return db.transaction(() => {
      if (inputHash(readConfig(office.dir)) !== inputs) throw new OfficeError("reference inputs changed during sync; retry with the current office.yaml");

      return action(db);
    }).immediate();
  }

  const read = locked(db => {
    db.exec("CREATE TABLE IF NOT EXISTS publisher (id INTEGER PRIMARY KEY, ticket TEXT NOT NULL)");
    db.run("REPLACE INTO publisher VALUES (1, ?)", [ticket]);

    return readSnapshot(office.dir);
  });

  if (!read.ok) return read;
  const previous = read.value;

  const publish = (candidate: ReferenceSnapshot) => locked(db => {
    if (!db.query("SELECT 1 FROM publisher WHERE id = 1 AND ticket = ?").get(ticket)) throw new OfficeError("reference publication superseded by a newer sync; candidate discarded");

    if (Bun.deepEquals(previous, candidate)) return false;
    const staging = `${path}.${ticket}.tmp`;

    try {
      writeFileSync(staging, `${JSON.stringify(candidate, null, 2)}\n`);
      renameSync(staging, path);
    } finally {
      rmSync(staging, { force: true });
    }

    return !previous || !Bun.deepEquals(previous.owner, candidate.owner) || !Bun.deepEquals(previous.contributors, candidate.contributors);
  });

  return { ok: true, value: { previous, publish } };
}
