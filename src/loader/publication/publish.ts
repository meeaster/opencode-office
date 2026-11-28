import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import * as v from "valibot";
import { failure, isFailure, type Change } from "../../lib/change.ts";
import { loadOffice, type Office, OfficeError } from "../../office.ts";
import { officeSchema } from "../../schema.ts";
import type { PackageLock } from "../../lock-schema.ts";
import { lockFile, lockSections, packageLockChanges, readLockSection } from "../../versions.ts";
import { writePackageLinks, writeSdk } from "../generation/links.ts";
import { selectionText } from "../generation/reader.ts";
import { activeGeneration, beginGeneration, managedDirectory } from "../generation/storage.ts";
import { readRecord, sourceDifferences } from "../sources/copies.ts";
import { importEdges, readPackageJson, sdkName } from "../sources/manifest.ts";
import { type ResolvedPackage, resolvePackages } from "../sources/selection.ts";
import { runEvaluator } from "../worker.ts";
import { candidatePackageLock } from "./candidate-lock.ts";
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
    writeFileSync(join(folder, "selection.json"), selectionText(office));
    const request: Admission = { office, transaction, yaml, packages: Object.fromEntries(packages), validate, rejected, exclude, tracked: !!update, apply: update?.apply ?? true };
    writeFileSync(join(temporary, "input"), JSON.stringify(request));
    const code = await runEvaluator(["--package-admission", temporary], [reservation.fd]);

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
