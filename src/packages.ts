// Packages: capabilities an office opts into, each a folder with a definition and whatever it
// registers, such as an OpenCode plugin, package-owned scripts and a desktop app panel (src/desktop.ts). There are three kinds, by where a package comes from:
//
// - built-in: shipped inside the `office` executable (the tool's packages/), listed by name alone,
//   and replaced whenever it differs from the executable's copy. `office` is always installed.
// - remote: copied from a folder of another repository at a ref, and replaced when the ref moves.
// - local: written in the office, in `packages/<name>/`.
//
// Built-in and remote packages are pulled into `.office/packages/<name>/` and are read-only: the
// hash of each file is recorded in `.source.json`, `office check` reports an edit and `office
// sync` restores the copy. Only local packages are committed with the office; `.office/packages/` is not, so
// a clone's first sync restores built-ins from the executable and fetches each remote package at
// the commit office.lock locks for it.
import { failure, type Change } from "./change.ts";
import { boundUnavailable, definitionRoot, linkProblem, packageRoot, pulledFolder } from "./bound-paths.ts";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import * as v from "valibot";

import { copyFromRepository } from "./git.ts";
import { type Office, OfficeError, type PackageEntry } from "./office.ts";
import { readDefinition } from "./package-definition.ts";
import type { OptionalIntegration } from "./package-integrations.ts";
import { importEdges, readPackageJson, scope, sdkName } from "./package-manifest.ts";
import { composeProblems, packageComposeFile } from "../standard/compose/services.ts";
import { settingsEnv } from "../standard/compose/services.ts";
import { gateDefaultProblem, systemSection } from "../standard/mise-integration/system.ts";
import { check, MalformedSettings, type PackageManifest, type Parsed, type SettingValue, settingVariable } from "./schema.ts";
import { sha256 } from "./hash.ts";
import { build, buildCommit, builtinFiles, builtinPackages } from "./tool.ts";

/** Where a pulled-in package records where it came from and the hash of each of its files. */
export const sourceFile = ".source.json";

/**
 * What the office declares that any package's plugin and scripts may read, kept apart from its
 * settings (the office's applied settings snapshot, `src/applied-settings.ts`):
 * `{ "opencode": "host" | "container" }`, office.yaml's mode. `office sync` writes it into each
 * package folder, and a local package's copy is committed.
 */
export const officeFile = ".office.json";

/** The office's own records in a package folder, left out of its file hashes. */
const records = [sourceFile, officeFile];

const sdkReserved = `the name ${sdkName} is reserved for ${scope}${sdkName}; rename the package`;

/** The built-in packages every office has, without an entry in office.yaml. */
export const requiredPackages = ["tooling", "tools", "mise-integration", "opencode", "office", "references", "seeds", "cron"];

/** The names of the packages `office` selects: the required built-ins and each office.yaml entry, whether or not it resolves or loads. */
export function selectedNames(office: Pick<Office, "packages">): Set<string> {
  return new Set([...requiredPackages, ...office.packages.map(entry => entry.name)]);
}

const files = v.record(v.string(), v.string());

/** A copy from a repository: where it came from, and when it was copied. */
const remoteRecord = v.object({ repo: v.string(), path: v.string(), ref: v.string(), commit: v.string(), files, copied: v.optional(v.string()) });

/** A built-in copy: the `office` version and commit that wrote it. */
const builtinRecord = v.object({ office: v.string(), commit: v.string(), files });

const recordSchema = v.union([remoteRecord, builtinRecord]);

export type PackageRecord = v.InferOutput<typeof recordSchema>;

type PackageKind = "built-in" | "remote" | "local";

/** A package the office has, with the source folder to read (possibly bound or staged). */
export type ResolvedPackage = { entry: PackageEntry; kind: PackageKind; dir: string };

/** Why a package isn't installed, or its plugin isn't linked. */
export type PackageProblem = { packages: string[]; message: string };

/** The packages an office has, and the entries of office.yaml that can't be one. */
export type ResolvedPackages = { packages: ResolvedPackage[]; problems: PackageProblem[] };

export type InstalledPackage = ResolvedPackage & {
  manifest: PackageManifest;
  /** The settings with defaults applied, as runtimes read them from the office's applied settings snapshot. */
  settings: Record<string, SettingValue>;
  /** Its optional integrations, each with its module, whether or not its provider is selected. */
  integrations: readonly OptionalIntegration[];
};

/** The folder of a built-in or remote package. */
export function pulledDir(office: Pick<Office, "dir">, name: string): string {
  return join(packageRoot(office.dir), name);
}

/** The folder of a package written in the office. */
function localDir(office: Pick<Office, "dir">, name: string): string {
  return join(office.dir, "packages", name);
}

function folders(dir: string): string[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
}

/** The package folders in `.office/packages/`, declared or not. */
export function pulledFolders(office: Office): string[] {
  return folders(join(office.dir, pulledFolder));
}

/** The package folders in `packages/`, declared or not; `node_modules/` holds sync's editor link. */
export function localFolders(office: Office): string[] {
  return folders(join(office.dir, "packages")).filter((name) => name !== "node_modules");
}

function ownershipProblems(office: Pick<Office, "dir" | "packages">, builtins: string[], only?: string, live = false): PackageProblem[] {
  const problems: PackageProblem[] = [];

  for (const name of selectedNames(office)) {
    if (only !== undefined && name !== only) continue;

    if (!builtins.includes(name)) continue;

    const entry = office.packages.find(item => item.name === name);
    const local = localDir(office, name);

    if (existsSync(local)) problems.push({ packages: [name], message: `built-in package ${name} conflicts with local ${relative(office.dir, local)}; rename one before syncing` });

    if (entry?.source) problems.push({ packages: [name], message: `built-in package ${name} conflicts with ${entry.source.repo}@${entry.source.ref}:${entry.source.path}; rename one before syncing` });
    else {
      const installed = readRecord(pulledDir(office, name));

      if (installed && "repo" in installed) problems.push({ packages: [name], message: `built-in package ${name} conflicts with installed ${installed.repo}@${installed.ref}:${installed.path}; move the existing copy before syncing` });

      // A live load leaves such a copy to fail its own source check.
      if (!live && requiredPackages.includes(name) && name !== "office" && !installed && existsSync(pulledDir(office, name))) {
        problems.push({ packages: [name], message: `cannot establish ownership of ${pulledFolder}/${name}; restore its source record or move the existing copy before syncing` });
      }
    }
  }

  return problems;
}

export function requirePackageOwnership(office: Office): void {
  const collisions = ownershipProblems(office, builtinPackages());

  if (collisions.length) throw new OfficeError(collisions.map(problem => problem.message).join("\n"));
}

/**
 * The packages the office has: the required built-ins, then each entry of office.yaml, with its
 * kind. An entry without `repo` is built-in when the tool ships a package of its name, so those
 * names are reserved. A required built-in's entry configures it without installing it twice.
 * Ownership problems leave no packages, unless `live` (the gathering): then only the packages
 * they name are left out.
 */
export function resolvePackages(office: Pick<Office, "dir" | "packages">, only?: string, live = false): ResolvedPackages {
  const builtins = builtinPackages();
  const problems = ownershipProblems(office, builtins, only, live);
  const excluded = new Set(problems.flatMap(problem => problem.packages));

  if (problems.length && !live) return { packages: [], problems };

  const packages: ResolvedPackage[] = requiredPackages.flatMap((name) => (only !== undefined && name !== only) || excluded.has(name) ? [] : [{
    entry: office.packages.find((entry) => entry.name === name) ?? { name, settings: {}, source: undefined },
    kind: "built-in",
    dir: pulledDir(office, name),
  }]);

  for (const entry of office.packages) {
    const problem = (message: string) => problems.push({ packages: [entry.name], message });

    if ((only !== undefined && entry.name !== only) || requiredPackages.includes(entry.name) || excluded.has(entry.name)) continue;

    // Its link would take the SDK's place in the package set.
    if (entry.name === sdkName) {
      problem(sdkReserved);
      continue;
    }

    if (!builtins.includes(entry.name)) {
      packages.push({ entry, kind: entry.source === undefined ? "local" : "remote", dir: entry.source === undefined ? localDir(office, entry.name) : pulledDir(office, entry.name) });

      continue;
    }

    packages.push({ entry, kind: "built-in", dir: pulledDir(office, entry.name) });
  }

  return { packages, problems };
}

/** Every file under `dir` as a path relative to it, sorted. */
function filesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

/** The SHA-256 of each package file, leaving out the office's own records. */
export function fileHashes(dir: string): PackageRecord["files"] {
  const hashes: PackageRecord["files"] = {};

  for (const file of filesIn(dir)) {
    if (!records.includes(file)) hashes[file] = sha256(readFileSync(join(dir, file)));
  }

  return hashes;
}

/** A JSON file checked against `schema`; a file that doesn't parse is an error too. */
function readJson<Schema extends v.GenericSchema>(path: string, schema: Schema): Parsed<v.InferOutput<Schema>> {
  let document;

  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }

  return check(v.safeParse(schema, document));
}

/** The record of a pulled-in package, or undefined for a folder without a readable one. */
export function readRecord(dir: string): PackageRecord | undefined {
  const path = join(dir, sourceFile);

  if (!existsSync(path)) return undefined;

  const result = readJson(path, recordSchema);

  return result.ok ? result.value : undefined;
}

/** Package files that differ from the copy the record describes, each with what happened to it. */
export function localEdits(dir: string, record: Pick<PackageRecord, "files">): string[] {
  const now = fileHashes(dir);

  return [
    ...Object.keys(record.files).flatMap((file) => (now[file] === undefined ? [`${file} (removed)`] : now[file] === record.files[file] ? [] : [`${file} (edited)`])),
    ...Object.keys(now).flatMap((file) => (record.files[file] === undefined ? [`${file} (added)`] : [])),
  ];
}

/** What a record says the copy is, for messages. */
export function describeRecord(record: PackageRecord): string {
  return "repo" in record ? `${record.repo} ${record.path} at ${record.commit.slice(0, 12)} (ref ${record.ref})` : `the built-in copy of office ${record.office} (commit ${record.commit.slice(0, 12)})`;
}

/** How to change a package pulled into the office, which is read-only. */
export const readOnlyNote = "packages in .office/packages/ are read-only: to change one, copy it into packages/<another name>/ and list that instead";

/** Writes one of the office's records in a package folder. */
function writeJson(path: string, value: PackageRecord): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Fills a new copy of the package folder `dir` with `fill`, beside it, then swaps it in, so a
 * failed copy leaves the installed one as it was. The office's mode record stays: sync reports it
 * only when the mode changes.
 */
async function replaceFolder<Result>(dir: string, fill: (staging: string) => Result, commitPin?: () => void): Promise<Awaited<Result>> {
  mkdirSync(dirname(dir), { recursive: true });
  const staging = mkdtempSync(join(dirname(dir), `.${basename(dir)}.new-`));

  try {
    const result = await fill(staging);

    if (existsSync(join(dir, officeFile))) copyFileSync(join(dir, officeFile), join(staging, officeFile));

    const backup = existsSync(dir) ? mkdtempSync(join(dirname(dir), `.${basename(dir)}.old-`)) : undefined;

    if (backup) renameSync(dir, backup);

    try {
      renameSync(staging, dir);
      commitPin?.();
    } catch (error) {
      if (!existsSync(staging)) renameSync(dir, staging);

      if (backup) renameSync(backup, dir);
      throw error;
    }

    if (backup) rmSync(backup, { recursive: true, force: true });

    return result;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function builtinRecordFor(hashes: PackageRecord["files"]): PackageRecord {
  return { office: build().version, commit: buildCommit().sha, files: hashes };
}

/** This executable's copy of the built-in packages, for messages. */
function thisCopy(): string {
  return describeRecord(builtinRecordFor({}));
}

export function builtinSource(hashes: PackageRecord["files"]): string {
  return `built-in:${filesDigest(hashes)}`;
}

function filesDigest(hashes: PackageRecord["files"]): string {
  return sha256(JSON.stringify(Object.keys(hashes).sort().map(path => [path, hashes[path]])));
}

/** What a Git selection is: its repository, path and ref. */
export function gitSelection(source: NonNullable<PackageEntry["source"]>) {
  return `git:${sha256(JSON.stringify([source.repo, source.path, source.ref]))}`;
}

async function embeddedPackage(name: string) {
  const wanted = await builtinFiles(name);
  const hashes = Object.fromEntries([...wanted].map(([file, content]) => [file, sha256(content)]));

  return { wanted, hashes };
}

async function installBuiltinFiles(entry: PackageEntry, dir: string, wanted: Map<string, string>, hashes: PackageRecord["files"]) {
  const where = join(".office/packages", entry.name);
  const record = readRecord(dir);

  if (existsSync(dir) && Bun.deepEquals(fileHashes(dir), hashes)) {
    if (record !== undefined && !("repo" in record) && Bun.deepEquals(record.files, hashes)) return [];

    writeJson(join(dir, sourceFile), builtinRecordFor(hashes));

    return [`recorded ${where} as ${thisCopy()}`];
  }

  const edits = record === undefined ? [] : localEdits(dir, record);

  await replaceFolder(dir, async (staging) => {
    for (const [file, content] of wanted) {
      mkdirSync(dirname(join(staging, file)), { recursive: true });
      writeFileSync(join(staging, file), content);
    }

    writeJson(join(staging, sourceFile), builtinRecordFor(hashes));
  });

  if (record === undefined) return [`installed ${where}, the built-in ${entry.name} package`];

  if (edits.length > 0) return [`restored ${where}, undoing edits to ${edits.join(", ")}; ${readOnlyNote}`];

  return [`updated ${where} from ${describeRecord(record)} to ${thisCopy()}`];
}

const sourceFields = ["repo", "path", "ref"] as const;

type GitSource = Pick<NonNullable<PackageEntry["source"]>, typeof sourceFields[number]>;

export function sourceDifferences(record: GitSource, selected: GitSource) {
  return sourceFields.filter(field => record[field] !== selected[field]);
}

/** A full commit SHA. */
export const fullCommit = /^[a-f0-9]{40}$/i;

/** Whether `commit` is a full SHA, and the one `ref` names when `ref` is a full SHA itself. */
export function verifiedCommit(ref: string, commit: string): boolean {
  return fullCommit.test(commit) && (!fullCommit.test(ref) || ref.toLowerCase() === commit.toLowerCase());
}

/**
 * Copies or updates a package declared with a repository into `.office/packages/<name>/`: it
 * installs a missing one, replaces one whose record differs from the entry's repository, path or
 * ref, and restores one whose files were edited. Returns one line per change; a failure starts
 * with FAILED.
 */
export async function fetchPackage(office: Office, entry: PackageEntry, source: NonNullable<PackageEntry["source"]>, boundCommit?: string, commitPin?: () => void, destination?: string): Promise<Change[]> {
  const { name } = entry;
  const dir = destination ?? pulledDir(office, name);
  const where = join(".office/packages", name);
  const record = readRecord(dir);
  const current = record !== undefined && "repo" in record && !sourceDifferences(record, source).length;
  const edits = record === undefined ? [] : localEdits(dir, record);

  const known = current && verifiedCommit(source.ref, record.commit) && (!boundCommit || record.commit === boundCommit);
  const revision = boundCommit ?? (known ? record.commit : source.ref);

  try {
    if (boundCommit && !verifiedCommit(source.ref, boundCommit)) throw new Error(`invalid reference generation binding ${boundCommit} for ${source.ref}`);

    if (known && edits.length === 0) {
      commitPin?.();

      return [];
    }

    if (!boundCommit && (record === undefined || (current && !known)) && existsSync(dir) && readdirSync(dir).length > 0 && !fullCommit.test(source.ref)) {
      throw new Error(`cannot repair from ${source.ref} without the recorded commit; restore ${where}/${sourceFile} from office history or pin a full commit SHA`);
    }

    const commit = await replaceFolder(dir, async (staging) => {
      const copied = copyFromRepository({ ...source, ref: revision }, staging);

      if (!verifiedCommit(revision, copied)) throw new Error(`expected ${revision}, got ${copied}`);

      // A package shared from another office's packages/ carries that office's records; its
      // records describe that office, not this one.
      for (const file of records) rmSync(join(staging, file), { force: true });

      writeJson(join(staging, sourceFile), { repo: source.repo, path: source.path, ref: source.ref, commit: copied, files: fileHashes(staging), copied: new Date().toISOString() });

      return copied;
    }, commitPin);

    if (record === undefined) return [`installed ${where} from ${source.repo} at ${commit}`];

    if (current && !known) return [`restored ${where} to ${commit} for ${source.ref}; its record named commit ${record.commit}`];

    if (current) return [`restored ${where} to its copy of ${source.ref}${commit === source.ref ? "" : ` (${commit})`}, undoing edits to ${edits.join(", ")}; ${readOnlyNote}`];

    return [`updated ${where} from ${describeRecord(record)} to ${source.ref} (${commit})`];
  } catch (error) {
    return [failure(`FAILED ${where} from ${source.repo}:${source.path} @ ${source.ref} (revision ${revision}): ${error instanceof Error ? error.message.trim() : String(error)}`)];
  }
}

/** Materialization does no evaluation. All managed peers live at their final paths
 * before a fresh process loads the first definition. */
export async function materializePackage(office: Office, item: ResolvedPackage, folder: string, bound?: string) {
  const dir = join(folder, item.entry.name);

  if (item.kind === "built-in") {
    const { wanted, hashes } = await embeddedPackage(item.entry.name);

    return { changes: await installBuiltinFiles(item.entry, dir, wanted, hashes) };
  }

  if (!item.entry.source) throw new Error(`missing source for ${item.entry.name}`);

  return { changes: await fetchPackage(office, item.entry, item.entry.source, bound, undefined, dir) };
}

/**
 * Removes a pulled-in package whose entry left office.yaml: its folder goes, unless `retained`
 * names a copy kept elsewhere. Returns one line per change.
 */
export function removePackage(office: Office, name: string, retained?: string): string[] {
  if (!retained) rmSync(pulledDir(office, name), { recursive: true });

  return [`removed ${join(pulledFolder, name)}/, which office.yaml no longer lists`];
}

/** Check the installed source before importing any code. */
export function installedDefinition(office: Pick<Office, "dir">, resolved: ResolvedPackage) {
  return readDefinition(resolved.dir, resolved.entry.name, relative(office.dir, resolved.dir), { verifyCopy: () => verifyInstalledCopy(resolved), root: definitionRoot(office.dir, resolved) });
}

/** A pulled-in copy must match its record; a local package isn't checked. */
function verifyInstalledCopy({ kind, entry, dir }: ResolvedPackage) {
  if (kind === "local") return;

  const record = readRecord(dir);

  if (record === undefined) throw new Error(`no readable ${sourceFile}; ${kind === "built-in" ? "office sync restores the built-in copy" : "restore it from office history or run office sync with an exact pin"}`);

  if (kind === "built-in" && "repo" in record) throw new Error("the installed copy is remote, not built-in; run office sync");

  if (kind === "remote" && !("repo" in record && entry.source && !sourceDifferences(record, entry.source).length)) {
    throw new Error("the installed copy is not from the selected source and ref; run office sync");
  }

  if ("repo" in record && !verifiedCommit(record.ref, record.commit)) throw new Error(`invalid recorded commit ${record.commit} for ${record.ref}; run office sync`);

  const edits = localEdits(dir, record);

  if (edits.length > 0) throw new Error(`package files edited: ${edits.join(", ")}; office sync restores them`);

  return record;
}

/** The pulled-in packages among `packages` that the set's sync `rejected`: they stay selected, get no link and don't load. */
function rejectedPackages(packages: ResolvedPackage[], rejected: ReadonlySet<string>) {
  return packages.filter(pkg => pkg.kind !== "local" && rejected.has(pkg.entry.name));
}

/**
 * Every problem in `packages` found without importing anything: a pulled-in package not copied
 * yet, a copy that differs from its record, a package.json that can't be read, and a declared
 * dependency that office.yaml doesn't select (the required built-ins always are). A package in
 * `skip` isn't checked. Each problem names its package; messages don't repeat the name.
 */
export function selectionProblems(office: Pick<Office, "packages">, packages: ResolvedPackage[], skip: ReadonlySet<string> = new Set()): PackageProblem[] {
  const selected = selectedNames(office);
  const problems: PackageProblem[] = [];

  for (const pkg of packages) {
    const { name } = pkg.entry;

    if (skip.has(name)) continue;
    const fail = (message: string) => problems.push({ packages: [name], message });

    if (pkg.kind !== "local") {
      if (!existsSync(pkg.dir)) {
        fail("not synced yet; run office sync");
        continue;
      }

      try {
        verifyInstalledCopy(pkg);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
        continue;
      }
    }

    const json = readPackageJson(pkg.dir, name, pkg.kind);

    if (!json.ok) {
      for (const error of json.errors) fail(error);
      continue;
    }

    for (const dependency of json.value.dependencies) {
      if (dependency === sdkName) fail(`lists ${scope}${sdkName} in office.dependencies; ${scope}${sdkName} is always available, so remove it`);
      else if (!selected.has(dependency)) fail(`depends on ${scope}${dependency}, which isn't selected; add it to office.yaml`);
    }
  }

  return problems;
}

/**
 * The check every reader of definitions runs before its first import: a package named `sdk`, the
 * packages the bound set's sync rejected, `selectionProblems`, and, in a process bound to a set, a
 * package the set has no link (or a wrong link) for. With any problem, the reader imports nothing.
 * A package in `skip` (admission's own rejections, already reported) isn't checked.
 */
export function definitionGate(office: Pick<Office, "dir" | "packages">, packages: ResolvedPackage[], skip: ReadonlySet<string> = new Set()): PackageProblem[] {
  const reserved = office.packages.some(entry => entry.name === sdkName) ? [{ packages: [sdkName], message: sdkReserved }] : [];
  const rejected = rejectedPackages(packages, boundUnavailable(office.dir)).filter(pkg => !skip.has(pkg.entry.name));
  const unchecked = new Set([...skip, ...rejected.map(pkg => pkg.entry.name)]);

  const links = packages.flatMap(pkg => {
    const problem = unchecked.has(pkg.entry.name) ? undefined : linkProblem(office.dir, pkg);

    return problem ? [{ packages: [pkg.entry.name], message: problem }] : [];
  });

  return [
    ...reserved,
    ...rejected.map(pkg => ({ packages: [pkg.entry.name], message: "rejected by the last sync; run office sync" })),
    ...selectionProblems(office, packages, unchecked),
    ...links,
  ];
}

/** One line for a package problem: `package <name>: <message>`. */
export function problemLine(problem: PackageProblem) {
  return `package ${problem.packages.join(", ")}: ${problem.message}`;
}

/**
 * The package's settings in office.yaml checked against its schema, with the schema's defaults
 * applied: one problem per invalid setting, each naming its path in office.yaml, or the problem
 * with the schema itself. A setting that reaches the package's compose file must hold no single
 * quote or line feed, and a system setup's setting must stay off unless office.yaml turns it on.
 */
function resolveSettings(resolved: ResolvedPackage, manifest: PackageManifest, file: string): Parsed<Record<string, SettingValue>> {
  const { entry, dir } = resolved;
  const schema = schemaSettings(resolved, manifest, file);

  if (!schema.ok) return schema;
  const settings = schema.value;
  const path = `packages.${entry.name}.settings`;
  const errors = Object.keys(settings).flatMap(key => manifest.secrets[settingVariable(manifest.namespace, key)] ? [`${path}.${key}: conflicts with a package secret`] : []);
  const gate = manifest.system && gateDefaultProblem(entry, settings, manifest.system.setting);

  if (gate) errors.push(gate);

  if (errors.length) return { ok: false, errors };

  try {
    if (existsSync(join(dir, packageComposeFile))) settingsEnv({ name: entry.name, namespace: manifest.namespace, dir, settings });
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }

  return { ok: true, value: settings };
}

/**
 * The package's settings in office.yaml checked against its own schema only, with the schema's
 * defaults applied: what `office down` gives a package's `down`, without the checks for its
 * compose file and system setup.
 */
export function schemaSettings({ entry }: Pick<ResolvedPackage, "entry">, manifest: PackageManifest, file: string): Parsed<Record<string, SettingValue>> {
  const validator = settingsValidator(manifest, file);

  if (!validator.ok) return validator;
  const validate = validator.value;
  const settings = structuredClone(entry.settings ?? {});
  const path = `packages.${entry.name}.settings`;

  if (validate(settings)) return { ok: true, value: settings };

  return { ok: false, errors: (validate.errors ?? []).map(issue => {
    const at = `${path}${issue.instancePath.replaceAll("/", ".")}`;

    if (issue.keyword === "additionalProperties") return `${at}.${String(issue.params.additionalProperty)}: the package declares no such setting; remove it from office.yaml`;

    if (issue.keyword === "required") return `${at}.${String(issue.params.missingProperty)}: is required; add it to office.yaml`;

    return `${at}: ${issue.message}`;
  }) };
}

// One Ajv for every package's settings schema. It registers no schema under its `$id`, so two
// packages can use the same one, and a `$ref` reaches only within its own schema, as with an Ajv
// of its own. Compiled validators are kept by schema text, so reading a package again reuses one.
const settingsAjv = new Ajv2020({ useDefaults: true, allErrors: true, ownProperties: true, strict: false, validateFormats: false, addUsedSchema: false });
const settingsValidators = new Map<string, ValidateFunction>();

/** The validator of a package's settings schema, or the problem, naming the file, with a root that isn't an object or an invalid schema. */
function settingsValidator(manifest: PackageManifest, file: string): Parsed<ValidateFunction> {
  if (manifest.settings instanceof MalformedSettings) return { ok: false, errors: [`${file}: settings: ${manifest.settings.problem}`] };

  if (manifest.settings.type !== "object") return { ok: false, errors: [`${file}: settings: its root must have type: "object"`] };
  const text = JSON.stringify(manifest.settings);

  try {
    const validate = settingsValidators.get(text) ?? settingsAjv.compile(manifest.settings);

    if ("$async" in validate) throw new Error("must be a synchronous schema");
    settingsValidators.set(text, validate);

    return { ok: true, value: validate };
  } catch (error) {
    return { ok: false, errors: [`${file}: settings: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

/**
 * A package that didn't read. `manifest` is its definition whenever that loaded, so its declared
 * commands can still be listed. `settings` holds the problems with its settings or their schema
 * (also in `errors`): with any, no package may be set up.
 */
export type ReadFailure = { ok: false; errors: string[]; manifest?: PackageManifest; settings?: string[] };

/** Validate this office's current entry settings against the installed definition. */
export function readPackage(office: Office, resolved: ResolvedPackage): { ok: true; value: InstalledPackage } | ReadFailure {
  const { entry, dir } = resolved;
  const read = installedDefinition(office, resolved);

  if (!read.ok) return read;

  const { manifest, file, integrations } = read.value;
  const errors: string[] = [];
  const settings = resolveSettings(resolved, manifest, file);

  // Before the checks below that read the package's folder, so a failing one can't hide it.
  if (!settings.ok) return { ok: false, errors: [...errors, ...settings.errors], manifest, settings: settings.errors };

  try {
    for (const [id, service] of Object.entries(manifest.host?.services ?? {})) {
      const script = join(dir, service.script);

      if (!statSync(script, { throwIfNoEntry: false })?.isFile() || relative(realpathSync(dir), realpathSync(script)).startsWith("..")) {
        errors.push(`${entry.name}: host.services.${id}: ${service.script} must be a file inside the package`);
      }
    }

    if (errors.length > 0) return { ok: false, errors, manifest };

    return { ok: true, value: { ...resolved, manifest, settings: settings.value, integrations } };
  } catch (error) {
    // A file the package's folder can't give (an unreadable script) fails this package alone.
    return { ok: false, errors: [`${file}: ${error instanceof Error ? error.message : String(error)}`], manifest };
  }
}

/**
 * What must pass before a candidate is imported: in the selection with the candidate in its
 * entry's place, the copy, package.json and declared dependencies of the candidate and of every
 * package it can import through them or through a selected optional provider, active or not. A staged candidate has no link in the package set yet.
 */
function candidateProblems(office: Pick<Office, "dir" | "packages">, candidate: ResolvedPackage): PackageProblem[] {
  const name = candidate.entry.name;
  const effective = { ...office, packages: office.packages.map(entry => entry.name === name ? candidate.entry : entry) };
  const peers = new Map(resolvePackages(effective).packages.map(peer => [peer.entry.name, peer]));
  const selected = selectedNames(effective);
  const reached = new Map<string, ResolvedPackage>();
  const queue = [candidate];

  for (const pkg of queue) {
    if (reached.has(pkg.entry.name)) continue;
    reached.set(pkg.entry.name, pkg);
    const json = readPackageJson(pkg.dir, pkg.entry.name, pkg.kind);

    for (const dependency of json.ok ? importEdges(json.value, selected) : []) {
      const peer = dependency === name ? undefined : peers.get(dependency);

      if (peer) queue.push(peer);
    }
  }

  return selectionProblems(effective, [...reached.values()]);
}

/**
 * Sync's admission checks a changed copy against the consuming entry before any live path points
 * at its files: its selection, settings, system setup and compose file. Its setup runs
 * with every other package's, in the admission's gathering.
 */
export function validateReplacement(office: Office, resolved: ResolvedPackage) {
  const problems = candidateProblems(office, resolved);

  if (problems.length) throw new Error(problems.map(problemLine).join("; "));
  const read = readPackage(office, resolved);

  if (!read.ok) throw new Error(read.errors.join("; "));

  const item = read.value;
  const { host, system } = item.manifest;

  for (const file of [host?.install?.script, system?.bootstrap, system?.prepare, system?.verify]) {
    if (file === undefined) continue;
    const path = join(item.dir, file);

    if (!statSync(path, { throwIfNoEntry: false })?.isFile() || relative(realpathSync(item.dir), realpathSync(path)).startsWith("..")) throw new Error(`${file} must be a file inside the package`);
  }

  // Its own system block: a recipe it contributes is checked when admission gathers it.
  const section = systemSection(office, { ...item, system: item.manifest.system });

  if (!section.ok) throw new Error(section.errors.join("; "));

  const compose = join(item.dir, packageComposeFile);

  if (existsSync(compose)) {
    const problems = composeProblems(item.manifest.namespace, readFileSync(compose, "utf8"));

    // readPackage has already checked that its settings can reach it.
    if (problems.length) throw new Error(`${packageComposeFile}: ${problems.join("; ")}`);
  }

  return item;
}

/** `.office.json`'s content: what the office declares to its packages. */
export function officeText(office: Office): string {
  return `${JSON.stringify({ opencode: office.opencode.mode }, null, 2)}\n`;
}

/** Writes a package's .office.json. Returns one line per change. */
export function writeOfficeDeclaration(office: Office, installed: Pick<InstalledPackage, "dir">): string[] {
  const officePath = join(installed.dir, officeFile);
  const declared = officeText(office);

  if (existsSync(officePath) && readFileSync(officePath, "utf8") === declared) return [];
  writeFileSync(officePath, declared);

  return [`wrote ${relative(office.dir, officePath)} (opencode: ${office.opencode.mode})`];
}
