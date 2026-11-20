// Packages: capabilities an office opts into, each a folder with a definition, an OpenCode
// plugin, skills the plugin registers, package-owned scripts, a template copied once into the
// office and a desktop app panel (src/desktop.ts). There are three kinds, by where a package comes from:
//
// - built-in: shipped inside the `office` executable (the tool's packages/), listed by name alone,
//   and replaced whenever it differs from the executable's copy. `office` is always installed.
// - remote: copied from a folder of another repository at a ref, and replaced when the ref moves.
// - local: written in the office, in `packages/<name>/`.
//
// Built-in and remote packages are pulled into `.office/packages/<name>/` and are read-only: the
// hash of each file is recorded in `.source.json`, `office check` reports an edit and `office
// sync` restores the copy. Every kind is committed with the office, so a clone needs nothing fetched.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import * as v from "valibot";

import { panelBundle } from "./desktop.ts";
import { collectAssets } from "../standard/opencode/assets.ts";
import { copyFromRepository } from "./git.ts";
import { type Office, OfficeError, type PackageEntry } from "./office.ts";
import { readDefinition } from "./package-definition.ts";
import { readSnapshot } from "./reference-snapshot.ts";
import { collectJobs } from "../standard/cron/jobs.ts";
import { composeProblems, packageComposeFile, settingsEnv } from "./package-services.ts";
import { systemSection } from "./package-system.ts";
import { check, type PackageManifest, type Parsed, scalarSetting, type SettingValue, settingVariable } from "./schema.ts";
import { build, buildCommit, builtinFiles, builtinPackages, toolRepository } from "./tool.ts";

/** Where a pulled-in package records where it came from and the hash of each of its files. */
export const sourceFile = ".source.json";

/**
 * The resolved settings `office sync` writes for a package's plugin and scripts. A dot-file beside
 * `.source.json` marks it as the office's record rather than package content, so it is left out
 * of the content hash. Settings aren't secrets: it is committed, so scripts in CI can read it.
 */
export const settingsFile = ".settings.json";

/**
 * The template files a package has handled in the office, created or found already there, as a
 * sorted JSON list of paths: each is copied at most once, so a file the office deletes stays
 * deleted. Kept across updates like `.settings.json`, while `.source.json` describes only the
 * current copy.
 */
export const templateFile = ".template.json";

/**
 * What the office declares that any package's plugin and scripts may read, beside its settings and
 * kept apart from them, so no setting name can collide: `{ "opencode": "host" | "container" }`,
 * office.yaml's mode. `office sync` writes it, and it is committed like `.settings.json`.
 */
export const officeFile = ".office.json";

/** The office's own records in a package folder, left out of its file hashes. */
const records = [sourceFile, settingsFile, templateFile, officeFile];

/** The built-in packages every office has, without an entry in office.yaml. */
export const requiredPackages = ["office", "references"];

/** Where packages pulled into the office live: hidden, so searches and a plain `ls` skip them. */
export const pulledFolder = ".office/packages";

const files = v.record(v.string(), v.string());

/** A copy from a repository: where it came from, and when it was copied. */
const remoteRecord = v.object({ repo: v.string(), path: v.string(), ref: v.string(), commit: v.string(), files, copied: v.optional(v.string()) });

/** A built-in copy: the `office` version and commit that wrote it. */
const builtinRecord = v.object({ office: v.string(), commit: v.string(), files });

const recordSchema = v.union([remoteRecord, builtinRecord]);

export type PackageRecord = v.InferOutput<typeof recordSchema>;

export type PackageKind = "built-in" | "remote" | "local";

/** A package the office has, with its kind and its folder. */
export type ResolvedPackage = { entry: PackageEntry; kind: PackageKind; dir: string };

/** Why a package isn't installed, or its plugin isn't linked. */
export type PackageProblem = { packages: string[]; message: string };

/** The packages an office has, and the entries of office.yaml that can't be one. */
export type ResolvedPackages = { packages: ResolvedPackage[]; problems: PackageProblem[] };

export type InstalledPackage = ResolvedPackage & {
  manifest: PackageManifest;
  /** The settings with defaults applied, as the plugin and scripts read them from `.settings.json`. */
  settings: Record<string, SettingValue>;
  /** Skill IDs under `skills/`, each a folder with a SKILL.md, which the package's plugin registers. */
  skills: string[];
  /** Conventional server asset on read; withPluginPlan projects the effective registration. */
  plugin: boolean;
  /** Conventional desktop bundle on read; withPluginPlan projects the effective bundle. */
  panel: string | undefined;
};

/** The folder of a built-in or remote package. */
export function pulledDir(office: Pick<Office, "dir">, name: string): string {
  return join(office.dir, pulledFolder, name);
}

/** The folder of a package written in the office. */
export function localDir(office: Pick<Office, "dir">, name: string): string {
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

/** The package folders in `packages/`, declared or not. */
export function localFolders(office: Office): string[] {
  return folders(join(office.dir, "packages"));
}

/** Whether `repo` is this tool's own repository, which publishes the built-in packages. */
function isToolRepository(repo: string): boolean {
  return repo.replace(/\/+$/, "").replace(/\.git$/, "") === `https://github.com/${toolRepository}`;
}

/** The historical first-party migration is not a claim on names shipped by future executables. */
function historicalSource(name: string, source: { repo: string; path: string }) {
  return ["office", "browser", "knowledge", "design", "aws-emulator", "artifact-share"].includes(name)
    && isToolRepository(source.repo) && source.path === `packages/${name}`;
}

export function legacyBuiltin(entry: PackageEntry): boolean {
  return entry.source !== undefined && entry.source.track === undefined && historicalSource(entry.name, entry.source);
}

function ownershipProblems(office: Pick<Office, "dir" | "packages">, builtins: string[], only?: string): PackageProblem[] {
  const problems: PackageProblem[] = [];

  for (const name of new Set([...requiredPackages, ...office.packages.map(entry => entry.name)])) {
    if (only !== undefined && name !== only) continue;

    if (!builtins.includes(name)) continue;

    const entry = office.packages.find(item => item.name === name);
    const local = localDir(office, name);
    const record = readRecord(local);
    const legacy = entry !== undefined && legacyBuiltin(entry);
    const migratedCopy = legacy && record !== undefined && "repo" in record && record.repo === entry.source?.repo && record.path === entry.source.path;

    if (existsSync(local) && !migratedCopy) problems.push({ packages: [name], message: `built-in package ${name} conflicts with local ${relative(office.dir, local)}; rename one before syncing` });

    if (entry?.source && !legacy) problems.push({ packages: [name], message: `built-in package ${name} conflicts with ${entry.source.repo}@${entry.source.ref}:${entry.source.path}; rename one before syncing` });
    else if (!legacy) {
      const installed = readRecord(pulledDir(office, name));

      if (installed && "repo" in installed && !historicalSource(name, installed)) problems.push({ packages: [name], message: `built-in package ${name} conflicts with installed ${installed.repo}@${installed.ref}:${installed.path}; move the existing copy before syncing` });

      if (name === "references" && !installed && existsSync(pulledDir(office, name))) {
        const snapshot = readSnapshot(office.dir);

        if (!snapshot.ok || !snapshot.value?.contributors.some(group => group.name === name && group.source.startsWith("built-in:"))) {
          problems.push({ packages: [name], message: `cannot establish ownership of ${pulledFolder}/${name}; restore its source record or move the existing copy before syncing` });
        }
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
 */
export function resolvePackages(office: Pick<Office, "dir" | "packages">, only?: string): ResolvedPackages {
  const builtins = builtinPackages();
  const problems = ownershipProblems(office, builtins, only);

  if (problems.length) return { packages: [], problems };

  const packages: ResolvedPackage[] = requiredPackages.flatMap((name) => only !== undefined && name !== only ? [] : [{
    entry: office.packages.find((entry) => entry.name === name) ?? { name, settings: {}, cron: {}, source: undefined },
    kind: "built-in",
    dir: pulledDir(office, name),
  }]);

  for (const entry of office.packages) {
    const problem = (message: string) => problems.push({ packages: [entry.name], message });

    if ((only !== undefined && entry.name !== only) || requiredPackages.includes(entry.name)) continue;

    if (!builtins.includes(entry.name)) {
      packages.push({ entry, kind: entry.source === undefined ? "local" : "remote", dir: entry.source === undefined ? localDir(office, entry.name) : pulledDir(office, entry.name) });

      continue;
    }

    if (entry.source !== undefined) problem(`the entry takes the built-in package ${entry.name} from the tool's repository; office sync drops its repo, path and ref, so it follows this office executable`);

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

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
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
function writeJson(path: string, value: PackageRecord | string[]): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Fills a new copy of the package folder `dir` with `fill`, beside it, then swaps it in, so a
 * failed copy leaves the installed one as it was. The office's settings and template records stay:
 * sync reports the settings file only when the settings change, and never copies a template file twice.
 */
function replaceFolder<Result>(dir: string, fill: (staging: string) => Result): Result {
  mkdirSync(dirname(dir), { recursive: true });
  const temp = mkdtempSync(join(dirname(dir), `.${basename(dir)}.new-`));
  const staging = join(temp, basename(dir));

  try {
    const result = fill(staging);

    for (const kept of [settingsFile, templateFile, officeFile]) {
      if (existsSync(join(dir, kept))) copyFileSync(join(dir, kept), join(staging, kept));
    }

    rmSync(dir, { recursive: true, force: true });
    renameSync(staging, dir);

    return result;
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

function builtinRecordFor(hashes: PackageRecord["files"]): PackageRecord {
  return { office: build().version, commit: buildCommit().sha, files: hashes };
}

/** This executable's copy of the built-in packages, for messages. */
function thisCopy(): string {
  return describeRecord(builtinRecordFor({}));
}

/**
 * Makes a built-in package's folder hold this executable's copy: installs a missing one, replaces
 * one that differs (written by another `office`, copied from a repository, or edited), and records
 * an unchanged copy that lacks a built-in record. Returns one line per change.
 */
export async function installBuiltin(office: Office, entry: PackageEntry) {
  const dir = pulledDir(office, entry.name);
  const { wanted, hashes, source } = await embeddedPackage(entry.name);

  try {
    return { source, changes: installBuiltinFiles(office, entry, dir, wanted, hashes) };
  } catch (error) {
    return { source, changes: [`FAILED ${relative(office.dir, dir)} (${source}): ${error instanceof Error ? error.message : String(error)}`] };
  }
}

export function builtinSource(hashes: PackageRecord["files"]): string {
  return `built-in:${filesDigest(hashes)}`;
}

export function filesDigest(hashes: PackageRecord["files"]): string {
  return sha256(JSON.stringify(Object.keys(hashes).sort().map(path => [path, hashes[path]])));
}

export function gitSelection(source: NonNullable<PackageEntry["source"]>): string {
  return `git:${sha256(JSON.stringify([source.repo, source.path, source.ref]))}`;
}

export async function embeddedPackage(name: string) {
  const wanted = await builtinFiles(name);
  const hashes = Object.fromEntries([...wanted].map(([file, content]) => [file, sha256(content)]));

  return { wanted, hashes, source: builtinSource(hashes) };
}

function installBuiltinFiles(office: Office, entry: PackageEntry, dir: string, wanted: Map<string, string>, hashes: PackageRecord["files"]): string[] {
  const where = relative(office.dir, dir);
  const record = readRecord(dir);

  if (existsSync(dir) && Bun.deepEquals(fileHashes(dir), hashes)) {
    if (record !== undefined && !("repo" in record) && Bun.deepEquals(record.files, hashes)) return [];

    writeJson(join(dir, sourceFile), builtinRecordFor(hashes));

    return [`recorded ${where} as ${thisCopy()}`];
  }

  const edits = record === undefined ? [] : localEdits(dir, record);

  replaceFolder(dir, (staging) => {
    for (const [file, content] of wanted) {
      mkdirSync(dirname(join(staging, file)), { recursive: true });
      writeFileSync(join(staging, file), content);
    }

    writeJson(join(staging, sourceFile), builtinRecordFor(hashes));
    validateReplacement(office, { entry, dir: staging, kind: "built-in" });
  });

  if (record === undefined) return [`installed ${where}, the built-in ${entry.name} package`];

  if (edits.length > 0) return [`restored ${where}, undoing edits to ${edits.join(", ")}; ${readOnlyNote}`];

  return [`updated ${where} from ${describeRecord(record)} to ${thisCopy()}`];
}

const fullCommit = /^[a-f0-9]{40}$/i;

function verifiedCommit(ref: string, commit: string): boolean {
  return fullCommit.test(commit) && (!fullCommit.test(ref) || ref.toLowerCase() === commit.toLowerCase());
}

/**
 * Copies or updates a package declared with a repository into `.office/packages/<name>/`: it
 * installs a missing one, replaces one whose record differs from the entry's repository, path or
 * ref, and restores one whose files were edited. Returns one line per change; a failure starts
 * with FAILED.
 */
export function fetchPackage(office: Office, entry: PackageEntry, source: NonNullable<PackageEntry["source"]>, boundCommit?: string): string[] {
  const { name } = entry;
  const dir = pulledDir(office, name);
  const where = relative(office.dir, dir);
  const record = readRecord(dir);
  const current = record !== undefined && "repo" in record && record.repo === source.repo && record.path === source.path && record.ref === source.ref;
  const edits = record === undefined ? [] : localEdits(dir, record);

  const known = current && verifiedCommit(source.ref, record.commit) && (!boundCommit || record.commit === boundCommit);
  const revision = boundCommit ?? (known ? record.commit : source.ref);

  try {
    if (boundCommit && !verifiedCommit(source.ref, boundCommit)) throw new Error(`invalid reference generation binding ${boundCommit} for ${source.ref}`);

    if (known && edits.length === 0) {
      if (entry.source?.ref !== source.ref) validateReplacement(office, { entry: { ...entry, source }, dir, kind: "remote" });

      return [];
    }

    if (!boundCommit && (record === undefined || (current && !known)) && existsSync(dir) && readdirSync(dir).length > 0 && !fullCommit.test(source.ref)) {
      throw new Error(`cannot repair from ${source.ref} without the recorded commit; restore ${where}/${sourceFile} from office history or pin a full commit SHA`);
    }

    const commit = replaceFolder(dir, (staging) => {
      const copied = copyFromRepository({ ...source, ref: revision }, staging);

      if (!verifiedCommit(revision, copied)) throw new Error(`expected ${revision}, got ${copied}`);

      // A package shared from another office's packages/ carries that office's records; its
      // .template.json would make this office skip template files it never received.
      for (const file of records) rmSync(join(staging, file), { force: true });

      writeJson(join(staging, sourceFile), { repo: source.repo, path: source.path, ref: source.ref, commit: copied, files: fileHashes(staging), copied: new Date().toISOString() });
      validateReplacement(office, { entry: { ...entry, source }, dir: staging, kind: "remote" });

      return copied;
    });

    if (record === undefined) return [`installed ${where} from ${source.repo} at ${commit}`];

    if (current && !known) return [`restored ${where} to ${commit} for ${source.ref}; its record named commit ${record.commit}`];

    if (current) return [`restored ${where} to its copy of ${source.ref}${commit === source.ref ? "" : ` (${commit})`}, undoing edits to ${edits.join(", ")}; ${readOnlyNote}`];

    return [`updated ${where} from ${describeRecord(record)} to ${source.ref} (${commit})`];
  } catch (error) {
    return [`FAILED ${where} from ${source.repo}:${source.path} @ ${source.ref} (revision ${revision}): ${error instanceof Error ? error.message.trim() : String(error)}`];
  }
}

/**
 * Removes a pulled-in package whose entry left office.yaml: each template file it created that is
 * still the package's copy, the folders those deletions emptied, then the package folder. Changed
 * template files stay with the office. With an unreadable `.template.json` it changes nothing and
 * says why. Returns one line per change; a refusal starts with FAILED.
 */
export function removePackage(office: Office, name: string): string[] {
  const dir = pulledDir(office, name);
  const where = relative(office.dir, dir);
  const recordPath = join(dir, templateFile);
  const read: Parsed<string[]> = existsSync(recordPath) ? readJson(recordPath, v.array(v.string())) : { ok: true, value: [] };

  if (!read.ok) return [`FAILED ${where}: not removed, because ${relative(office.dir, recordPath)} doesn't say which template files it created: ${read.errors.join("; ")}`];

  const changes: string[] = [];

  for (const file of read.value) {
    const target = join(office.dir, file);
    const copy = join(dir, "template", file);

    if (!existsSync(target)) continue;

    if (!existsSync(copy) || !readFileSync(target).equals(readFileSync(copy))) {
      changes.push(`kept ${file}, which changed since package ${name} wrote it`);

      continue;
    }

    rmSync(target);
    changes.push(`deleted ${file}, which package ${name} created`);

    for (let folder = dirname(target); relative(office.dir, folder) !== "" && readdirSync(folder).length === 0; folder = dirname(folder)) rmdirSync(folder);
  }

  rmSync(dir, { recursive: true });

  return [...changes, `removed ${where}/, which office.yaml no longer lists`];
}

/** Check the installed source (plus its command binding when dispatching) before importing any code. */
export function installedDefinition(office: Pick<Office, "dir">, resolved: ResolvedPackage, verifyBinding?: (record?: PackageRecord) => void) {
  const { entry, dir } = resolved;
  const where = relative(office.dir, dir);

  return readDefinition(dir, where, () => {
    if (resolved.kind === "local") {
      verifyBinding?.();

      return;
    }

    const record = readRecord(dir);

    if (record === undefined) throw new Error(`no readable ${sourceFile}; ${resolved.kind === "built-in" ? "office sync restores the built-in copy" : "restore it from office history or run office sync with an exact pin"}`);

    if (resolved.kind === "built-in" && "repo" in record) throw new Error("the installed copy is remote, not built-in; run office sync");

    if (resolved.kind === "remote" && !("repo" in record && record.repo === entry.source?.repo && record.path === entry.source.path && record.ref === entry.source.ref)) {
      throw new Error("the installed copy is not from the selected source and ref; run office sync");
    }

    if ("repo" in record && !verifiedCommit(record.ref, record.commit)) throw new Error(`invalid recorded commit ${record.commit} for ${record.ref}; run office sync`);

    verifyBinding?.(record);
    const edits = localEdits(dir, record);

    if (edits.length > 0) throw new Error(`package files edited: ${edits.join(", ")}; office sync restores them`);
  });
}

/** Validate this office's current entry settings against the installed definition. */
export function readPackage(office: Office, resolved: ResolvedPackage): Parsed<InstalledPackage> {
  const { entry, dir } = resolved;
  const read = installedDefinition(office, resolved);

  if (!read.ok) return read;

  const { manifest, file } = read.value;
  const accepted = Object.keys(manifest.settings);
  const errors = manifest.name === entry.name ? [] : [`${file} names the package ${manifest.name}, not ${entry.name}`];
  const settings = structuredClone(entry.settings ?? {});

  for (const key of Object.keys(entry.cron)) {
    if (!manifest.registerCron && !Object.hasOwn(manifest.cron, key)) errors.push(`packages.${entry.name}.cron.${key}: no such job in ${file}`);
  }

  if (manifest.settings_schema !== undefined) {
    try {
      const ajv = new Ajv2020({ useDefaults: true, allErrors: true, ownProperties: true, strict: false, validateFormats: false });
      const validate = ajv.compile(manifest.settings_schema);

      if ("$async" in validate) throw new Error("must be a synchronous schema");

      if (!validate(settings)) {
        for (const issue of validate.errors ?? []) {
          errors.push(`${entry.name}.settings${issue.instancePath}: ${issue.message}${issue.keyword === "additionalProperties" ? `: ${issue.params.additionalProperty}` : ""}`);
        }
      }
    } catch (error) {
      errors.push(`${file}: settings_schema: ${error instanceof Error ? error.message : String(error)}`);
    }

    for (const key of Object.keys(settings)) {
      if (manifest.secrets[settingVariable(manifest.namespace, key)]) errors.push(`${entry.name}.settings.${key}: conflicts with a package secret`);
    }

    const gate = manifest.host?.setting;

    if (gate !== undefined && !v.is(v.boolean(), settings[gate])) errors.push(`${entry.name}.settings.${gate}: host.setting requires a boolean`);

    const systemGate = manifest.system?.setting;

    if (systemGate !== undefined && !v.is(v.boolean(), settings[systemGate])) errors.push(`${entry.name}.settings.${systemGate}: system.setting requires a boolean`);

    const appGate = manifest.executor_app?.setting;

    if (appGate !== undefined && !v.is(v.boolean(), settings[appGate])) errors.push(`${entry.name}.settings.${appGate}: executor_app.setting requires a boolean`);
  } else {
    for (const [key, value] of Object.entries(settings)) {
      if (!accepted.includes(key)) errors.push(`settings.${key}: ${entry.name} has no such setting (it accepts ${accepted.join(", ") || "none"}); remove it from the entry in office.yaml`);
      else if (!v.is(scalarSetting, value)) errors.push(`settings.${key}: must be text, a number or true/false`);
    }

    for (const [key, setting] of Object.entries(manifest.settings)) {
      if (Object.hasOwn(settings, key)) continue;

      if (setting.default === undefined) errors.push(`settings.${key} is required; add it to the entry in office.yaml: ${setting.description}`);
      else settings[key] = setting.default;
    }
  }

  for (const [id, service] of Object.entries(manifest.host?.services ?? {})) {
    if (service.setting !== undefined && !v.is(v.boolean(), settings[service.setting])) errors.push(`${entry.name}: host.services.${id}.setting requires a boolean setting`);

    const script = join(dir, service.script);

    if (!statSync(script, { throwIfNoEntry: false })?.isFile() || relative(realpathSync(dir), realpathSync(script)).startsWith("..")) {
      errors.push(`${entry.name}: host.services.${id}: ${service.script} must be a file inside the package`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const skillsDir = join(dir, "skills");

  const skills = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true })
        .filter((item) => item.isDirectory() && existsSync(join(skillsDir, item.name, "SKILL.md")))
        .map((item) => item.name)
    : [];

  const panel = join(dir, panelBundle);

  return { ok: true, value: { ...resolved, manifest, settings, skills, plugin: !manifest.opencode && existsSync(join(dir, "plugin")), panel: !manifest.opencode && existsSync(panel) ? panel : undefined } };
}

/** Validate a candidate against the consuming entry before any live path points at its files. */
function validateReplacement(office: Office, resolved: ResolvedPackage): void {
  const read = readPackage(office, resolved);

  if (!read.ok) throw new Error(read.errors.join("; "));

  const item = read.value;

  if (item.manifest.opencode) collectAssets(office.dir, item);
  const { host, system } = item.manifest;

  for (const file of [host?.install?.script, system?.bootstrap, system?.prepare, system?.verify]) {
    if (file === undefined) continue;
    const path = join(item.dir, file);

    if (!statSync(path, { throwIfNoEntry: false })?.isFile() || relative(realpathSync(item.dir), realpathSync(path)).startsWith("..")) throw new Error(`${file} must be a file inside the package`);
  }

  const jobs = collectJobs({ ...office, cron: {} }, { installed: [item], problems: [] });

  if (!jobs.ok) throw new Error(jobs.errors.join("; "));
  const section = systemSection(office, item);

  if (!section.ok) throw new Error(section.errors.join("; "));

  const compose = join(item.dir, packageComposeFile);

  if (existsSync(compose)) {
    const problems = composeProblems(item.manifest.namespace, readFileSync(compose, "utf8"));

    if (problems.length) throw new Error(`${packageComposeFile}: ${problems.join("; ")}`);
    settingsEnv(item);
  }
}

/** `.office.json`'s content: what the office declares to its packages. */
export function officeText(office: Office): string {
  return `${JSON.stringify({ opencode: office.opencode.mode }, null, 2)}\n`;
}

/** `.settings.json`'s content for a package's resolved settings. */
export function settingsText(installed: InstalledPackage): string {
  return `${JSON.stringify(installed.settings, null, 2)}\n`;
}

/**
 * Writes a package's settings file and .office.json, and copies each file of its `template/` it has never handled
 * to the same path in the office, unless a file is already there: from then on the office owns
 * it. Both kinds count as handled in `.template.json`. Returns one line per change.
 */
export function installPackage(office: Office, installed: InstalledPackage): string[] {
  const changes: string[] = [];
  const settingsPath = join(installed.dir, settingsFile);
  const settings = settingsText(installed);

  if (!existsSync(settingsPath) || readFileSync(settingsPath, "utf8") !== settings) {
    writeFileSync(settingsPath, settings);
    changes.push(`wrote ${relative(office.dir, settingsPath)}`);
  }

  const officePath = join(installed.dir, officeFile);
  const declared = officeText(office);

  if (!existsSync(officePath) || readFileSync(officePath, "utf8") !== declared) {
    writeFileSync(officePath, declared);
    changes.push(`wrote ${relative(office.dir, officePath)} (opencode: ${office.opencode.mode})`);
  }

  const template = join(installed.dir, "template");
  const recordPath = join(installed.dir, templateFile);
  const read: Parsed<string[]> = existsSync(recordPath) ? readJson(recordPath, v.array(v.string())) : { ok: true, value: [] };

  if (!read.ok) return [...changes, `FAILED ${relative(office.dir, recordPath)}: ${read.errors.join("; ")}; restore it from the office's history, or delete it to copy every template file again`];

  const handled = new Set(read.value);
  const before = handled.size;

  for (const file of filesIn(template)) {
    const target = join(office.dir, file);

    if (handled.has(file)) continue;

    handled.add(file);

    if (existsSync(target)) {
      changes.push(`kept ${file}, which was already there, instead of package ${installed.entry.name}'s copy`);

      continue;
    }

    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(template, file), target);
    changes.push(`created ${file} from package ${installed.entry.name}`);
  }

  if (handled.size !== before) writeJson(recordPath, [...handled].sort());

  return changes;
}
