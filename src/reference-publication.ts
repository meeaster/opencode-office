import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openCheckoutLease } from "./checkout-lease.ts";
import { type Office, OfficeError, readConfig } from "./office.ts";
import { inputHash, readSnapshot, referenceFile, type ReferenceSnapshot, resolvedReferences } from "./reference-snapshot.ts";
import type { Parsed } from "./schema.ts";

export type ReferencePublication = {
  previous: ReferenceSnapshot | undefined;
  /** Returns true when the desired list changed, rather than just its input fingerprint. */
  publish(candidate: ReferenceSnapshot): boolean;
};

/** Publication and admission to a checkout lease share this lock. Git runs outside it. */
function locked<T>(dir: string, action: (db: Database) => T): T {
  const folder = dirname(join(dir, referenceFile));
  mkdirSync(folder, { recursive: true });
  using db = new Database(join(folder, "publication.sqlite"), { create: true });
  db.exec("PRAGMA busy_timeout=30000");

  return db.transaction(() => {
    db.exec("CREATE TABLE IF NOT EXISTS checkout (name TEXT PRIMARY KEY, ticket TEXT NOT NULL)");

    return action(db);
  }).immediate();
}

/** Reserve at planning time, including queued clones. A later refresh owns its own results. */
export function planReferenceApply(office: Office) {
  const ticket = randomUUID();

  try {
    return locked(office.dir, db => {
      const read = resolvedReferences(office.dir, readConfig(office.dir));

      if (!read.ok) return read;
      const { entries, fromYaml } = read.value;
      const planned = new Map(entries.map(entry => [entry.name, entry]));
      const reserve = db.query("REPLACE INTO checkout VALUES (?, ?)");

      for (const entry of entries) reserve.run(entry.name, ticket);

      function guard<T extends string | void>(name: string, apply: (fd: number) => T): T {
        using lease = openCheckoutLease(office.dir, name);
        locked(office.dir, current => {
          if (!current.query("SELECT 1 FROM checkout WHERE name=? AND ticket=?").get(name, ticket)) throw new OfficeError(`reference ${name}: refresh superseded; checkout left unchanged`);
          const latest = resolvedReferences(office.dir, fromYaml ? readConfig(office.dir) : office);

          if (!latest.ok) throw new OfficeError(latest.errors.join("\n"));

          if (latest.value.fromYaml !== fromYaml || !Bun.deepEquals(planned.get(name), latest.value.entries.find(entry => entry.name === name))) throw new OfficeError(`reference ${name}: claim changed; checkout left unchanged`);

          lease.acquire();
        });

        return apply(lease.fd);
      }

      return { ok: true as const, value: { ...read.value, guard } };
    });
  } catch (error) {
    // If the directory itself is inaccessible, report the snapshot read error rather than
    // SQLite's generic open error; a failed coordinator is never authority to apply YAML.
    const read = readSnapshot(office.dir);

    return { ok: false as const, errors: read.ok ? [`reference apply: ${error instanceof Error ? error.message : String(error)}`] : read.errors };
  }
}

/** Only the short admission and publication steps take a kernel-backed SQLite writer lock.
 * The ticket orders attempts (including empty/no-op syncs); JSON remains the portable reader input.
 * A collector may pause or die without holding a lock or preventing the next sync. */
export function beginReferencePublication(office: Office, switchGeneration?: (snapshot: ReferenceSnapshot) => void): Parsed<ReferencePublication> {
  const path = join(office.dir, referenceFile);
  const ticket = randomUUID();
  const inputs = inputHash(office);

  function withInputs<T>(action: (db: Database) => T): T {
    return locked(office.dir, db => {
      if (inputHash(readConfig(office.dir)) !== inputs) throw new OfficeError("reference inputs changed during sync; retry with the current office.yaml");

      return action(db);
    });
  }

  const read = withInputs(db => {
    db.exec("CREATE TABLE IF NOT EXISTS publisher (id INTEGER PRIMARY KEY, ticket TEXT NOT NULL)");
    db.run("REPLACE INTO publisher VALUES (1, ?)", [ticket]);

    return readSnapshot(office.dir);
  });

  if (!read.ok) return read;
  const previous = read.value;

  const publish = (candidate: ReferenceSnapshot) => withInputs(db => {
    if (!db.query("SELECT 1 FROM publisher WHERE id = 1 AND ticket = ?").get(ticket)) throw new OfficeError("reference publication superseded by a newer sync; candidate discarded");

    if (!switchGeneration && Bun.deepEquals(previous, candidate)) return false;

    // Every admitted mutator has a committed checkout row. No new lease can
    // start while this SQLite writer owns admission. Probe before replacing
    // the generation or deleting ANY tickets, including after a parent crash.
    for (const { name } of db.query<{ name: string }, []>("SELECT name FROM checkout").all()) {
      using lease = openCheckoutLease(office.dir, name);
      lease.acquire();
    }

    const staging = `${path}.${ticket}.tmp`;

    try {
      if (switchGeneration) switchGeneration(candidate);
      else {
        writeFileSync(staging, `${JSON.stringify(candidate, null, 2)}\n`);
        renameSync(staging, path);
      }

      db.exec("DELETE FROM checkout");
    } finally {
      rmSync(staging, { force: true });
    }

    return !previous || !Bun.deepEquals(previous.owner, candidate.owner) || !Bun.deepEquals(previous.contributors, candidate.contributors);
  });

  return { ok: true, value: { previous, publish } };
}
