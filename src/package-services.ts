// Package services: a package with a compose.yaml at its root adds services to the office's compose
// project, office-<name>, in either mode.
//
// `office up` runs a copy of each package's compose file kept in the state folder, as it runs the
// versions it last applied: a package new to the office is applied at once, a changed file waits
// for `office up --upgrade`, and a package that left office.yaml stops contributing. Each copy is
// reached through a generated include file, because Compose resolves relative paths of every `-f`
// file against the first file's folder; an include gives the copy the package's folder as its
// project directory, and its own env files (the package's generated secrets and its settings) for
// interpolation.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as v from "valibot";
import { parse, stringify } from "yaml";

import { installedPackages } from "./layout.ts";
import { type Office, OfficeError, readEnvFile } from "./office.ts";
import { type InstalledPackage, resolvePackages } from "./packages.ts";
import { check, type ComposeFile, composeFileSchema, type PackageManifest, type Parsed, settingVariable } from "./schema.ts";

/** The file at a package's root that gives it services. */
export const packageComposeFile = "compose.yaml";

/** The office's own services, which no package may define or change. */
const coreServices = ["executor", "opencode"];

/** The state folder of package services: `<name>.env` (secrets) and `<name>/` (the applied copy, its settings and include file). */
function servicesState(office: Office): string {
  return join(office.state, "packages");
}

export function secretsPath(office: Office, name: string): string {
  return join(servicesState(office), `${name}.env`);
}

function appliedDir(office: Office, name: string): string {
  return join(servicesState(office), name);
}

export function parseCompose(text: string): Parsed<ComposeFile> {
  let document;

  try {
    document = parse(text);
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }

  return check(v.safeParse(composeFileSchema, document));
}

/**
 * What is wrong with a package's compose file: every service and top-level named resource must be
 * named after the package's namespace, `<namespace>` or `<namespace>-*`, and every published port must bind 127.0.0.1.
 */
export function composeProblems(namespace: string, text: string): string[] {
  if (coreServices.includes(namespace)) return [`${namespace} is one of the office's own services, so a package with that namespace can't have a ${packageComposeFile}`];

  const read = parseCompose(text);

  if (!read.ok) return read.errors;

  const owned = (key: string) => key === namespace || key.startsWith(`${namespace}-`);
  const problems: string[] = [];

  for (const kind of ["services", "volumes", "networks", "configs", "secrets"] as const) {
    for (const key of Object.keys(read.value[kind])) {
      if (!owned(key)) problems.push(`${kind}.${key}: must be named ${namespace} or ${namespace}-*`);
    }
  }

  for (const [service, definition] of Object.entries(read.value.services)) {
    if (definition.network_mode === "host") problems.push(`services.${service}: network_mode host would publish every port beyond 127.0.0.1`);

    for (const [index, port] of (definition.ports ?? []).entries()) {
      if (!port.loopback) problems.push(`services.${service}.ports[${index}]: must bind 127.0.0.1, such as "127.0.0.1:8080:80" or host_ip: 127.0.0.1`);
    }
  }

  return problems;
}

/** A new value for one of a package's secrets. */
export function generateSecret(secret: PackageManifest["secrets"][string]): string {
  return `${secret.prefix ?? ""}${randomBytes(secret.bytes).toString(secret.generate)}`;
}

/**
 * Adds each of `secrets` missing from the env file at `path` (mode 600) and returns the names it
 * added. An existing value is never replaced: services sign users in and encrypt with them.
 */
export function ensureSecrets(path: string, secrets: PackageManifest["secrets"]): string[] {
  const existing = readEnvFile(path);
  const missing = Object.keys(secrets).filter((key) => existing[key] === undefined);
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = missing.map((key) => `${key}=${generateSecret(secrets[key])}\n`);

  writeFileSync(path, `${before}${before === "" || before.endsWith("\n") ? "" : "\n"}${lines.join("")}`, { mode: 0o600 });
  chmodSync(path, 0o600);

  return missing;
}

/** A package's settings as an env file for its compose file, each value single-quoted so Compose takes it literally. */
export function settingsEnv(installed: InstalledPackage): string {
  return Object.entries(installed.settings)
    .map(([key, value]) => {
      const text = String(value);

      // A single-quoted value can't hold a quote or a line break.
      if (/['\n]/.test(text)) throw new OfficeError(`package ${installed.entry.name}: setting ${key} holds a quote or a line break, which can't reach its compose file`);

      return `${settingVariable(installed.manifest.namespace, key)}='${text}'\n`;
    })
    .join("");
}

/** A change to the compose file a package runs: `from` the applied copy, `to` the package's current file; undefined is none. */
export type ServiceChange = { name: string; from: string | undefined; to: string | undefined };

/**
 * Which packages' compose files to apply now, and which wait for `--upgrade`. `current` holds each
 * readable package office.yaml lists, with its file or undefined; `listed`, every package it lists,
 * so one that can't be read keeps its applied copy. A package new to the office, and the removal
 * of one that left office.yaml, apply without `--upgrade`.
 */
export function planServices(current: Map<string, string | undefined>, applied: Map<string, string>, listed: Set<string>, upgrade: boolean) {
  const apply: ServiceChange[] = [];
  const pending: string[] = [];

  for (const name of [...new Set([...current.keys(), ...applied.keys()])].sort()) {
    const from = applied.get(name);

    if (!listed.has(name)) {
      if (from !== undefined) apply.push({ name, from, to: undefined });

      continue;
    }

    if (!current.has(name)) continue;

    const to = current.get(name);

    if (to === from) continue;

    if (from === undefined || upgrade) apply.push({ name, from, to });
    else pending.push(name);
  }

  return { apply, pending };
}

/** Each package's applied compose file, by package name. */
export function appliedServices(office: Office): Map<string, string> {
  const dir = servicesState(office);
  const applied = new Map<string, string>();

  if (!existsSync(dir)) return applied;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const copy = join(dir, entry.name, packageComposeFile);

    if (entry.isDirectory() && existsSync(copy)) applied.set(entry.name, readFileSync(copy, "utf8"));
  }

  return applied;
}

/** The include file of each package's applied compose file, in package-name order, for `docker compose -f`. */
export function serviceFiles(office: Office): string[] {
  return [...appliedServices(office).keys()]
    .sort()
    .map((name) => join(appliedDir(office, name), "include.yaml"))
    .filter((file) => existsSync(file));
}

/** Applied settings win over shell variables, just as they do for a package's plugin. */
export function serviceSettings(office: Office): Record<string, string> {
  return Object.fromEntries(
    [...appliedServices(office).keys()].flatMap((name) =>
      // settingsEnv writes single-quoted literals, unlike the unquoted secrets files.
      Object.entries(readEnvFile(join(appliedDir(office, name), "settings.env"))).map(([key, value]) => [key, value.slice(1, -1)]),
    ),
  );
}

function currentFile(installed: InstalledPackage): string | undefined {
  const path = join(installed.dir, packageComposeFile);

  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** What `office check` says of a package's services: what it contributes, its problems, and whether its file waits for `--upgrade`. */
export function serviceStatus(office: Office, installed: InstalledPackage) {
  const text = currentFile(installed);
  const applied = appliedServices(office).get(installed.entry.name);

  if (text === undefined) return { services: [], problems: [], pending: applied !== undefined };

  const read = parseCompose(text);

  return { services: read.ok ? Object.keys(read.value.services) : [], problems: composeProblems(installed.manifest.namespace, text), pending: applied !== undefined && applied !== text };
}

/**
 * The packages that claim a namespace another package of the office claims too, each with the
 * others: their services, volumes and variables would be the same.
 */
export function sharedNamespaces(installed: InstalledPackage[]): Map<string, string[]> {
  const shared = new Map<string, string[]>();

  for (const item of installed) {
    const others = installed.flatMap((other) => (other !== item && other.manifest.namespace === item.manifest.namespace ? [other.entry.name] : []));

    if (others.length > 0) shared.set(item.entry.name, others);
  }

  return shared;
}

/** What an upgrade replaces: the package and the services and volumes its applied file declares. */
export type UpgradedServices = { name: string; services: string[]; volumes: string[] };

/**
 * Decides which package compose files `office up` runs, refusing an invalid one it would apply,
 * and says which wait for `--upgrade`. `upgraded` lists the applied files an upgrade replaces, for
 * backing up first; `apply` writes the state the compose project then runs.
 */
export function preparePackageServices(office: Office, upgrade: boolean) {
  const { installed } = installedPackages(office);
  const current = new Map(installed.map((item) => [item.entry.name, currentFile(item)]));
  const namespaces = new Map(installed.map((item) => [item.entry.name, item.manifest.namespace]));
  const namespaceOf = (name: string) => namespaces.get(name) ?? name;
  const shared = sharedNamespaces(installed);

  if (shared.size > 0) {
    const claims = [...new Set(installed.flatMap((item) => (shared.has(item.entry.name) ? [item.manifest.namespace] : [])))].map(
      (namespace) => `packages ${installed.flatMap((item) => (item.manifest.namespace === namespace ? [item.entry.name] : [])).join(" and ")} claim the same namespace, ${namespace}`,
    );

    throw new OfficeError(`refusing to start package services: ${claims.join("; ")}; give one of them another namespace: in its package.yaml`);
  }

  const applied = appliedServices(office);
  const listed = new Set(resolvePackages(office).packages.map((item) => item.entry.name));
  const plan = planServices(current, applied, listed, upgrade);
  const problems = plan.apply.flatMap((change) => (change.to === undefined ? [] : composeProblems(namespaceOf(change.name), change.to).map((problem) => `package ${change.name}: ${packageComposeFile}: ${problem}`)));

  if (problems.length > 0) throw new OfficeError(`refusing to start package services:\n${problems.map((line) => `  ${line}`).join("\n")}`);

  if (plan.pending.length > 0) {
    const invalid = plan.pending.filter((name) => composeProblems(namespaceOf(name), current.get(name) ?? "").length > 0);

    console.log(
      `office: running the applied compose files of packages ${plan.pending.join(", ")}; office up --upgrade applies their changes${invalid.length > 0 ? ` (${invalid.join(", ")} must be fixed first; office check names the problems)` : ""}`,
    );
  }

  const upgraded = plan.apply.flatMap((change) => {
    if (change.from === undefined || change.to === undefined) return [];

    const read = parseCompose(change.from);
    const volumes = read.ok ? Object.entries(read.value.volumes).flatMap(([key, volume]) => (volume?.external === true ? [] : [volume?.name ?? `office-${office.name}_${key}`])) : [];

    return [{ name: change.name, services: read.ok ? Object.keys(read.value.services) : [], volumes }];
  });

  const apply = () => {
    mkdirSync(servicesState(office), { recursive: true, mode: 0o700 });
    chmodSync(servicesState(office), 0o700);

    for (const change of plan.apply) {
      const dir = appliedDir(office, change.name);

      if (change.to === undefined) {
        rmSync(dir, { recursive: true, force: true });
        console.log(
          listed.has(change.name)
            ? `office: package ${change.name} no longer has a ${packageComposeFile}, so its services stop; their volumes stay`
            : `office: package ${change.name} left office.yaml, so its services stop; their volumes and ${secretsPath(office, change.name)} stay`,
        );

        continue;
      }

      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, packageComposeFile), change.to);
      console.log(`office: applied package ${change.name}'s ${packageComposeFile}${change.from === undefined ? "" : " (upgraded)"}`);
    }

    const running = appliedServices(office);

    for (const item of installed) {
      if (!running.has(item.entry.name)) continue;

      const dir = appliedDir(office, item.entry.name);
      const secrets = secretsPath(office, item.entry.name);
      const settings = join(dir, "settings.env");

      for (const key of ensureSecrets(secrets, item.manifest.secrets)) console.log(`office: generated ${key} for package ${item.entry.name} in ${secrets}`);

      writeFileSync(settings, settingsEnv(item));
      writeFileSync(
        join(dir, "include.yaml"),
        `# Written by office up: package ${item.entry.name}'s applied compose file, with its folder for relative paths and its own variables.\n${stringify({
          include: [{ path: join(dir, packageComposeFile), project_directory: item.dir, env_file: [secrets, settings] }],
        })}`,
      );
    }
  };

  return { upgraded, apply };
}
