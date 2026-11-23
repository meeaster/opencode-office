import { changeSchema, failure, isFailure, type Change } from "./change.ts";
import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { bindPaths } from "./bound-paths.ts";
import { loadOffice, type Office, OfficeError, type PackageEntry } from "./office.ts";
import { parse } from "yaml";
import * as v from "valibot";
import { type LockedPackage, officeSchema, type PackageLock, parsePackageLock } from "./schema.ts";
import { activeGeneration, beginGeneration, managedDirectory, pinActive, publishGeneration, type Candidate } from "./package-generation.ts";
import { coupledFailures, writePackageLinks, writeSdk } from "./package-imports.ts";
import { publishedView, type GatheredPackage, type GatherProblem, gatherPackages, problemLines } from "./gather.ts";
import { materializePackage, readRecord, type ResolvedPackage, resolvePackages, validateReplacement, sourceDifferences, verifiedCommit, writePackageSettings } from "./packages.ts";
import { lockFile, lockSections, packageLockChanges, readLockSection } from "./versions.ts";
import { writeAppliedReferences } from "./applied-references.ts";
import { applyPackages, SyncStopped } from "./package-application.ts";
import { claimAssetProblems, destinationProblems } from "../standard/mise-integration/projection.ts";
import { openCheckoutLease } from "./checkout-lease.ts";
import { validateAssets } from "../standard/opencode/assets.ts";
import { renameNoReplace } from "./no-replace.ts";
import { resultDescriptor } from "./command-stdout.ts";

type Admission = {
  transaction: Candidate;
  office: Office;
  yaml: string;
  /** The candidate `packages:` section of office.lock, published with office.yaml (a Map, as an object here). */
  packages: Record<string, LockedPackage>;
  validate: string[];
  rejected: string[];
  exclude: boolean;
  apply: boolean;
  tracked: boolean;
};

/**
 * Three outcomes: rejected before publishing (`published` false, the pointer where it was), published
 * and applied, or published with a failed application (FAILED lines). `recorded` is whether the
 * applied references file was written after the switch; without it no reference checkout is touched.
 * `stopped` is a package's sync function throwing: a full sync runs none of its later steps.
 * `committed`, the folders packages declare committed, and `excluded`, the paths their sync
 * functions exclude, are set only when the set was applied with every package loaded and no sync
 * function threw; without them the exclude block is left as it is.
 */
const outcomeSchema = v.object({
  published: v.boolean(),
  recorded: v.optional(v.boolean()),
  stopped: v.optional(v.boolean()),
  excluded: v.optional(v.array(v.string())),
  committed: v.optional(v.array(v.string())),
  lines: v.array(changeSchema),
  rejected: v.optional(v.array(v.string())),
  generation: v.optional(v.string()),
});

type Outcome = v.InferOutput<typeof outcomeSchema>;

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

/**
 * Runs an evaluator with `descriptors` after the standard three, and its exit status. With a pipe
 * as descriptor 4 (`resultDescriptor`), also what it wrote there, read while it runs so a large
 * result can't block it.
 */
async function run(args: string[], descriptors: (number | "pipe")[]) {
  const child = Bun.spawn([...program(), ...args], { env: evaluatorEnv(), stdio: ["inherit", "inherit", "inherit", ...descriptors] });
  const pipe = child.stdio[resultDescriptor] ?? undefined;
  const result = pipe === undefined ? undefined : new Response(Bun.file(pipe).stream()).bytes().finally(() => closeSync(pipe));

  const stop = () => child.kill("SIGINT");
  process.once("SIGINT", stop);

  try { return { status: await child.exited, result: await result }; } finally { process.off("SIGINT", stop); }
}

/**
 * Runs `args` in a reader bound to the published package set, and prints a package command's
 * result once the reader exits 0; undefined when the office has none.
 */
export async function runReader(dir: string, args: string[]) {
  using active = pinActive(dir);

  if (!active) return;
  const folder = managedDirectory(dir, active.name);

  // An office's first generation holds no selection until the first candidate publishes.
  if (!existsSync(join(folder, "selection.json"))) return;
  const { status, result } = await run(["--package-reader", dir, active.name, ...args], [active.fd, "pipe"]);

  if (status === 0 && result?.length) await Bun.write(Bun.stdout, result);

  return status;
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
 * selected repo, path and ref (and, for a full-SHA ref, names that commit). Without one, a matching
 * installed copy is kept from its source record, else the ref is resolved (`fetchPackage`).
 */
export function boundCommit(lock: PackageLock, entry: PackageEntry): string | undefined {
  const locked = lock.get(entry.name);

  if (locked && entry.source && !sourceDifferences(locked, entry.source).length && verifiedCommit(locked.ref, locked.commit)) return locked.commit;
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

    if (record && "repo" in record && !sourceDifferences(record, entry.source).length && verifiedCommit(ref, record.commit)) {
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
 * longer selected; office sync fixes each. An ownership conflict leaves out only the packages it
 * names, which check reports on its own; no definition is read.
 */
export function packageLockProblems(office: Office): string[] {
  let lock: PackageLock;

  try {
    lock = readLockSection(office.dir, "packages");
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }

  const remote = resolvePackages(office, undefined, true).packages.filter(({ kind, entry }) => kind === "remote" && entry.source !== undefined);
  // A Git entry a conflict leaves out is still selected: its lock entry isn't stale.
  const selected = new Set(office.packages.flatMap(({ name, source }) => source ? [name] : []));
  const stale = [...lock.keys()].sort().filter((name) => !selected.has(name)).map((name) => `${lockFile} locks package ${name}, which office.yaml no longer selects from a Git repository (office sync removes the entry)`);

  return [...stale, ...remote.flatMap(({ entry, dir }) => {
    if (entry.source === undefined) return [];
    const locked = lock.get(entry.name);
    const { ref } = entry.source;

    if (locked === undefined) return [`${lockFile} has no entry for package ${entry.name} (office sync locks its commit)`];

    const differences = sourceDifferences(locked, entry.source);

    if (differences.length) {
      const differs = differences.map(field => field === "ref" ? `ref (${locked.ref}, office.yaml ${ref})` : field).join(", ");

      return [`${lockFile} doesn't match office.yaml for package ${entry.name}: ${differs} (office sync resolves it again and rewrites the entry)`];
    }

    const record = readRecord(dir);

    if (record && "repo" in record && !sourceDifferences(record, entry.source).length && record.commit.toLowerCase() !== locked.commit) {
      return [`package ${entry.name} is installed at ${record.commit.slice(0, 12)}, but ${lockFile} locks ${locked.commit.slice(0, 12)} (office sync installs the locked commit)`];
    }

    return [];
  })];
}

const applicationLock = ".office/resolved/checkout-leases/.package-application.lock";

/** Opens and takes the lease that preparing and applying packages hold; failing either names the package application lock. */
function applicationLease(dir: string) {
  let lease: ReturnType<typeof openCheckoutLease> | undefined;

  try {
    lease = openCheckoutLease(dir, ".package-application");
    lease.acquire(`another office sync or package update holds ${applicationLock}; retry once it finishes`);

    return lease;
  } catch (error) {
    lease?.[Symbol.dispose]();

    throw new OfficeError(`cannot take the package application lock: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function prepareSources(office: Office, selection: ReturnType<typeof resolvePackages>, folder: string, previous: string, lock: PackageLock, commits: ReadonlyMap<string, string>, lines: Change[]) {
  const packages = join(folder, "packages");
  mkdirSync(packages);
  const validate: string[] = [];
  const rejected: string[] = [];

  using deliveries = applicationLease(office.dir);

  for (const item of selection.packages) {
    if (item.kind === "local") continue;
    const old = join(previous, "packages", item.entry.name);
    const dir = join(packages, item.entry.name);

    if (lstatSync(old, { throwIfNoEntry: false })?.isSymbolicLink()) throw new OfficeError(`cannot materialize redirected package ${old}`);

    const locked = boundCommit(lock, item.entry);
    const bound = commits.get(item.entry.name) ?? locked;
    let copiedPrevious = false;

    try {
      if (existsSync(old)) {
        cpSync(old, dir, { recursive: true, verbatimSymlinks: true });
        copiedPrevious = true;
      }

      const materialized = await materializePackage(office, item, packages, bound);

      lines.push(...materialized.changes);

      if (materialized.changes.some(isFailure)) {
        rejected.push(item.entry.name);
      } else if (materialized.changes.length) {
        validate.push(item.entry.name);

        if (locked && locked === bound && !existsSync(old)) {
          // Exact repair of a lost copy at its locked commit, independently of whether new
          // registrations are admitted. Never at an update's override or a floating tag.
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
      lines.push(failure(`FAILED package ${item.entry.name}: ${String(error)}`));

      if (!copiedPrevious) rmSync(dir, { force: true, recursive: true });
    }

    item.dir = dir;
  }

  // Keep outstanding withdrawals with the candidate. After a crash or a deferred apply, the
  // previous generation need not stay pinned just to finish removing a package's panel.
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

  return { validate, rejected };
}

/**
 * Stages and publishes the selected packages. An update can edit office.yaml (`yaml`) and move
 * untracked Git packages to other commits (`commits`); either way office.lock's `packages:`
 * section is published with the package set.
 */
export async function publishPackages(office: Office, exclude: boolean, update?: { yaml: (text: string) => string; apply: boolean; names: string[]; commits?: ReadonlyMap<string, string> }): Promise<Outcome> {
  const lines: Change[] = [];
  const selection = resolvePackages(office);

  if (selection.problems.length) return { published: false, lines: selection.problems.map(p => failure(`FAILED ${p.message}`)) };
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
    const reserved = lockSections(transaction.lock).packages;

    if (!reserved.ok) throw reserved.error;
    const locked = reserved.value;
    const { validate, rejected } = await prepareSources(office, selection, folder, previous, locked, update?.commits ?? new Map(), lines);

    if (update && rejected.length) return { published: false, lines, rejected: coupled(rejected) };
    const packages = candidatePackageLock(selection.packages, join(folder, "packages"), rejected, locked);
    writePackageLinks(folder, selection.packages, rejected);
    writeSdk(folder);
    writeFileSync(join(folder, "unavailable.json"), JSON.stringify(rejected));
    writeFileSync(join(folder, "selection.json"), JSON.stringify(office.packages.map(({ name, settings, source }) => ({ name, settings, ...source }))));
    const request: Admission = { office, transaction, yaml, packages: Object.fromEntries(packages), validate, rejected, exclude, tracked: !!update, apply: update?.apply ?? true };
    writeFileSync(join(temporary, "input"), JSON.stringify(request));
    const { status: code } = await run(["--package-admission", temporary], [reservation.fd]);

    if (code !== 0) throw new OfficeError(`package evaluator exited ${code}`);
    const result = v.parse(outcomeSchema, JSON.parse(readFileSync(join(temporary, "output"), "utf8")));
    lines.push(...result.lines);

    if (result.published) lines.push(...packageLockChanges(locked, packages));

    return { ...result, rejected: result.rejected && coupled(result.rejected), lines: result.published ? lines : lines.filter(isFailure) };
  } catch (error) {
    const published = activeGeneration(office.dir) === transaction.name;
    const reason = error instanceof Error ? error.message : String(error);

    return { published, lines: [failure(`FAILED ${reason}${published ? `; generation ${transaction.name} is active, rerun office sync --packages to reconcile external files` : ""}`)] };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    // A pending switch may need the candidate even when its publisher died.
  }
}

/** The problems admission finds beyond the gathering's: the files claims name, destinations across packages and every command name. */
function admissionProblems(office: Office, packages: GatheredPackage[], names: { owners: string[]; message: string }[]): GatherProblem[] {
  const problems: GatherProblem[] = [];

  for (const item of packages) {
    const owner = [item.entry.name];

    problems.push(...claimAssetProblems(item).map(message => ({ packages: owner, message })));
  }

  const owners = new Set<string>();
  const destinations = destinationProblems(office, packages, (...names) => { for (const name of names) owners.add(name); });

  if (destinations.length) problems.push(...destinations.map(message => ({ packages: [...owners], named: true as const, message })));
  problems.push(...names.map(problem => ({ packages: problem.owners, named: true as const, message: problem.message })));

  return problems;
}

export async function evaluateAdmission(temporary: string) {
  const input: Admission = JSON.parse(readFileSync(join(temporary, "input"), "utf8"));
  const { transaction, office, yaml } = input;
  const packages = parsePackageLock(input.packages);

  if (!packages.ok) throw new OfficeError(`invalid candidate ${lockFile}: ${packages.errors.join("; ")}`);
  const folder = managedDirectory(office.dir, transaction.name);
  let published = false;
  let recorded = false;
  let stopped = false;
  let committed: string[] | undefined;
  let excluded: string[] | undefined;
  let rejectedOwners: string[] | undefined;
  const lines: Change[] = [];

  try {
    bindReader(office.dir, transaction.name);
    const selection = resolvePackages(office);
    // This sync's fetch failures are already FAILED lines: they stay selected and unread.
    const gathered = await gatherPackages(office, { skip: new Set(input.rejected), machine: true });

    const refuse = (problems: GatherProblem[], reason: string) => {
      lines.push(...problemLines(problems).map(line => failure(`FAILED ${line}`)));

      // The packages the problems belong to; the caller's coupledFailures widens them to their dependents.
      if (input.tracked) rejectedOwners = [...new Set(problems.flatMap(problem => problem.packages))];

      return new OfficeError(reason);
    };

    // Every copy, package.json, declared dependency and link is checked before the first import.
    if (gathered.blocked) throw refuse(gathered.blocked, "no package was loaded and no package set was published; fix the packages above and sync again");

    // Every package's settings are checked before any setup runs.
    if (gathered.inventory.invalidSettings.length) throw refuse(gathered.inventory.invalidSettings, "no package was set up and no package set was published; fix the settings above and sync again");

    for (const item of selection.packages) {
      if (!input.validate.includes(item.entry.name)) continue;

      try {
        validateReplacement(office, item);
      } catch (error) {
        throw refuse([{ packages: [item.entry.name], message: error instanceof Error ? error.message : String(error) }], "no package set was published");
      }
    }

    // A changed copy's OpenCode registrations must name files of its own before it is published,
    // even while another package is unread.
    for (const item of gathered.packages) {
      const paths = gathered.assets.get(item.entry.name);

      if (!input.validate.includes(item.entry.name) || paths === undefined) continue;

      try {
        validateAssets(office.dir, item.dir, paths);
      } catch (error) {
        throw refuse([{ packages: [item.entry.name], message: `OpenCode registration: ${error instanceof Error ? error.message : String(error)}` }], "no package set was published");
      }
    }

    const problems = [...gathered.problems, ...admissionProblems(office, gathered.packages, gathered.names)];

    if (problems.length) throw refuse(problems, "no package set was published; fix or deselect the packages above and sync again");

    // Held through the switch, the applied references and the application, apply: false included.
    using application = applicationLease(office.dir);

    for (const item of gathered.packages) {
      if (item.kind !== "local") lines.push(...writePackageSettings(office, item).map(line => line.replace(relative(office.dir, folder) + "/packages", ".office/packages")));
    }

    publishGeneration(transaction, yaml, packages.value);
    published = true;

    try {
      writeAppliedReferences(office.dir, gathered.references);
      recorded = true;
    } catch (error) {
      lines.push(failure(`FAILED the references were not recorded (${error instanceof Error ? error.message : String(error)}), so no reference checkout is cloned or updated; run office sync again`));
    }

    if (input.apply) {
      // Lines a step returned before one threw are still reported.
      const applied: Change[] = [];

      try {
        excluded = await applyPackages(office, publishedView(office, gathered), applied, input.exclude, join(folder, "withdrawals"));
      } finally {
        lines.push(...applied);
      }

      if (!gathered.unread.size) committed = gathered.committed;

      if (applied.some(isFailure)) lines.push(`generation ${transaction.name} is active; retry the incomplete application with office sync --packages`);
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);

    stopped = error instanceof SyncStopped;

    if (stopped) lines.push(failure(`FAILED ${text}; the new package set is active and the rest of this sync did not run: fix the package, then run office sync again`));
    else lines.push(failure(`FAILED ${published ? `generation ${transaction.name} is active; retry application with office sync --packages: ` : ""}${text}`));
  }

  writeFileSync(join(temporary, "output"), JSON.stringify({ published, recorded, stopped, committed, excluded, lines, rejected: rejectedOwners, generation: published ? transaction.name : undefined } satisfies Outcome));
}
