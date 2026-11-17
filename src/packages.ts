// Packages: capabilities an office opts into, each a folder `packages/<name>/` with a
// package.yaml, skills, an OpenCode plugin, package-owned scripts and a template copied once into
// the office. A
// package declared with `repo` is copied from that repository at `ref` and recorded in
// `.source.json`; one without is authored in the office. Both are committed with the office.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import * as v from "valibot";
import { parse } from "yaml";

import { copyFromRepository } from "./git.ts";
import type { Office, PackageEntry } from "./office.ts";
import { check, type PackageManifest, packageManifestSchema, type Parsed, type SettingValue } from "./schema.ts";
import { buildCommit, toolFiles, toolPath, toolRepository, writeToolFile } from "./tool.ts";

/** Where a copied skill or package records the repository, ref and commit it came from. */
export const sourceFile = ".source.json";

/**
 * The resolved settings `office sync` writes for a package's scripts. A dot-file beside
 * `.source.json` marks it as the office's record rather than package content, so it is left out
 * of the content hash. Settings aren't secrets: it is committed, so scripts in CI can read it.
 */
export const settingsFile = ".settings.json";

/**
 * The template files a package has handled in the office, created or found already there, as a
 * sorted JSON list of paths: each is copied at most once, so a file the office deletes stays
 * deleted. One file for packages from a repository and packages authored in the office, kept
 * across updates like `.settings.json`, while `.source.json` describes only the current copy.
 */
export const templateFile = ".template.json";

/** The office's own records in a package folder, left out of its file hashes. */
const records = [sourceFile, settingsFile, templateFile];

const recordSchema = v.object({
  repo: v.string(),
  path: v.string(),
  ref: v.string(),
  commit: v.string(),
  /** SHA-256 of each package file as copied, by path; local edits show as differences. */
  files: v.record(v.string(), v.string()),
});

export type PackageRecord = v.InferOutput<typeof recordSchema>;

export type InstalledPackage = {
  entry: PackageEntry;
  dir: string;
  manifest: PackageManifest;
  /** The settings with defaults applied, as the scripts read them from `.settings.json`. */
  settings: Record<string, SettingValue>;
  /** Skill IDs under `skills/`, each a folder with a SKILL.md. */
  skills: string[];
  /** Whether it has `plugin/`, an OpenCode plugin `office sync` links as `.opencode/plugins/<name>`. */
  plugin: boolean;
};

export function packageDir(office: Office, name: string): string {
  return join(office.dir, "packages", name);
}

/** The package folders present, declared or not. */
export function packageFolders(office: Office): string[] {
  const dir = join(office.dir, "packages");

  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
}

/** Every file under `dir` as a path relative to it, sorted. */
function files(dir: string): string[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
    .sort();
}

/** The SHA-256 of each package file, leaving out the office's own records. */
function fileHashes(dir: string): PackageRecord["files"] {
  const hashes: PackageRecord["files"] = {};

  for (const file of files(dir)) {
    if (!records.includes(file)) hashes[file] = createHash("sha256").update(readFileSync(join(dir, file))).digest("hex");
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

/** The record of a copied package, or undefined for a folder without a readable one. */
export function readRecord(dir: string): PackageRecord | undefined {
  const path = join(dir, sourceFile);

  if (!existsSync(path)) return undefined;

  const result = readJson(path, recordSchema);

  return result.ok ? result.value : undefined;
}

/** Package files that differ from the copy the record describes, each with what happened to it. */
export function localEdits(dir: string, record: PackageRecord): string[] {
  const now = fileHashes(dir);

  return [
    ...Object.keys(record.files).flatMap((file) => (now[file] === undefined ? [`${file} (removed)`] : now[file] === record.files[file] ? [] : [`${file} (edited)`])),
    ...Object.keys(now).flatMap((file) => (record.files[file] === undefined ? [`${file} (added)`] : [])),
  ];
}

/** Records where the package in `dir` was copied from, with the hash of each of its files. */
function writeRecord(dir: string, source: NonNullable<PackageEntry["source"]>, commit: string): void {
  const copied: PackageRecord & { copied: string } = { ...source, commit, files: fileHashes(dir), copied: new Date().toISOString() };

  writeFileSync(join(dir, sourceFile), `${JSON.stringify(copied, null, 2)}\n`);
}

/** A first-party package as published by this `office`'s build: the tool's repository at the commit it was built from. */
export function toolPackageSource(name: string): NonNullable<PackageEntry["source"]> {
  return { repo: `https://github.com/${toolRepository}.git`, path: `packages/${name}`, ref: buildCommit().sha };
}

/**
 * Installs a first-party package from the tool's own files, with the repository's licence, as
 * `office init` does for knowledge, recorded as copied from `toolPackageSource(name)`. A later
 * sync finds it installed and fetches nothing; an update moves `ref` as for any package from a
 * repository.
 */
export function copyToolPackage(officeDir: string, name: string): void {
  const dir = join(officeDir, "packages", name);
  const source = toolPackageSource(name);

  for (const file of toolFiles(`packages/${name}`)) writeToolFile(join(dir, file), readFileSync(toolPath(`packages/${name}/${file}`), "utf8"));

  writeToolFile(join(dir, "LICENSE"), readFileSync(toolPath("LICENSE"), "utf8"));
  writeRecord(dir, source, source.ref);
}

/**
 * Copies or updates a package declared with a repository. It installs a missing package, and
 * replaces an installed one when the entry's repository, path or ref differs from the record,
 * unless package files were edited locally: then it changes nothing and says which. Returns one
 * line per change; a refusal or failure starts with FAILED.
 */
export function fetchPackage(office: Office, name: string, source: NonNullable<PackageEntry["source"]>): string[] {
  const dir = packageDir(office, name);
  const where = relative(office.dir, dir);
  const record = readRecord(dir);

  if (existsSync(dir)) {
    if (record === undefined) return [`FAILED ${where}: it has no readable ${sourceFile}, so it isn't a copy office sync replaces; move it away to install ${name} from ${source.repo}`];

    if (record.repo === source.repo && record.path === source.path && record.ref === source.ref) return [];

    const edits = localEdits(dir, record);

    if (edits.length > 0) {
      return [
        `FAILED ${where}: not updated to ${source.ref}, because package files differ from the copy of ${record.ref}: ${edits.join(", ")}. Restore them (git checkout -- ${where}), or keep the edits by removing repo, path and ref from the entry, which makes it a package of this office`,
      ];
    }
  }

  // Copied beside the package and swapped in, so a failed copy leaves the installed one as it was.
  const staging = join(office.dir, "packages", `.${name}.new`);

  rmSync(staging, { recursive: true, force: true });

  try {
    const commit = copyFromRepository(source, staging, "package.yaml");

    // A package shared from another office's packages/ carries that office's records; its
    // .template.json would make this office skip template files it never received.
    for (const file of records) rmSync(join(staging, file), { force: true });

    writeRecord(staging, source, commit);

    // Kept: sync reports the settings file only when the settings change, and never copies a
    // template file twice.
    for (const kept of [settingsFile, templateFile]) {
      if (existsSync(join(dir, kept))) copyFileSync(join(dir, kept), join(staging, kept));
    }

    rmSync(dir, { recursive: true, force: true });
    renameSync(staging, dir);

    return [record === undefined ? `installed ${where} from ${source.repo} at ${commit}` : `updated ${where} from ${record.ref} to ${source.ref} (${commit})`];
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });

    return [`FAILED ${where}: ${error instanceof Error ? error.message.trim() : String(error)}`];
  }
}

/**
 * Removes a package copied from a repository whose entry left office.yaml: each template file it
 * created that is still the package's copy, the folders those deletions emptied, then
 * `packages/<name>/`. Changed template files stay with the office. With local edits to package
 * files, or an unreadable `.template.json`, it changes nothing and says why. Returns one line per
 * change; a refusal starts with FAILED.
 */
export function removePackage(office: Office, name: string, record: PackageRecord): string[] {
  const dir = packageDir(office, name);
  const where = relative(office.dir, dir);
  const edits = localEdits(dir, record);

  if (edits.length > 0) {
    return [
      `FAILED ${where}: not removed, though office.yaml no longer lists it, because package files differ from the copy of ${record.ref}: ${edits.join(", ")}. Restore them (git checkout -- ${where}) to remove it, or keep the edits by listing it again without repo, path and ref, which makes it a package of this office`,
    ];
  }

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

/**
 * Reads an installed package and resolves its entry's settings against package.yaml: an unknown
 * setting, or a missing required one, is an error naming the field.
 */
export function readPackage(office: Office, entry: PackageEntry): Parsed<InstalledPackage> {
  const dir = packageDir(office, entry.name);
  const where = relative(office.dir, dir);

  if (!existsSync(join(dir, "package.yaml"))) {
    return { ok: false, errors: [entry.source === undefined ? `${where}/package.yaml is missing; an entry without repo names a package authored in ${where}/` : `${where} is not installed; office sync installs it`] };
  }

  let document;

  try {
    document = parse(readFileSync(join(dir, "package.yaml"), "utf8"));
  } catch (error) {
    return { ok: false, errors: [`${where}/package.yaml: ${error instanceof Error ? error.message : String(error)}`] };
  }

  const read = check(v.safeParse(packageManifestSchema, document));

  if (!read.ok) return { ok: false, errors: read.errors.map((error) => `${where}/package.yaml: ${error}`) };

  const manifest = read.value;
  const accepted = Object.keys(manifest.settings);
  const errors = manifest.name === entry.name ? [] : [`${where}/package.yaml names the package ${manifest.name}, not ${entry.name}`];
  const settings: Record<string, SettingValue> = {};

  for (const [key, value] of Object.entries(entry.settings)) {
    if (accepted.includes(key)) settings[key] = value;
    else errors.push(`settings.${key}: ${entry.name} has no such setting (it accepts ${accepted.join(", ") || "none"}); remove it from the entry in office.yaml`);
  }

  for (const [key, setting] of Object.entries(manifest.settings)) {
    if (settings[key] !== undefined) continue;

    if (setting.default === undefined) errors.push(`settings.${key} is required; add it to the entry in office.yaml: ${setting.description}`);
    else settings[key] = setting.default;
  }

  if (errors.length > 0) return { ok: false, errors };

  const skillsDir = join(dir, "skills");

  const skills = existsSync(skillsDir)
    ? readdirSync(skillsDir, { withFileTypes: true })
        .filter((item) => item.isDirectory() && existsSync(join(skillsDir, item.name, "SKILL.md")))
        .map((item) => item.name)
    : [];

  return { ok: true, value: { entry, dir, manifest, settings, skills, plugin: existsSync(join(dir, "plugin")) } };
}

/** `.settings.json`'s content for a package's resolved settings. */
export function settingsText(installed: InstalledPackage): string {
  return `${JSON.stringify(installed.settings, null, 2)}\n`;
}

/**
 * Writes a package's settings file, and copies each file of its `template/` it has never handled
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

  const template = join(installed.dir, "template");
  const recordPath = join(installed.dir, templateFile);
  const read: Parsed<string[]> = existsSync(recordPath) ? readJson(recordPath, v.array(v.string())) : { ok: true, value: [] };

  if (!read.ok) return [...changes, `FAILED ${relative(office.dir, recordPath)}: ${read.errors.join("; ")}; restore it from the office's history, or delete it to copy every template file again`];

  const handled = new Set(read.value);
  const before = handled.size;

  for (const file of files(template)) {
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

  if (handled.size !== before) writeFileSync(recordPath, `${JSON.stringify([...handled].sort(), null, 2)}\n`);

  return changes;
}
