import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { bindPaths } from "./bound-paths.ts";
import { boundRevision, collectReferences } from "./collect-references.ts";
import { currentOffice, loadOffice, type Office, OfficeError, type PackageEntry } from "./office.ts";
import { parse } from "yaml";
import * as v from "valibot";
import { type LockedPackage, officeSchema, type PackageLock, parsePackageLock } from "./schema.ts";
import { activeGeneration, beginGeneration, managedDirectory, pinActive, publishGeneration, type Candidate } from "./package-generation.ts";
import { coupledFailures, writePackageLinks, writeSdk } from "./package-imports.ts";
import { installedPackages } from "./layout.ts";
import { embeddedPackage, materializePackage, problemLine, readRecord, type ResolvedPackage, resolvePackages, validateReplacement, verifiedCommit, writePackageSettings } from "./packages.ts";
import { lockFile, lockSections, packageLockChanges, readLockSection } from "./versions.ts";
import { beginReferencePublication } from "./reference-publication.ts";
import { readSnapshot, type ReferenceSnapshot } from "./reference-snapshot.ts";
import { applyPackages } from "./commands/sync.ts";
import { openCheckoutLease } from "./checkout-lease.ts";
import { collectAssets } from "../standard/opencode/assets.ts";
import { renameNoReplace } from "./no-replace.ts";

type Admission = {
  transaction: Candidate;
  office: Office;
  yaml: string;
  /** The candidate `packages:` section of office.lock, published with office.yaml (a Map, as an object here). */
  packages: Record<string, LockedPackage>;
  embedded: [string, string][];
  validate: string[];
  rejected: string[];
  exclude: boolean;
  apply: boolean;
  tracked: boolean;
};

type Outcome = { published: boolean; lines: string[]; rejected?: string[]; generation?: string };

function program() {
  return Bun.isStandaloneExecutable ? [process.execPath] : [process.execPath, "--no-install", join(import.meta.dir, "cli.ts")];
}

/** What the caller's BUN_OPTIONS was, for an evaluator to give back to the processes it starts. */
const callerOptions = "OFFICE_CALLER_BUN_OPTIONS";

/**
 * The compiled evaluator preserves symlinks, so a definition loaded through its set's link
 * resolves its imports inside that set. Only there: the CLI's own pnpm-installed dependencies
 * don't resolve under the flag, so the checkout's launcher and the first process never get it.
 */
function evaluatorEnv(): NodeJS.ProcessEnv {
  if (!Bun.isStandaloneExecutable) return process.env;
  const caller = process.env.BUN_OPTIONS;

  return { ...process.env, BUN_OPTIONS: [caller, "--preserve-symlinks"].filter(Boolean).join(" "), [callerOptions]: caller ?? "" };
}

/** In an evaluator, gives the processes it starts (package scripts, other tools) the caller's BUN_OPTIONS back. */
export function restoreCallerEnv() {
  const caller = process.env[callerOptions];

  if (caller === undefined) return;
  delete process.env[callerOptions];

  if (caller) process.env.BUN_OPTIONS = caller;
  else delete process.env.BUN_OPTIONS;
}

async function run(args: string[], fd: number) {
  const child = Bun.spawn([...program(), ...args], { env: evaluatorEnv(), stdio: ["inherit", "inherit", "inherit", fd] });

  const stop = () => child.kill("SIGINT");
  process.once("SIGINT", stop);

  try { return await child.exited; } finally { process.off("SIGINT", stop); }
}

/** Runs `args` in a reader bound to the published package set; undefined when the office has none. */
export async function runReader(dir: string, args: string[]) {
  using active = pinActive(dir);

  if (!active) return;
  const folder = managedDirectory(dir, active.name);

  // An office's first generation holds no selection until the first candidate publishes.
  if (!existsSync(join(folder, "selection.json"))) return;

  return run(["--package-reader", dir, active.name, ...args], active.fd);
}

/** Binds this process to generation `name`, recording the packages its last sync rejected, whose copies don't load. */
export function bindReader(dir: string, name: string) {
  const folder = managedDirectory(dir, name);
  const file = join(folder, "unavailable.json");
  const unavailable = new Set(existsSync(file) ? v.parse(v.array(v.string()), JSON.parse(readFileSync(file, "utf8"))) : []);
  bindPaths(dir, folder, unavailable);
}

/**
 * The commit to install a Git package at: its office.lock entry's while that entry has the
 * selected repo, path and ref (and, for a full-SHA ref, names that commit), else `published`, the
 * commit the previous reference generation bound it to.
 */
export function boundCommit(lock: PackageLock, entry: PackageEntry, published: string | undefined): string | undefined {
  const locked = entry.source && lock.get(entry.name);

  if (locked && locked.repo === entry.source?.repo && locked.path === entry.source.path && locked.ref === entry.source.ref && verifiedCommit(locked.ref, locked.commit)) return locked.commit;

  return published;
}

/**
 * office.lock's `packages:` section for a candidate: each selected Git package at the commit its
 * staged copy records. A package that failed keeps its previous entry with its previous copy;
 * deselected packages drop out.
 */
export function candidatePackageLock(selected: ResolvedPackage[], staged: string, rejected: string[], previous: PackageLock): PackageLock {
  const lock: PackageLock = new Map();

  for (const { entry, kind } of selected) {
    if (kind !== "remote" || !entry.source) continue;
    const record = rejected.includes(entry.name) ? undefined : readRecord(join(staged, entry.name));
    const { repo, path, ref } = entry.source;

    if (record && "repo" in record && record.repo === repo && record.path === path && record.ref === ref && verifiedCommit(ref, record.commit)) {
      lock.set(entry.name, { repo, path, ref, commit: record.commit.toLowerCase() });

      continue;
    }

    const kept = previous.get(entry.name);

    if (kept) lock.set(entry.name, kept);
  }

  return lock;
}

/**
 * Each Git package whose office.lock entry is missing, doesn't match office.yaml's repo, path and
 * ref, or names another commit than its installed copy records, and each entry for a package no
 * longer selected; office sync fixes each.
 */
export function packageLockProblems(office: Office): string[] {
  let lock: PackageLock;

  try {
    lock = readLockSection(office.dir, "packages");
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }

  const remote = resolvePackages(office).packages.filter(({ kind, entry }) => kind === "remote" && entry.source !== undefined);
  const selected = new Set(remote.map(({ entry }) => entry.name));
  const stale = [...lock.keys()].sort().filter((name) => !selected.has(name)).map((name) => `${lockFile} locks package ${name}, which office.yaml no longer selects from a Git repository (office sync removes the entry)`);

  return [...stale, ...remote.flatMap(({ entry, dir }) => {
    if (entry.source === undefined) return [];
    const locked = lock.get(entry.name);
    const { repo, path, ref } = entry.source;

    if (locked === undefined) return [`${lockFile} has no entry for package ${entry.name} (office sync locks its commit)`];

    if (locked.repo !== repo || locked.path !== path || locked.ref !== ref) {
      const differs = [locked.repo !== repo && "repo", locked.path !== path && "path", locked.ref !== ref && `ref (${locked.ref}, office.yaml ${ref})`].filter(Boolean).join(", ");

      return [`${lockFile} doesn't match office.yaml for package ${entry.name}: ${differs} (office sync resolves it again and rewrites the entry)`];
    }

    const record = readRecord(dir);

    if (record && "repo" in record && record.repo === repo && record.path === path && record.ref === ref && record.commit.toLowerCase() !== locked.commit) {
      return [`package ${entry.name} is installed at ${record.commit.slice(0, 12)}, but ${lockFile} locks ${locked.commit.slice(0, 12)} (office sync installs the locked commit)`];
    }

    return [];
  })];
}

async function prepareSources(office: Office, selection: ReturnType<typeof resolvePackages>, folder: string, previous: string, snapshot: ReferenceSnapshot | undefined, lock: PackageLock, commits: ReadonlyMap<string, string>, lines: string[]) {
  const packages = join(folder, "packages");
  mkdirSync(packages);
  const embedded: [string, string][] = [];
  const validate: string[] = [];
  const rejected: string[] = [];

  using deliveries = openCheckoutLease(office.dir, ".package-application");
  deliveries.acquire();

  for (const item of selection.packages) {
    if (item.kind === "local") continue;
    const old = join(previous, "packages", item.entry.name);
    const dir = join(packages, item.entry.name);

    if (lstatSync(old, { throwIfNoEntry: false })?.isSymbolicLink()) throw new OfficeError(`cannot materialize redirected package ${old}`);

    const published = boundRevision(snapshot, item.entry);
    const bound = commits.get(item.entry.name) ?? boundCommit(lock, item.entry, published);
    let copiedPrevious = false;

    try {
      if (existsSync(old)) {
        cpSync(old, dir, { recursive: true, verbatimSymlinks: true });
        copiedPrevious = true;
      }

      const materialized = await materializePackage(office, item, packages, bound);

      if (materialized.source) embedded.push([item.entry.name, materialized.source]);
      lines.push(...materialized.changes.map(line => line.replaceAll(relative(office.dir, packages), ".office/packages")));

      if (materialized.changes.some(line => line.startsWith("FAILED"))) {
        rejected.push(item.entry.name);
      } else if (materialized.changes.length) {
        validate.push(item.entry.name);

        if (published && published === bound && !existsSync(old)) {
          // Exact repair of a lost published Git source, independently of whether new
          // registrations are admitted. Never restore a floating tag or replace an entry.
          const record = readRecord(dir);

          if (record && "repo" in record && record.commit === bound) {
            const repair = join(folder, `repair-${item.entry.name}`);
            cpSync(dir, repair, { recursive: true, verbatimSymlinks: true });
            renameNoReplace(repair, old);
          }
        }
      }
    } catch (error) {
      rejected.push(item.entry.name);

      if (item.kind === "built-in") embedded.push([item.entry.name, (await embeddedPackage(item.entry.name)).source]);
      lines.push(`FAILED package ${item.entry.name}: ${String(error)}`);

      if (!copiedPrevious) rmSync(dir, { force: true, recursive: true });
    }

    item.dir = dir;
  }

  // Keep outstanding removal receipts with the candidate. After a crash or a deferred
  // apply, the previous generation need not stay pinned just to finish a seed withdrawal.
  const withdrawals = join(folder, "withdrawals");
  mkdirSync(withdrawals);
  const selected = new Set(selection.packages.map(pkg => pkg.entry.name));

  for (const source of ["withdrawals", "packages"]) {
    const parent = join(previous, source);

    if (!existsSync(parent)) continue;

    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || selected.has(entry.name)) continue;
      cpSync(join(parent, entry.name), join(withdrawals, entry.name), { recursive: true, verbatimSymlinks: true });
    }
  }

  return { embedded, validate, rejected };
}

/**
 * Stages and publishes the selected packages. An update can edit office.yaml (`yaml`) and move
 * untracked Git packages to other commits (`commits`); either way office.lock's `packages:`
 * section is published with the package set.
 */
export async function publishPackages(office: Office, exclude: boolean, update?: { yaml: (text: string) => string; apply: boolean; names: string[]; commits?: ReadonlyMap<string, string> }): Promise<Outcome> {
  const lines: string[] = [];
  const selection = resolvePackages(office);

  if (selection.problems.length) return { published: false, lines: selection.problems.map(p => `FAILED ${p.message}`) };
  using reservation = beginGeneration(office.dir);
  const { transaction } = reservation;
  const folder = managedDirectory(office.dir, transaction.name);
  const previous = managedDirectory(office.dir, transaction.previous);
  const temporary = mkdtempSync(join(tmpdir(), "office-admission-"));
  const old = selection.packages.map(item => item.kind === "local" ? item : { ...item, dir: join(previous, "packages", item.entry.name) });
  const coupled = (names: string[]) => update && update.names.length > 1 ? coupledFailures(names, update.names, [old, selection.packages]) : names;

  try {
    const yaml = update ? update.yaml(transaction.original) : transaction.original;
    const desired = loadOffice(office.dir, v.parse(officeSchema, parse(yaml, { stringKeys: true })));

    if (!Bun.deepEquals(desired, office)) throw new OfficeError("office.yaml changed while resolving packages; retry");
    const snapshot = readSnapshot(office.dir);

    if (!snapshot.ok) throw new OfficeError(`${snapshot.errors.join("; ")}; restore a readable generation, or verify installed Git pins before moving it aside and running office sync --packages`);
    const reserved = lockSections(transaction.lock).packages;

    if (!reserved.ok) throw reserved.error;
    const locked = reserved.value;
    const { embedded, validate, rejected } = await prepareSources(office, selection, folder, previous, snapshot.value, locked, update?.commits ?? new Map(), lines);

    if (update && rejected.length) return { published: false, lines, rejected: coupled(rejected) };
    const packages = candidatePackageLock(selection.packages, join(folder, "packages"), rejected, locked);
    writePackageLinks(folder, selection.packages, rejected);
    writeSdk(folder);
    writeFileSync(join(folder, "unavailable.json"), JSON.stringify(rejected));
    writeFileSync(join(folder, "selection.json"), JSON.stringify(office.packages.map(({ name, settings, cron, source }) => ({ name, settings, cron, ...source }))));
    const request: Admission = { office, transaction, yaml, packages: Object.fromEntries(packages), embedded, validate, rejected, exclude, tracked: !!update, apply: update?.apply ?? true };
    writeFileSync(join(temporary, "input"), JSON.stringify(request));
    const code = await run(["--package-admission", temporary], reservation.fd);

    if (code !== 0) throw new OfficeError(`package evaluator exited ${code}`);
    const result: Outcome = JSON.parse(readFileSync(join(temporary, "output"), "utf8"));
    lines.push(...result.lines);

    if (result.published) lines.push(...packageLockChanges(locked, packages));

    return { ...result, rejected: result.rejected && coupled(result.rejected), lines: result.published ? lines : lines.filter(line => line.startsWith("FAILED")) };
  } catch (error) {
    const published = activeGeneration(office.dir) === transaction.name;
    const reason = error instanceof Error ? error.message : String(error);

    return { published, lines: [`FAILED ${reason}${published ? `; generation ${transaction.name} is active, rerun office sync --packages to reconcile external files` : ""}`] };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    // A pending switch may need the candidate even when its publisher died.
  }
}

export async function evaluateAdmission(temporary: string) {
  const input: Admission = JSON.parse(readFileSync(join(temporary, "input"), "utf8"));
  const { transaction, office, yaml } = input;
  const packages = parsePackageLock(input.packages);

  if (!packages.ok) throw new OfficeError(`invalid candidate ${lockFile}: ${packages.errors.join("; ")}`);
  const folder = managedDirectory(office.dir, transaction.name);
  let published = false;
  let rejectedOwners: string[] | undefined;
  const lines: string[] = [];

  try {
    const owner = currentOffice({ office: office.dir });
    using application = openCheckoutLease(office.dir, ".package-application");

    const publication = beginReferencePublication(owner, snapshot => {
      // OpenCode registrations may depend on defaults that setup just supplied.
      for (const item of installed.installed) {
        if (input.validate.includes(item.entry.name) && item.manifest.opencode) collectAssets(office.dir, item);
      }

      const brokenReplacement = snapshot.contributors.find(group => group.stale && input.validate.includes(group.name) && existsSync(join(office.dir, ".office/packages", group.name)));

      if (brokenReplacement || (input.tracked && lines.some(line => line.startsWith("FAILED")))) {
        if (input.tracked) rejectedOwners = snapshot.contributors.flatMap(group => group.stale ? [group.name] : []);
        throw new OfficeError(`candidate failed collection${brokenReplacement ? `: ${brokenReplacement.name}` : ""}`);
      }

      application.acquire();

      for (const item of installed.installed) {
        if (item.kind !== "local") lines.push(...writePackageSettings(office, item).map(line => line.replace(relative(office.dir, folder) + "/packages", ".office/packages")));
      }

      writeFileSync(join(folder, "references.json"), JSON.stringify(snapshot, null, 2) + "\n");
      publishGeneration(transaction, yaml, packages.value);
      published = true;
    });

    if (!publication.ok) throw new OfficeError(publication.errors.join("; "));
    bindReader(office.dir, transaction.name);
    const selection = resolvePackages(office);
    const rejected = new Set(input.rejected);
    // Every copy, package.json, declared dependency and link is checked before the first import;
    // this sync's own rejections are already FAILED lines.
    const installed = installedPackages(office, rejected, false);

    if (installed.blocked) {
      lines.push(...installed.blocked.map(problem => `FAILED ${problemLine(problem)}`));

      // The packages the problems belong to; the caller's coupledFailures widens them to their dependents.
      if (input.tracked) rejectedOwners = [...new Set(installed.blocked.flatMap(problem => problem.packages))];
      throw new OfficeError("no package was loaded and no package set was published; fix the packages above and sync again");
    }

    // Every package's settings are checked before any setup runs, a candidate's or a collector's.
    if (installed.invalidSettings.length) {
      lines.push(...installed.invalidSettings.map(problem => `FAILED ${problemLine(problem)}`));

      if (input.tracked) rejectedOwners = [...new Set(installed.invalidSettings.flatMap(problem => problem.packages))];
      throw new OfficeError("no package was set up and no package set was published; fix the settings above and sync again");
    }

    for (const item of selection.packages) {
      if (!input.validate.includes(item.entry.name)) continue;

      try {
        await validateReplacement(office, item, false);
      } catch (error) {
        if (input.tracked) rejectedOwners = [item.entry.name];
        throw error;
      }
    }

    lines.push(...installed.problems.map(p => `FAILED package ${p.packages.join(", ")}: ${p.message}`));
    const conflicts = new Set<string>();

    const accepted = await collectReferences(office, selection.packages, installed, lines, publication.value, rejected, new Map(input.embedded), (...owners) => {
      for (const owner of owners) conflicts.add(owner);
    });

    // Only retry attributable admission failures. Never turn a lost writer ticket,
    // failed pointer switch, or failed application into a different publication.
    if (!accepted && input.tracked) rejectedOwners = [...conflicts];

    if (accepted && input.apply) {
      for (const item of installed.installed) {
        if (item.kind === "local") continue;
        const stable = join(office.dir, ".office/packages", item.entry.name);

        if (item.panel) item.panel = join(stable, relative(item.dir, item.panel));
        item.dir = stable;
      }

      const application: string[] = [];
      await applyPackages(office, installed, publication.value.previous, application, input.exclude, join(folder, "withdrawals"));
      lines.push(...application);

      if (application.some(line => line.startsWith("FAILED"))) lines.push(`generation ${transaction.name} is active; retry the incomplete application with office sync --packages`);
    }
  } catch (error) {
    lines.push(`FAILED ${published ? `generation ${transaction.name} is active; retry application with office sync --packages: ` : ""}${error instanceof Error ? error.message : String(error)}`);
  }

  writeFileSync(join(temporary, "output"), JSON.stringify({ published, lines, rejected: rejectedOwners, generation: published ? transaction.name : undefined } satisfies Outcome));
}
