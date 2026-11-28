import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { boundUnavailable, definitionRoot, linkProblem } from "../../bound-paths.ts";
import { composeProblems, packageComposeFile, settingsEnv } from "../../features/compose/services.ts";
import { gateDefaultProblem, systemSection } from "../../features/mise-integration/system.ts";
import type { Office } from "../../office.ts";
import { type PackageManifest, settingVariable } from "../sources/manifest-schema.ts";
import type { SettingValue } from "../../schema.ts";
import type { Parsed } from "../../parse.ts";
import { verifyCopy } from "../sources/copies.ts";
import { importEdges, readPackageJson, scope, sdkName } from "../sources/manifest.ts";
import { type PackageProblem, type ResolvedPackage, resolvePackages, selectedNames } from "../sources/selection.ts";
import { readDefinition } from "./definition.ts";
import type { OptionalIntegration } from "./integrations.ts";
import { schemaSettings } from "./settings.ts";

export type InstalledPackage = ResolvedPackage & {
  manifest: PackageManifest;
  /** The settings with defaults applied, as runtimes read them from the office's applied settings snapshot. */
  settings: Record<string, SettingValue>;
  /** Its optional integrations, each with its module, whether or not its provider is selected. */
  integrations: readonly OptionalIntegration[];
};

/** Check the installed source before importing any code. */
export function installedDefinition(office: Pick<Office, "dir">, resolved: ResolvedPackage) {
  return readDefinition(resolved.dir, resolved.entry.name, relative(office.dir, resolved.dir), { verifyCopy: () => verifyCopy(resolved), root: definitionRoot(office.dir, resolved) });
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
function selectionProblems(office: Pick<Office, "packages">, packages: ResolvedPackage[], skip: ReadonlySet<string> = new Set()): PackageProblem[] {
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
        verifyCopy(pkg);
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
  // Selection can stop at an ownership conflict before it reaches the reserved name.
  const reserved = office.packages.some(entry => entry.name === sdkName) ? resolvePackages(office, sdkName, true).problems : [];
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
 * A package that didn't read. `manifest` is its definition whenever that loaded, so its declared
 * commands can still be listed. `settings` holds the problems with its settings or their schema
 * (also in `errors`): with any, no package may be set up.
 */
type ReadFailure = { ok: false; errors: string[]; manifest?: PackageManifest; settings?: string[] };

/** Validate this office's current entry settings against the installed definition. */
function readPackage(office: Office, resolved: ResolvedPackage): { ok: true; value: InstalledPackage } | ReadFailure {
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

/** Packages installed with valid settings, read from their definitions alone: no setup runs, so
 * nothing they register is known here (registration.ts handles that). The whole selection passes
 * `definitionGate` first (the `skip` packages, the ones sync failed to fetch, are left out); with
 * any problem, no definition is imported and `blocked` holds the problems. `live` (the gathering)
 * resolves the rest of the selection past an ownership problem, and that problem blocks it too:
 * another package could import the conflicting one's copy. */
export function installedPackages(office: Office, skip: ReadonlySet<string> = new Set(), live = false): InstalledPackages {
  const installed: InstalledPackage[] = [];
  const resolved = resolvePackages(office, undefined, live);
  const problems = [...resolved.problems];
  const selected = selectedNames(office);
  const unread = new Set(selected);
  const gate = definitionGate(office, resolved.packages, skip);
  // resolvePackages already names a package called sdk.
  const unknown = gate.filter(problem => !problems.some(known => known.message === problem.message));
  const blocked = live ? [...problems, ...unknown] : gate;

  if (blocked.length) return { selected, installed, problems: [...problems, ...unknown], unread, blocked, invalidSettings: [], definitions: new Map() };

  const invalidSettings: PackageProblem[] = [];
  const definitions = new Map<string, PackageManifest>();

  for (const item of resolved.packages) {
    if (skip.has(item.entry.name)) continue;
    const read = readPackage(office, item);
    const manifest = read.ok ? read.value.manifest : read.manifest;

    if (manifest) definitions.set(item.entry.name, manifest);

    if (read.ok) {
      installed.push(read.value);
      unread.delete(item.entry.name);
    } else {
      problems.push(...read.errors.map((message) => ({ packages: [item.entry.name], message })));
      invalidSettings.push(...(read.settings ?? []).map((message) => ({ packages: [item.entry.name], message })));
    }
  }

  return { selected, installed, problems, unread, invalidSettings, definitions };
}

export type InstalledPackages = {
  selected: Set<string>;
  installed: InstalledPackage[];
  problems: PackageProblem[];
  /** Selected but unresolved or unreadable: absence from `installed` cannot authorize cleanup. */
  unread: Set<string>;
  /** The problems `definitionGate` found; with any, no package loaded. */
  blocked?: PackageProblem[];
  /** Settings in office.yaml that a package's schema refuses (also in `problems`); with any, no setup may run. */
  invalidSettings: PackageProblem[];
  /** The definition of each package that loaded, read or not: its declared commands are claimed either way. */
  definitions: Map<string, PackageManifest>;
};
