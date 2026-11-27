// `office sync`: makes the office's folders match office.yaml and the tool. It clones and updates
// references and plugin clones, installs, updates, restores and removes packages,
// runs their `sync` functions (and, in a full sync that applied the set whole, their `fullSync`
// items, src/loader/lifecycle/full-sync.ts), writes the mise tools packages declare into machine.packages.toml
// and their setup into .office/mise/ (src/features/mise-integration/delivery.ts) and, in a host-mode office the user
// agreed may manage its machine, links them and machine.toml into mise's global conf.d
// (src/features/host/machine.ts), links the server plugins packages register and installs their panels on the
// desktop app's machine. Office's plugin links are recognized by their target
// (src/features/opencode/ownership.ts) and kept out of commits through the repository's info/exclude,
// with the paths packages' sync functions exclude. It never rewrites AGENTS.md, other hand-written
// content or an existing app; what packages write in the office is their own `sync` functions' work.
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { prepareReferenceRefresh } from "../../packages/references/tasks/refresh.ts";
import { claudeFiles } from "../features/claude/claude.ts";
import { appliedReferences } from "../features/references/applied-references.ts";
import { publishPackages } from "../loader/publication/publish.ts";
import { fullSyncStep } from "../loader/lifecycle/full-sync.ts";
import { openCheckoutLease } from "../checkout-lease.ts";
import { clonePluginStreamed, existingPluginDestination, git, isClone, PluginCheckoutProblem, referenceGit, referenceOriginProblem, refreshCloneStreamed, verifiedHead } from "../git.ts";
import { type Clone, clones } from "../layout.ts";
import { cloneTarget, placeLink, requirePluginDestination, stagingFolder } from "../features/opencode/delivery.ts";
import { cloneFolder, entry as entryAt, pluginFolder } from "../features/opencode/ownership.ts";
import { type Office } from "../office.ts";
import { silentStage, type Stage } from "../report/index.ts";
import { requirePackageOwnership } from "../loader/sources/selection.ts";
import { toolFiles, toolPath, writeToolFile } from "../tool.ts";
import { requireKnownLockKeys } from "../versions.ts";
import { changeText, failure, isFailure, type Change } from "../lib/change.ts";
import { excludePlumbing } from "../exclude-plumbing.ts";

function fill(text: string, values: Record<string, string>): string {
  let result = text;

  for (const [key, value] of Object.entries(values)) result = result.replaceAll(`__${key}__`, value);

  return result;
}

/**
 * Copies a tool template folder (such as "template/office"), filling placeholders in file names and
 * contents. Existing files are kept, and so are template paths (after filling) that `include`
 * rejects.
 */
export function copyTemplate(from: string, to: string, values: Record<string, string>, include: (path: string) => boolean = () => true): string[] {
  const written: string[] = [];

  for (const file of toolFiles(from)) {
    const path = fill(file, values);
    const target = join(to, path);

    if (existsSync(target) || !include(path)) continue;

    writeToolFile(target, fill(readFileSync(toolPath(`${from}/${file}`), "utf8"), values));
    written.push(target);
  }

  return written;
}

const fetchSlots = 8;
const cloneSlots = 4;

/** Check both the working tree being updated and the effective fetch URL. */
function requirePluginCheckout(office: Office, dir: string, url: string) {
  requirePluginDestination(office);
  const metadata = join(dir, ".git");
  const info = lstatSync(metadata, { throwIfNoEntry: false });

  try {
    if (info?.isDirectory() && !referenceOriginProblem(dir, url) &&
      realpathSync(git(["rev-parse", "--show-toplevel"], dir)) === realpathSync(dir) &&
      realpathSync(git(["rev-parse", "--absolute-git-dir"], dir)) === realpathSync(metadata) &&
      git(["remote", "get-url", "--all", "origin"], dir) === git(["config", "--local", "--get", "remote.origin.url"], dir)
    ) return;
  } catch { /* Refuse without quoting raw Git URLs or credentials. */ }

  throw new PluginCheckoutProblem("cannot verify plugin checkout origin and directory; left unchanged");
}

type LinkClaim = {
  /** Office's link to this clone was already there. */
  linked: boolean;
  /** The link made for a present checkout. */
  notes: string[];
};

/**
 * Readies `.opencode/plugins/<name>` for a clone: free, or already Office's link to it. Anything
 * else there is the office's own and is refused. Returns whether the link was there, and what it linked.
 */
function claimPluginLink(office: Office, clone: Clone): LinkClaim {
  const at = `${pluginFolder}/${clone.name}`;
  const existing = entryAt(office, clone.name);

  if (!existing) {
    // A present, verified checkout is linked before fetching: a fetch that fails (offline, auth)
    // must not leave it unlinked, and OpenCode then keeps loading it. A first clone is linked after
    // publication instead (linkClone).
    if (!isClone(clone.dir) || !verifiedCheckout(office, clone.dir, clone.url)) return { linked: false, notes: [] };

    return { linked: true, notes: linkPresent(office, clone) };
  }

  if (existing.office && existing.target === cloneTarget(clone.name)) return { linked: true, notes: [] };

  if (existing.office) throw new PluginCheckoutProblem(`${at} links to a package's plugin; a package and a plugins: entry can't share a name, so rename one of them`);

  throw new PluginCheckoutProblem(`${at} is the office's own (not a link office sync made), kept; move it aside or rename the plugins: entry`);
}

/** Whether `dir` is provably this plugin's checkout, with a commit. */
function verifiedCheckout(office: Office, dir: string, url: string): boolean {
  try {
    requirePluginCheckout(office, dir, url);

    return verifiedHead(dir) !== undefined;
  } catch {
    return false;
  }
}

/** Links an existing checkout where nothing is at `.opencode/plugins/<name>`. */
function linkPresent(office: Office, clone: Clone): string[] {
  const at = `${pluginFolder}/${clone.name}`;

  placeLink(office, join(office.dir, at), cloneTarget(clone.name));

  return [`linked ${at}`];
}

/**
 * Links `.opencode/plugins/<name>` to the clone, after it is published: OpenCode doesn't notice a
 * checkout that appears behind an existing link, so a link that was there first is made again.
 */
function linkClone(office: Office, clone: Clone, remake: boolean): string[] {
  const at = `${pluginFolder}/${clone.name}`;
  const target = cloneTarget(clone.name);
  const existing = entryAt(office, clone.name);

  if (existing && !(existing.office && existing.target === target)) throw new PluginCheckoutProblem(`${at} changed during delivery; kept, and the clone is not linked`);

  if (existing && !remake) return [];
  placeLink(office, join(office.dir, at), target, existing ? target : undefined);

  return [`${existing ? "relinked" : "linked"} ${at}`];
}

async function syncPlugin(office: Office, clone: Clone, present: boolean, linked: boolean) {
  requirePluginDestination(office);

  if (isClone(clone.dir) !== present) throw new Error("plugin checkout changed; retry sync");
  const verify = () => requirePluginCheckout(office, clone.dir, clone.url);
  let result: "cloned" | "updated" | "current";

  try {
    if (!present) {
      // Even an empty folder is the owner's: publication would replace it and its metadata.
      if (lstatSync(clone.dir, { throwIfNoEntry: false })) throw new PluginCheckoutProblem(existingPluginDestination);

      // Staging shares the filesystem of .office/plugins/, so publication is one rename.
      const staging = join(office.dir, stagingFolder);
      mkdirSync(staging, { recursive: true });
      result = await clonePluginStreamed(clone.url, clone.ref, clone.dir, staging, verify);
    } else {
      try {
        verify();
      } catch (error) {
        if (!(error instanceof PluginCheckoutProblem)) throw error;

        // Such as a withdrawn clone whose name is selected again with another repository.
        throw new PluginCheckoutProblem(`${error.message}. If ${cloneFolder}/${clone.name} is an earlier checkout of another repository, move it aside (or remove it) and sync again`);
      }

      // A checkout with no commit (such as one a failed clone left) would be filled in place, where
      // OpenCode already looks. Refuse it before fetching rather than adopt it.
      if (!verifiedHead(clone.dir)) throw new PluginCheckoutProblem(`existing plugin checkout has no commit; left unchanged. Move it aside so office sync can clone a fresh copy, then sync again. If an interrupted first sync left it, see "Recovering an interrupted first clone" in docs/opencode-sources.md`);

      result = await refreshCloneStreamed(clone.ref, clone.dir, {}, verify);
    }
  } catch (error) {
    // Raw Git output (including verbose progress) can contain credentialed URLs.
    if (error instanceof PluginCheckoutProblem) throw error;

    throw new Error("plugin Git operation failed; check the checkout, configured repository and ref");
  }

  return { result, notes: linkClone(office, clone, linked && result === "cloned") };
}

/**
 * Clones and updates the office's references and plugin clones, each reported
 * as a part of `stage` as it runs. Returns one line per change, in office.yaml's
 * order, with a FAILED line for each that failed.
 */
async function syncClones(office: Office, scope: "references" | "others" | "all", stage: Stage, verbose: boolean): Promise<{ changes: Change[]; parts: number }> {
  const references = scope === "others" ? undefined : appliedReferences(office.dir, office);

  if (references && !references.ok) {
    const errors = references.errors.map(error => failure(`FAILED ${error}`));

    for (const error of errors) stage.error(changeText(error));

    return { changes: errors, parts: 0 };
  }

  const work = clones(office, references?.value ?? []).filter((clone) => scope !== "references" || clone.kind === "reference");
  const lines: Change[][] = work.map(() => []);

  // A clone's result shows as its part; other changes it makes show as notes.
  const noted = (index: number, notes: string[]) => {
    for (const note of notes) stage.note(note);
    lines[index].push(...notes);
  };

  if (work.length === 0) return { changes: [], parts: 0 };

  stage.detail(`cloning and updating ${work.length} ${work.length === 1 ? "source" : "sources"}, up to ${fetchSlots} at a time (${cloneSlots} new clones)`);
  stage.expect(work.length);

  const updates: (() => Promise<void>)[] = [];
  const missing: (() => Promise<void>)[] = [];

  for (const [index, clone] of work.entries()) {
    const where = relative(office.dir, clone.dir);

    const failed = (message: string) => {
      lines[index].push(failure(`FAILED ${clone.kind} ${where}: ${message}`));

      return message;
    };

    try {
      let claim: LinkClaim = { linked: false, notes: [] };

      if (clone.kind === "plugin") {
        requirePluginDestination(office);

        if (lstatSync(clone.dir, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error("existing symlink kept; move it aside yourself before cloning here");
        claim = claimPluginLink(office, clone);
        noted(index, claim.notes);
      }

      const present = isClone(clone.dir);

      (present ? updates : missing).push(async () => {
        const part = stage.part(where, present ? "updating" : "cloning");
        const options = { line: part.output, verbose };

        try {
          let result;
          let notes: string[] = [];

          if (clone.kind === "reference") {
            // One lease for the whole checkout, fetch included: a second refresh runs no Git on it.
            using lease = openCheckoutLease(office.dir, clone.name);
            lease.acquire();
            result = await prepareReferenceRefresh(present, referenceGit(clone, lease.fd))(options);
          } else ({ result, notes } = await syncPlugin(office, clone, present, claim.linked));
          part.done(result);

          if (result !== "current") lines[index].push(`${result} ${clone.kind} ${where}`);
          noted(index, notes);
        } catch (error) {
          part.fail(failed(error instanceof Error ? error.message.trim() : String(error)));
        }
      });
    } catch (error) {
      stage.part(where, "checking").fail(failed(error instanceof Error ? error.message.trim() : String(error)));
    }
  }

  // Half the workers may start new clones. All eight can drain existing-repo fetches.
  await Promise.all(Array.from({ length: fetchSlots }, async (_, slot) => {
    for (;;) {
      const job = (slot < cloneSlots ? missing.shift() : undefined) ?? updates.shift();

      if (!job) return;
      await job();
    }
  }));

  return { changes: lines.flat(), parts: work.length };
}

/** One line for a stage's result from sync's lines: what it cloned and updated, and how many other changes. */
export function summarize(changes: Change[]): string {
  const count = (pattern: RegExp) => changes.filter((line) => !isFailure(line) && pattern.test(line)).length;
  const failed = changes.filter(isFailure).length;
  // Clone lines name a kind: reference or plugin.
  const cloned = count(/^cloned (reference|plugin) /);
  const updated = count(/^updated (reference|plugin) /);
  const other = changes.length - failed - cloned - updated;

  const parts = [
    cloned > 0 ? `${cloned} cloned` : "",
    updated > 0 ? `${updated} updated` : "",
    other > 0 ? `${other} other ${other === 1 ? "change" : "changes"}` : "",
    failed > 0 ? `${failed} failed` : "",
  ].filter(Boolean);

  return parts.length === 0 ? "already in sync" : parts.join(", ");
}

type SyncOptions = {
  scope?: "all" | "references" | "packages";
  /** Where the sync reports as it goes: each clone as a part, then each change line. */
  stage?: Stage;
  /** Ask git for its progress, for a verbose plain run. */
  verbose?: boolean;
};

/**
 * Runs the sync and returns one line per change, each also reported to `stage` as it happens
 * (clones as parts, a failure as an error, the rest as notes).
 */
export async function sync(loaded: Office, { scope = "all", stage = silentStage, verbose = false }: SyncOptions = {}): Promise<Change[]> {
  let office = loaded;
  const reported: Change[] = [];

  // Every line reported except the clones', which their parts already showed.
  const changes = {
    push(...lines: Change[]) {
      for (const line of lines) {
        reported.push(line);

        if (isFailure(line)) stage.error(line.failure);
        else stage.note(line);
      }
    },
  };

  // Before anything is written: a key office.lock holds that office doesn't know stops the sync.
  if (scope !== "references") requireKnownLockKeys(office.dir);

  if (scope !== "references") requirePackageOwnership(office);

  if (scope === "packages") {
    await syncPackages(office, changes, stage);

    return reported;
  }

  if (scope === "references") return (await syncClones(office, "references", stage, verbose)).changes;

  requirePluginDestination(office);
  stage.detail("installing packages");

  // info/exclude is written once, after the clones, and only from a package set that was applied
  // whole. References are cloned only once this sync recorded the ones it resolved. A package's
  // sync function that threw stops the sync here.
  const applied = await syncPackages(office, changes, stage, false);

  if (applied.stopped) return reported;
  const cloned = await syncClones(office, applied.recorded ? "all" : "others", stage, verbose);

  reported.push(...cloned.changes);

  // Only after this sync's own admission and application succeeded, every package loaded and no step failed.
  if (applied.generation !== undefined) reported.push(...await fullSyncStep(office, applied.generation, stage, cloned.parts, verbose));
  else stage.note("no package's full-sync work ran: this sync didn't apply the package set whole without a failure");
  changes.push(...claudeFiles(office.dir, true));

  if (applied.committed) changes.push(...excludePlumbing(office, applied.committed, applied.excluded));

  return reported;
}

/**
 * Installs, updates, restores and removes the office's packages at the refs office.yaml pins, then
 * applies them: settings, packages' sync functions, their mise tools (linked machine-wide where the
 * office manages the machine), plugin links and desktop panels. `office sync` and `office packages
 * update` both apply packages this way. A rejected candidate applies nothing. Each change goes to
 * `changes`. Returns whether the switch recorded the references it resolved, whether a package's
 * sync function stopped the sync, and, when the set was applied whole, the committed folders.
 */
async function syncPackages(office: Office, changes: { push: (...lines: Change[]) => void }, stage: Stage = silentStage, exclude = true) {
  requirePluginDestination(office);
  const result = await publishPackages(office, exclude);

  if (result.generation) stage.detail(`active package generation: ${result.generation}`);
  changes.push(...result.lines);

  // The generation this sync published and applied whole (so with committed folders) without a
  // failed step, for full-sync work; undefined otherwise. The references and exclusions keep
  // their own conditions, `recorded` and `committed`.
  const generation = result.committed === undefined || result.lines.some(isFailure) ? undefined : result.generation;

  return { recorded: result.recorded === true, stopped: result.stopped === true, committed: result.committed, excluded: result.excluded ?? [], generation };
}
