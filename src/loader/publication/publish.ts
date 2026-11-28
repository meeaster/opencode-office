import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";
import * as v from "valibot";
import { failure, isFailure, type Change } from "../../lib/change.ts";
import { loadOffice, type Office, OfficeError } from "../../office.ts";
import { officeSchema } from "../../schema.ts";
import type { PackageLock } from "../../lock-schema.ts";
import { packageDeliveryDir } from "../../bound-paths.ts";
import { lockFile, lockSections, packageLockChanges, readLockSection, readLockText } from "../../versions.ts";
import { blockInstalledFallback, writePackageLinks, writeSdk } from "../installed/links.ts";
import { selectionText } from "../installed/reader.ts";
import { installedRoot, installedSelection } from "../installed/paths.ts";
import { readRecord, sourceDifferences } from "../sources/copies.ts";
import { importEdges, readPackageJson, sdkName } from "../sources/manifest.ts";
import { type ResolvedPackage, resolvePackages } from "../sources/selection.ts";
import { runEvaluator } from "../worker.ts";
import { candidatePackageLock } from "./candidate-lock.ts";
import { checkDestinations } from "./install.ts";
import { type Admission, type Outcome, outcomeSchema } from "./protocol.ts";
import { prepareSources } from "./stage.ts";

/**
 * Stages and publishes the selected packages. An update can edit office.yaml (`yaml`) and move
 * untracked Git packages to other commits (`commits`); either way office.lock's `packages:`
 * section is published with the package set.
 */
export async function publishPackages(office: Office, exclude: boolean, update?: { yaml: (text: string) => string; apply: boolean; names: string[]; commits?: ReadonlyMap<string, string> }): Promise<Outcome> {
  const lines: Change[] = [];
  const selection = resolvePackages(office);

  if (selection.problems.length) return { published: false, lines: selection.problems.map(p => failure(`FAILED ${p.message}`)) };
  const previous = installedRoot(office.dir);
  const old = selection.packages.map(item => ({ ...item }));
  const coupled = (names: string[]) => update && update.names.length > 1 ? coupledFailures(names, update.names, [old, selection.packages]) : names;
  let folder: string | undefined;

  try {
    checkDestinations(office.dir);
    const original = readFileSync(join(office.dir, "office.yaml"), "utf8");
    const lock = readLockText(office.dir);
    const reserved = lockSections(lock).packages;

    if (!reserved.ok) throw reserved.error;
    mkdirSync(join(previous, "tmp"), { recursive: true });
    folder = mkdtempSync(join(previous, "tmp/package-stage-"));
    const transaction = { dir: office.dir, folder, original, lock, installed: installedSelection(office.dir) };
    const yaml = update ? update.yaml(transaction.original) : transaction.original;
    const desired = loadOffice(office.dir, v.parse(officeSchema, parse(yaml, { stringKeys: true })));

    if (!Bun.deepEquals(desired, office)) throw new OfficeError("office.yaml changed while resolving packages; retry");
    const locked = reserved.value;
    const { validate, rejected } = await prepareSources(office, selection, folder, previous, locked, update?.commits ?? new Map(), lines);

    if (update && rejected.length) return { published: false, lines, rejected: coupled(rejected) };
    const packages = candidatePackageLock(selection.packages, join(folder, "packages"), rejected, locked);

    const evaluation = selection.packages.map(item => {
      if (Bun.isStandaloneExecutable || item.kind !== "local" || !existsSync(item.dir)) return item;
      const dir = join(transaction.folder, "local", item.entry.name);

      // Source Bun follows symlinks to load pnpm's dependencies. Give local modules a real
      // path under the candidate so their imports also use the candidate's node_modules.
      cpSync(item.dir, dir, { recursive: true, verbatimSymlinks: true, filter: path => ![".git", "node_modules"].includes(basename(path)) });

      return { ...item, dir };
    });

    writePackageLinks(folder, evaluation, rejected);
    writeSdk(folder);
    blockInstalledFallback(folder, previous, rejected);
    const delivery = join(folder, "installed-links");
    const installed = selection.packages.map(item => ({ ...item, dir: packageDeliveryDir(office.dir, item) }));

    writePackageLinks(delivery, installed, rejected, previous);
    writeSdk(delivery);
    writeFileSync(join(folder, "unavailable.json"), JSON.stringify(rejected));
    writeFileSync(join(folder, "selection.json"), selectionText(office));
    const request: Admission = { office, transaction, yaml, packages: Object.fromEntries(packages), validate, rejected, exclude, tracked: !!update, apply: update?.apply ?? true };
    writeFileSync(join(folder, "input"), JSON.stringify(request));
    const code = await runEvaluator(["--package-admission", folder]);

    if (code !== 0) throw new OfficeError(`package evaluator exited ${code}`);
    const result = v.parse(outcomeSchema, JSON.parse(readFileSync(join(folder, "output"), "utf8")));
    lines.push(...result.lines);

    if (result.published) lines.push(...packageLockChanges(locked, packages));

    return { ...result, rejected: result.rejected && coupled(result.rejected), lines: result.published ? lines : lines.filter(isFailure) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    return { published: false, lines: [failure(`FAILED ${reason}; run office sync again`)] };
  } finally {
    if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
  }
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

/**
 * Each present package's import edges in this view: its declared office dependencies and its
 * optional providers the view selects, whether or not their copies are present. Throws when a
 * package.json can't be read.
 */
function declaredDependencies(packages: ResolvedPackage[]) {
  const graph = new Map<string, Set<string>>();
  const selected = new Set(packages.map(pkg => pkg.entry.name));

  for (const pkg of packages) {
    if (!existsSync(pkg.dir)) continue;
    const read = readPackageJson(pkg.dir, pkg.entry.name);

    if (!read.ok) throw new Error(read.errors.join("; "));
    // @office/sdk is no package, so it couples nothing.
    graph.set(pkg.entry.name, new Set(importEdges(read.value, selected).filter(name => name !== sdkName)));
  }

  return graph;
}

/**
 * Which of the `pending` packages an update must hold back, given those `rejected`: each that
 * depends on a rejected one, or that a rejected one depends on, in either view's import edges
 * (selected optional providers included). An unreadable package.json is not evidence of independence: all are held back.
 */
function coupledFailures(rejected: string[], pending: string[], views: ResolvedPackage[][]) {
  try {
    const graphs = views.map(declaredDependencies);
    const failed = new Set(rejected.filter(name => pending.includes(name)));

    const reachable = (from: string) => {
      const seen = new Set([from]);

      for (const name of seen) for (const graph of graphs) for (const dependency of graph.get(name) ?? []) seen.add(dependency);

      return seen;
    };

    const paths = new Map(pending.map(name => [name, reachable(name)]));

    for (const name of failed) {
      for (const [peer, imports] of paths) if (imports.has(name) || paths.get(name)?.has(peer)) failed.add(peer);
    }

    return [...failed];
  } catch {
    return pending;
  }
}
