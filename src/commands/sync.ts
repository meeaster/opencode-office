// `office sync`: makes the office's folders match office.yaml and the tool. It clones and updates,
// scaffolds desks that are declared but missing, installs, updates, restores and removes packages,
// runs their `sync` functions, writes the mise tools packages declare into machine.packages.toml
// and their setup into .office/mise/ (src/package-tools.ts) and, in a host-mode office the user
// agreed may manage its machine, links them and machine.toml into mise's global conf.d
// (src/machine.ts), links the server plugins packages register and installs their panels on the
// desktop app's machine. Office's plugin links are recognized by their target
// (standard/opencode/ownership.ts) and kept out of commits through the repository's info/exclude,
// with the paths packages' sync functions exclude. It never rewrites AGENTS.md, other hand-written
// content or an existing app; what packages write in the office is their own `sync` functions' work.
import { readdirSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import * as v from "valibot";
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

import { prepareReferenceRefresh } from "../../packages/references/tasks/refresh.ts";
import { claudeFiles } from "../claude.ts";
import { appliedReferences } from "../applied-references.ts";
import { publishPackages } from "../package-operation.ts";
import { editorLinks, linkForEditors } from "../package-imports.ts";
import { openCheckoutLease } from "../checkout-lease.ts";
import type { Gathered } from "../gather.ts";
import { officeInfo, packageLines } from "../lifecycle-inputs.ts";
import { installPanel, locate, panelId, removalNote } from "../desktop.ts";
import { syncMachine } from "../machine.ts";
import { cloneOrFetchStreamed, clonePluginStreamed, existingPluginDestination, git, isClone, PluginCheckoutProblem, referenceGit, referenceOriginProblem, refreshCloneStreamed, verifiedHead } from "../git.ts";
import { type Clone, clones } from "../layout.ts";
import { cloneTarget, linkPlugins, placeLink, requirePluginDestination, stagingFolder, withPluginPlan } from "../../standard/opencode/delivery.ts";
import { type Declaration, readDeclarations } from "../../standard/opencode/declarations.ts";
import { cloneFolder, entry as entryAt, officeEntries, pluginFolder } from "../../standard/opencode/ownership.ts";
import { atomicWrite } from "../secrets.ts";
import { syncTools } from "../package-tools.ts";
import { type Desk, type Office, OfficeError } from "../office.ts";
import { silentStage, type Stage } from "../report/index.ts";
import { installPackage, removePackage, requirePackageOwnership } from "../packages.ts";
import { toolFiles, toolPath, writeToolFile } from "../tool.ts";
import { requireKnownLockKeys } from "../versions.ts";

/** "release-notes" → "Release notes", for titles in scaffolded files. */
function title(name: string): string {
  const words = name.replaceAll("-", " ");

  return words.charAt(0).toUpperCase() + words.slice(1);
}

function fill(text: string, values: Record<string, string>): string {
  let result = text;

  for (const [key, value] of Object.entries(values)) result = result.replaceAll(`__${key}__`, value);

  return result;
}

/**
 * Copies a tool template folder (such as "template/desk"), filling placeholders in file names and
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

/**
 * Scaffolds a desk whose folder is missing, or only the starter Executor app of a desk that has
 * none. A desk that has both is left alone; `office check` reports anything else missing. A desk
 * with `app: false` never gets the app; an existing one is left for the human to delete.
 */
function scaffoldDesk(office: Office, desk: Desk): string[] {
  const dir = join(office.dir, desk.name);
  const appPath = join("executor-apps", desk.name);
  const deskExists = existsSync(dir);
  const appExists = !desk.app || existsSync(join(dir, appPath));

  for (const folder of ["repos", "scratch"]) mkdirSync(join(dir, folder), { recursive: true });

  if (deskExists && appExists) return [];

  const written = copyTemplate("template/desk", dir, { DESK: desk.name, DESK_TITLE: title(desk.name) }, (path) =>
    path.startsWith(`${appPath}/`) ? !appExists : !deskExists,
  );

  // Desk apps carry a copy of the office's OpenCode client, so they declare the same provider
  // and one OpenCode account links to all of them.
  if (!appExists) {
    for (const file of ["opencode.ts", "office.ts"]) {
      const copy = join(dir, appPath, file);

      cpSync(join(office.dir, "executor-apps/opencode", file), copy);
      written.push(copy);
    }
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
 * Clones and updates the office's repositories, references and plugin clones, each reported
 * as a part of `stage` as it runs. Returns one line per change, in office.yaml's
 * order, with a FAILED line for each that failed.
 */
async function syncClones(office: Office, scope: "references" | "others" | "all", stage: Stage, verbose: boolean): Promise<string[]> {
  const references = scope === "others" ? undefined : appliedReferences(office.dir, office);

  if (references && !references.ok) {
    const errors = references.errors.map(error => `FAILED ${error}`);

    for (const error of errors) stage.error(error);

    return errors;
  }

  const work = clones(office, references?.value ?? []).filter((clone) => scope !== "references" || clone.kind === "reference");
  const lines: string[][] = work.map(() => []);

  // A clone's result shows as its part; other changes it makes show as notes.
  const noted = (index: number, notes: string[]) => {
    for (const note of notes) stage.note(note);
    lines[index].push(...notes);
  };

  if (work.length === 0) return [];

  stage.detail(`cloning and updating ${work.length} ${work.length === 1 ? "source" : "sources"}, up to ${fetchSlots} at a time (${cloneSlots} new clones)`);
  stage.expect(work.length);

  const updates: (() => Promise<void>)[] = [];
  const missing: (() => Promise<void>)[] = [];

  for (const [index, clone] of work.entries()) {
    const where = relative(office.dir, clone.dir);

    const failed = (message: string) => {
      lines[index].push(`FAILED ${clone.kind} ${where}: ${message}`);

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
          } else if (clone.kind === "plugin") ({ result, notes } = await syncPlugin(office, clone, present, claim.linked));
          else result = await cloneOrFetchStreamed(clone.url, clone.ref, clone.dir, options);
          part.done(result);

          if (result !== "current" && result !== "fetched") lines[index].push(`${result} ${clone.kind} ${where}`);
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

  return lines.flat();
}

/** One line for a stage's result from sync's lines: what it cloned and updated, and how many other changes. */
export function summarize(changes: string[]): string {
  const count = (pattern: RegExp) => changes.filter((line) => pattern.test(line)).length;
  const failed = count(/^FAILED/);
  // Clone lines name a kind: reference, plugin or "<desk> repo".
  const cloned = count(/^cloned (reference|plugin|\S+ repo) /);
  const updated = count(/^updated (reference|plugin|\S+ repo) /);
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
 * (clones as parts, a line starting with FAILED as an error, the rest as notes).
 */
export async function sync(loaded: Office, { scope = "all", stage = silentStage, verbose = false }: SyncOptions = {}): Promise<string[]> {
  let office = loaded;
  const reported: string[] = [];

  // Every line reported except the clones', which their parts already showed.
  const changes = {
    push(...lines: string[]) {
      for (const line of lines) {
        reported.push(line);

        if (line.startsWith("FAILED")) stage.error(line);
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

  if (scope === "references") return syncClones(office, "references", stage, verbose);

  requirePluginDestination(office);
  stage.detail("scaffolding desks and installing packages");

  for (const desk of office.desks) {
    for (const path of scaffoldDesk(office, desk)) changes.push(`created ${relative(office.dir, path)}`);
  }

  // info/exclude is written once, after the clones, and only from a package set that was applied
  // whole. References are cloned only once this sync recorded the ones it resolved. A package's
  // sync function that threw stops the sync here.
  const applied = await syncPackages(office, changes, stage, false);

  if (applied.stopped) return reported;
  reported.push(...await syncClones(office, applied.recorded ? "all" : "others", stage, verbose));
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
export async function syncPackages(office: Office, changes: { push: (...lines: string[]) => void }, stage: Stage = silentStage, exclude = true) {
  requirePluginDestination(office);
  const result = await publishPackages(office, exclude);

  if (result.generation) stage.detail(`active package generation: ${result.generation}`);
  changes.push(...result.lines);

  return { recorded: result.recorded === true, stopped: result.stopped === true, committed: result.committed, excluded: result.excluded ?? [] };
}

/**
 * Applies a published package set from its gathering. While a selected package is unread (this
 * sync couldn't fetch it), what it claims is unknown, so no package's sync function runs and no
 * package's tools or machine files are reconciled; the others' OpenCode plugins and panels are
 * still delivered, and the unread package's stay as the last sync left them. Returns the paths the
 * sync functions excluded from commits.
 */
export async function applyPackages(office: Office, gathered: Gathered, changes: string[], exclude: boolean, withdrawals: string): Promise<string[]> {
  const installed = gathered.inventory;

  // .office/packages/ holds only what sync pulled in, so a folder no package wants goes. Its panel
  // stays on the app's machine, where other offices may use it.
  const removedPanels: string[] = [];
  let declarations: Map<string, Declaration> | undefined;

  for (const name of readdirSync(withdrawals)) {
    if (installed.unread.has(name) || installed.selected.has(name)) continue;

    // The last synced registration names the bundle.
    const claim = (declarations ??= readDeclarations(office)).get(name);
    const bundle = claim?.state === "declared" ? claim.paths.panel : undefined;

    if (bundle !== undefined && existsSync(join(withdrawals, name, bundle))) removedPanels.push(name);

    changes.push(...removePackage(office, name, join(withdrawals, name)));
    rmSync(join(withdrawals, name), { recursive: true });
  }

  for (const item of installed.installed) changes.push(...installPackage(office, item));

  // The machine is reconciled in either mode (container mode releases the host's files), and
  // packages' sync functions run, only once every selected package loaded. A sync function that
  // throws stops the rest, plugins and panels included.
  let excluded: string[] = [];

  if (gathered.unread.size) {
    const unknown = [...gathered.unread].join(", ");

    changes.push(`not running any package's sync function: what package ${unknown} registers is unknown until a sync loads it`, `not reconciling any package's tools or machine files: what package ${unknown} claims is unknown until a sync loads it`);
  } else {
    excluded = await runSyncFunctions(office, gathered, changes);
    changes.push(...syncTools(office, gathered.packages, [...gathered.selected]), ...syncMachine(office, gathered));
  }

  const plan = withPluginPlan(office, { ...installed, problems: [] }, gathered.assets);
  changes.push(...plan.problems.map((problem) => `FAILED package ${problem.packages.join(", ")}: ${problem.message}`));
  changes.push(...linkPlugins(office, plan));
  changes.push(...installPanels(office, plan.panels, removedPanels));
  changes.push(...linkForEditors(office.dir));

  if (exclude && !gathered.unread.size) changes.push(...excludePlumbing(office, gathered.committed, excluded));

  return excluded;
}

/** A package's `sync` function threw: the sync stops there, with the package set switched. */
export class SyncStopped extends Error {}

// A package's code gives the path: its type is checked here, not trusted.
const excludable = v.pipe(v.string(), v.check(path => {
  const normal = normalize(path);

  return path !== "" && !isAbsolute(path) && normal === path && normal !== ".." && !normal.startsWith(`..${sep}`) && !/[\n\r]/.test(path) && normal !== ".office" && !normal.startsWith(`.office${sep}`);
}));

/**
 * An office-relative path a package's sync function excludes from commits, checked: inside the
 * office, outside `.office/` (excluded whole already) and on one line.
 */
export function excludedPath(path: string): string {
  const read = v.safeParse(excludable, path);

  if (!read.success) throw new OfficeError(`can't exclude ${JSON.stringify(path)}: it must be a normalized path inside the office and outside .office/`);

  return read.output;
}

/**
 * Runs each package's `sync` function, in the order the packages loaded, each line it returns going
 * to `changes` under the package's name as it finishes. The first that throws, or returns something
 * other than lines, stops the rest: SyncStopped names the package. Returns the paths they excluded
 * from commits, sorted.
 */
export async function runSyncFunctions(office: Office, gathered: Pick<Gathered, "packages" | "entries">, changes: string[]): Promise<string[]> {
  const excluded = new Set<string>();

  for (const item of gathered.packages) {
    const name = item.entry.name;
    const run = item.manifest.sync?.bind(item.manifest);

    if (!run) continue;

    const exclude = (paths: readonly string[]) => {
      for (const path of paths) excluded.add(excludedPath(path));
    };

    const result = await packageLines(name, "sync", () => run({ office: officeInfo(office), entries: gathered.entries, settings: structuredClone(item.settings), exclude, updateExcluded: change => updateExcluded(office, change) }));

    if (!result.ok) throw new SyncStopped(result.problem);
    changes.push(...result.lines);
  }

  return [...excluded].sort();
}

/**
 * Installs each package's desktop app panel on the machine the app runs on, and says how to remove
 * the panel of a package that left office.yaml. The app machine is looked up only when there is a
 * panel to handle; inside the container, or when it can't be reached, nothing is installed.
 */
function installPanels(office: Office, bundles: ReadonlyMap<string, string>, removed: string[]): string[] {
  const panels = [...bundles].map(([name, bundle]) => ({ name, bundle }));

  if (panels.length === 0 && removed.length === 0) return [];

  const where = locate();
  const names = panels.map((panel) => panelId(panel.name)).join(", ");

  if (where.kind === "container") return panels.length === 0 ? [] : [`not installing panels (${names}) from the container: they install on the desktop app's machine, so run office sync on the host`];

  if (where.kind === "unreachable") return panels.length === 0 ? [] : [`not installing panels (${names}): ${where.reason}`];

  return [...panels.flatMap((panel) => installPanel(where.machine, office, panel)), ...removed.map((name) => removalNote(where.machine, name))];
}

export const excludeStart = "# office sync: its plumbing, rewritten on each sync. Add your own lines outside this block.";
export const excludeEnd = "# end of office sync";

/**
 * Keeps Office's plumbing out of commits without touching the owner's .gitignore: one block in the
 * repository's info/exclude naming every entry of `.office/` (packages, clones, staging and
 * generated state) but the `committed` folders packages declare, sorted, each written
 * `.office/<name>/`, which are committed, each Office plugin link, and each path packages' sync
 * functions `excluded`, with a leading slash and no trailing one so a link matches, and a path's
 * pattern characters escaped so it names that one path. Lines outside the block are the
 * owner's and stay, byte for byte, CRLF endings included. An office that isn't a Git repository's
 * root gets nothing.
 *
 * A file whose markers don't form exactly one block is left alone and reported: guessing where an
 * unterminated block ends could delete the owner's lines. The file is replaced whole by rename, from
 * a read made just before, so a reader (Git, or another sync) never sees it truncated. Two syncs
 * writing at once each keep every owner line they read, and the last rename wins; only an owner
 * edit made within that moment, between a sync's read and its rename, can be overwritten.
 */
export function excludePlumbing(office: Office, committed: readonly string[], excluded: readonly string[] = []): string[] {
  const links = [...new Set([...officeEntries(office), ...excluded])].sort();
  const wanted = ["/.office/*", ...[...committed].sort().map(folder => `!/${folder}`), `/${dirname(editorLinks)}/`, ...links.map(literal)];

  return editExcludeBlock(office, () => wanted);
}

/** An office-relative path as an exclude line naming that one path: leading slash, pattern characters escaped. */
function literal(path: string) {
  return `/${path.replaceAll(/[\\*?[]/g, "\\$&").replace(/ $/, "\\ ")}`;
}

/**
 * Changes only the given paths' lines in the exclude block, at once: each of `remove` stops being
 * excluded and each of `add` is excluded, every other line of the block and the file kept. For a
 * package that placed or gave up paths outside a whole sync, which rewrites the block from every
 * package's paths: its command, or its sync that is about to stop the rest.
 */
export function updateExcluded(office: Office, { add = [], remove = [] }: { add?: readonly string[]; remove?: readonly string[] }): string[] {
  const adding = add.map(path => literal(excludedPath(path)));
  const removing = new Set(remove.map(path => literal(excludedPath(path))));

  return editExcludeBlock(office, block => {
    const kept = block.filter(line => !removing.has(line) || adding.includes(line));

    return [...kept, ...adding.filter(line => !kept.includes(line))];
  });
}

/**
 * Replaces the lines of Office's block in info/exclude with what `next` makes of them (none when
 * there is no block yet), and returns one line per exclusion added or removed.
 */
function editExcludeBlock(office: Office, next: (block: readonly string[]) => string[]): string[] {
  if (!existsSync(join(office.dir, ".git"))) return [];

  let exclude: string;

  try {
    // In a worktree office .git is a file; Git names the exclude file the worktrees share.
    exclude = resolve(office.dir, git(["rev-parse", "--git-path", "info/exclude"], office.dir));
  } catch {
    return ["could not locate the office repository's info/exclude; Office's plumbing is not excluded from commits"];
  }

  if (existsSync(exclude)) exclude = realpathSync(exclude);
  const text = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  const raw = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  const lines = raw.map((line) => line.replace(/\r$/, ""));
  const starts = lines.flatMap((line, index) => (line === excludeStart ? [index] : []));
  const ends = lines.flatMap((line, index) => (line === excludeEnd ? [index] : []));

  if (starts.length > 1 || ends.length !== starts.length || (starts.length === 1 && ends[0] < starts[0])) {
    const at = relative(office.dir, exclude).startsWith("..") ? exclude : relative(office.dir, exclude);

    return [`FAILED ${at} has ${starts.length} "${excludeStart}" and ${ends.length} "${excludeEnd}" lines, not one block; left unchanged, so Office's plumbing may not be excluded from commits. Delete the stray marker lines (or the whole block, which office sync writes again), keeping your own lines, then sync again`];
  }

  // The block stays where it is; a file without one gets it at the end.
  const [start, end] = starts.length === 1 ? [starts[0], ends[0]] : [raw.length, raw.length - 1];
  const block = lines.slice(start + 1, end);
  const wanted = next(block);

  if (starts.length === 0 && wanted.length === 0) return [];
  const [before, after] = [raw.slice(0, start), raw.slice(end + 1)];
  // Office's lines take the file's line ending: CRLF when all of its lines have one.
  const cr = text.includes("\r\n") && !/(^|[^\r])\n/.test(text) ? "\r" : "";
  const updated = `${[...before, ...[excludeStart, ...wanted, excludeEnd].map((line) => line + cr), ...after].join("\n")}\n`;

  if (updated === text) return [];

  atomicWrite(exclude, updated, 0o644);

  const added = wanted.filter((line) => !block.includes(line));
  const removed = block.filter((line) => !wanted.includes(line));

  // A `!` line takes a path back out of the exclusions, so adding one stops excluding the path.
  const describe = (line: string, adding: boolean) => `${adding !== line.startsWith("!") ? "excluded" : "stopped excluding"} ${line.replace(/^!/, "")} from commits (info/exclude)`;

  return [
    ...added.map((line) => describe(line, true)),
    ...removed.map((line) => describe(line, false)),
  ];
}
