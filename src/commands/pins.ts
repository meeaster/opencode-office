// `office packages update`: move the pins of packages from other repositories along their `track`
// (a branch, or the highest stable SemVer tag matching a pattern), record each as a full commit SHA
// in office.yaml and apply it. It touches only packages: no clones, references or working repositories, and no
// sync. A package whose track can't be resolved, or whose copy can't be applied, keeps its pin.
// It also moves the office.lock commit of each untracked package whose ref is a tag or branch to
// where that ref points now, leaving office.yaml as it is.
import { type Office, OfficeError, withScalar } from "../office.ts";
import { failure, isFailure, type Change } from "../lib/change.ts";
import { fullCommit, sourceDifferences, requirePackageOwnership, resolvePackages } from "../loader/packages.ts";
import type { Stage } from "../report/index.ts";
import { resolveRef, resolveTrack, type Resolved, short } from "../track.ts";
import { publishPackages } from "../loader/package-operation.ts";
import { readLockSection } from "../versions.ts";

type Resolution = ({ ok: true } & Resolved) | { ok: false; reason: string };

async function resolve(repo: string, track: string, find = resolveTrack): Promise<Resolution> {
  try {
    return { ok: true, ...await find(repo, track) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message.trim() : String(error) };
  }
}

/** Report each result as it arrives, including failures that don't stop the remaining updates. */
class UpdateProgress {
  updated = 0;
  private failed = 0;

  constructor(private readonly stage: Stage) {}

  push(...lines: Change[]): void {
    for (const line of lines) {
      if (isFailure(line)) {
        this.failed++;
        this.stage.error(line.failure);
      } else this.stage.note(line);
    }
  }

  finish(): void {
    if (this.failed > 0) {
      this.stage.fail(`${this.updated} updated, ${this.failed} failed`);

      throw new OfficeError("Fix the failures above and run the update again");
    }

    this.stage.done(this.updated === 0 ? "nothing to update" : `${this.updated} updated`);
  }
}

/**
 * A package's move to another commit: a tracked package moves its ref in office.yaml (at `index`)
 * with its lock entry; an untracked ref moves only its lock entry.
 */
type PackageMove = { commit: string; via: string; name: string; previous: string } & ({ kind: "tracked"; index: number } | { kind: "locked" });

/**
 * Resolves each tracked package from another repository, copies it at the commit found and records
 * that commit as its ref, and each untracked tag or branch ref at the commit it names now, recorded
 * in office.lock only; then applies the packages as sync does, when any commit moved.
 */
export async function updatePackages(loaded: Office, stage: Stage, { apply = true } = {}): Promise<void> {
  requirePackageOwnership(loaded);
  const office = loaded;

  const pending: PackageMove[] = [];
  const lines = new UpdateProgress(stage);
  const tracked = office.packages.flatMap((entry, index) => (entry.source === undefined ? [] : [{ entry, index, source: entry.source }]));
  const remote = new Map(resolvePackages(office).packages.flatMap(item => item.kind === "remote" ? [[item.entry.name, item.dir]] : []));
  const lock = readLockSection(office.dir, "packages");

  for (const { entry, index, source } of tracked) {
    if (source.track === undefined) {
      const dir = remote.get(entry.name);

      if (dir === undefined || fullCommit.test(source.ref)) {
        lines.push(`package ${entry.name}: pinned at ${short(source.ref)} with no track, so left there`);

        continue;
      }

      // The commit the lock holds while its entry matches. Without one, the entry is published
      // even when the installed copy is already at the ref's commit, which it is then reused from.
      const held = lock.get(entry.name);
      const current = held && !sourceDifferences(held, source).length ? held.commit : undefined;

      stage.detail(`checking ${entry.name} (${source.ref})`);

      const found = await resolve(source.repo, source.ref, resolveRef);

      if (!found.ok) {
        lines.push(failure(`FAILED package ${entry.name}: ${found.reason}; lock left at ${current === undefined ? "(none)" : short(current)}`));

        continue;
      }

      if (current === found.commit) {
        lines.push(`package ${entry.name}: ${source.ref} still at ${short(found.commit)} (${found.via})`);

        continue;
      }

      pending.push({ kind: "locked", commit: found.commit, via: found.via, name: entry.name, previous: current ?? "(none)" });

      continue;
    }

    stage.detail(`checking ${entry.name} (${source.track})`);

    const found = await resolve(source.repo, source.track);

    if (!found.ok) {
      lines.push(failure(`FAILED package ${entry.name}: ${found.reason}; pin left at ${short(source.ref)}`));

      continue;
    }

    if (source.ref === found.commit) {
      lines.push(`package ${entry.name}: already at ${short(found.commit)} (${found.via})`);

      continue;
    }

    pending.push({ kind: "tracked", index, commit: found.commit, via: found.via, name: entry.name, previous: source.ref });
  }

  let batch = pending;

  while (batch.length) {
    const pins = new Map(batch.flatMap(pin => pin.kind === "tracked" ? [[pin.name, pin.commit]] : []));
    const commits = new Map(batch.flatMap(pin => pin.kind === "locked" ? [[pin.name, pin.commit]] : []));

    const packages = office.packages.map(entry => {
      const ref = pins.get(entry.name);

      return entry.source && ref ? { ...entry, source: { ...entry.source, ref } } : entry;
    });

    stage.detail("applying packages");

    const result = await publishPackages({ ...office, packages }, true, {
      apply, names: batch.map(pin => pin.name), commits,
      yaml: text => batch.reduce((yaml, pin) => pin.kind === "tracked" ? withScalar(yaml, ["packages", pin.index, "ref"], pin.commit) : yaml, text),
    });

    const moved = (pin: (typeof batch)[number]) => pin.kind === "locked"
      ? `package ${pin.name}: locked ${short(pin.previous)} → ${pin.commit} (${pin.via}; office.yaml unchanged)`
      : `package ${pin.name}: pinned ${short(pin.previous)} → ${pin.commit} (${pin.via})`;

    if (result.published) {
      lines.updated = batch.length;
      lines.push(...batch.map(moved), ...result.lines);
      break;
    } else {
      const reason = result.lines.filter(isFailure).map(change => change.failure).join("; ");
      const implicated = batch.filter(pin => result.rejected?.includes(pin.name));
      const refused = implicated.length ? implicated : batch;
      lines.push(...refused.map(pin => failure(`FAILED package ${pin.name}: found ${short(pin.commit)} (${pin.via}), but ${reason}; ${pin.kind === "locked" ? "lock" : "pin"} left at ${short(pin.previous)}`)));
      batch = batch.filter(pin => !refused.includes(pin));
    }
  }

  if (tracked.length === 0) lines.push("office.yaml lists no packages from other repositories to update");
  lines.finish();
}
