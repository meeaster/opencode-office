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
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as v from "valibot";
import { parse, stringify } from "yaml";

import { OfficeError, readEnvFile } from "../../office.ts";
import { check, type ComposeFile, composeFileSchema, type Parsed, scalarSetting, type SettingValue, settingVariable, spawnsOfficeName } from "../../schema.ts";
import { say } from "../../report/index.ts";

type Project = { name: string; state: string };

/** A readable selection. A directory without compose.yaml still claims its namespace. */
export type ComposeSource = {
  name: string;
  namespace: string;
  dir: string;
  settings: Record<string, SettingValue>;
  spawnLabel?: string;
};

/** The file at a package's root that gives it services. */
export const packageComposeFile = "compose.yaml";

/** The office's own services, which no package may define or change. */
const coreServices = ["executor", "opencode"];

/** Applied Compose copies live in subdirectories here; sibling secret files have a separate owner. */
function servicesState(office: Project): string {
  return join(office.state, "packages");
}

function appliedDir(office: Project, name: string): string {
  return join(servicesState(office), name);
}

/** The file beside a package's applied copy holding its spawns label for this office. */
const spawnsFile = "spawns.label";

export function spawnsLabel(label: string, officeName: string): string {
  return label.replace(spawnsOfficeName, officeName);
}

function readSpawns(dir: string): string | undefined {
  const path = join(dir, spawnsFile);

  return existsSync(path) ? readFileSync(path, "utf8").trim() || undefined : undefined;
}

/** Each applied package's spawns label for this office, by package name. */
export function appliedSpawns(office: Project): Map<string, string> {
  return new Map([...appliedServices(office).keys()].flatMap((name) => {
    const label = readSpawns(appliedDir(office, name));

    return label === undefined ? [] : [[name, label] as const];
  }));
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

/** A package's settings as an env file for its compose file, each value single-quoted so Compose takes it literally. */
export function settingsEnv(installed: ComposeSource): string {
  return Object.entries(installed.settings)
    .map(([key, value]) => {
      if (!v.is(scalarSetting, value)) return "";

      const text = String(value);

      // A single-quoted value can't hold a quote or a line break.
      if (/['\n]/.test(text)) throw new OfficeError(`package ${installed.name}: setting ${key} holds a quote or a line break, which can't reach its compose file`);

      return `${settingVariable(installed.namespace, key)}='${text}'\n`;
    })
    .join("");
}

/** A change to the compose file a package runs: `from` the applied copy, `to` the package's current file; undefined is none. */
type ServiceChange = { name: string; from: string | undefined; to: string | undefined };

/**
 * Which packages' compose files to apply now, and which wait for `--upgrade`. `current` holds each
 * readable package office.yaml lists, with its file or undefined; `listed`, every package it lists,
 * so one that can't be read keeps its applied copy. A package new to the office, and the removal
 * of one that left office.yaml, apply without `--upgrade`.
 */
export function planServices(current: ReadonlyMap<string, string | undefined>, applied: ReadonlyMap<string, string>, listed: ReadonlySet<string>, upgrade: boolean) {
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
export function appliedServices(office: Project): Map<string, string> {
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
export function serviceFiles(office: Project): string[] {
  return [...appliedServices(office).keys()]
    .sort()
    .map((name) => join(appliedDir(office, name), "include.yaml"))
    .filter((file) => existsSync(file));
}

/** Applied settings win over shell variables, just as they do for a package's plugin. */
export function serviceSettings(office: Project): Record<string, string> {
  return Object.fromEntries(
    [...appliedServices(office).keys()].flatMap((name) =>
      // settingsEnv writes single-quoted literals, unlike the unquoted secrets files.
      Object.entries(readEnvFile(join(appliedDir(office, name), "settings.env"))).map(([key, value]) => [key, value.slice(1, -1)]),
    ),
  );
}

function currentFile(installed: ComposeSource): string | undefined {
  const path = join(installed.dir, packageComposeFile);

  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** What `office check` says of a package's services: what it contributes, its problems, and whether its file waits for `--upgrade`. */
export function serviceStatus(office: Project, installed: ComposeSource) {
  const text = currentFile(installed);
  const applied = appliedServices(office).get(installed.name);

  if (text === undefined) return { services: [], problems: [], pending: applied !== undefined };

  const read = parseCompose(text);

  return { services: read.ok ? Object.keys(read.value.services) : [], problems: composeProblems(installed.namespace, text), pending: applied !== undefined && applied !== text };
}

/**
 * The packages that claim a namespace another package of the office claims too, each with the
 * others: their services, volumes and variables would be the same.
 */
export function sharedNamespaces(installed: readonly ComposeSource[]): Map<string, string[]> {
  const shared = new Map<string, string[]>();

  for (const item of installed) {
    const others = installed.flatMap((other) => (other !== item && other.namespace === item.namespace ? [other.name] : []));

    if (others.length > 0) shared.set(item.name, others);
  }

  return shared;
}

/** What an upgrade replaces: the package and the services and volumes its applied file declares. */
export type UpgradedServices = { name: string; services: string[]; volumes: string[] };

/**
 * Decides which package compose files `office up` runs, refusing an invalid one it would apply,
 * and says which wait for `--upgrade`. `upgraded` lists the applied files an upgrade replaces, for
 * backing up first. After backup, apply the definitions, then write each active include with its
 * own prepared environment. Neither planning nor reading applied state needs a secrets provider.
 */
export function prepareServices(office: Project, installed: readonly ComposeSource[], listed: ReadonlySet<string>, upgrade: boolean) {
  const current = new Map(installed.map((item) => [item.name, currentFile(item)]));
  const namespaces = new Map(installed.map((item) => [item.name, item.namespace]));
  const namespaceOf = (name: string) => namespaces.get(name) ?? name;
  const shared = sharedNamespaces(installed);

  if (shared.size > 0) {
    const claims = [...new Set(installed.flatMap((item) => (shared.has(item.name) ? [item.namespace] : [])))].map(
      (namespace) => `packages ${installed.flatMap((item) => (item.namespace === namespace ? [item.name] : [])).join(" and ")} claim the same namespace, ${namespace}`,
    );

    throw new OfficeError(`refusing to start package services: ${claims.join("; ")}; give one of them another namespace in its package definition`);
  }

  const applied = appliedServices(office);
  const plan = planServices(current, applied, listed, upgrade);
  const problems = plan.apply.flatMap((change) => (change.to === undefined ? [] : composeProblems(namespaceOf(change.name), change.to).map((problem) => `package ${change.name}: ${packageComposeFile}: ${problem}`)));

  if (problems.length > 0) throw new OfficeError(`refusing to start package services:\n${problems.map((line) => `  ${line}`).join("\n")}`);

  if (plan.pending.length > 0) {
    const invalid = plan.pending.filter((name) => composeProblems(namespaceOf(name), current.get(name) ?? "").length > 0);

    say(
      `running the applied compose files of packages ${plan.pending.join(", ")}; office up --upgrade applies their changes${invalid.length > 0 ? ` (${invalid.join(", ")} must be fixed first; office check names the problems)` : ""}`,
      "office: ",
    );
  }

  const upgraded: UpgradedServices[] = plan.apply.flatMap((change) => {
    if (change.from === undefined || change.to === undefined) return [];

    const read = parseCompose(change.from);
    const volumes = read.ok ? Object.entries(read.value.volumes).flatMap(([key, volume]) => (volume?.external === true ? [] : [volume?.name ?? `office-${office.name}_${key}`])) : [];

    return [{ name: change.name, services: read.ok ? Object.keys(read.value.services) : [], volumes }];
  });

  const applyDefinitions = (environmentPath: (name: string) => string) => {
    const dropped: string[] = [];

    mkdirSync(servicesState(office), { recursive: true, mode: 0o700 });
    chmodSync(servicesState(office), 0o700);

    for (const change of plan.apply) {
      const dir = appliedDir(office, change.name);

      if (change.to === undefined) {
        const label = readSpawns(dir);

        if (label !== undefined) dropped.push(label);

        rmSync(dir, { recursive: true, force: true });
        say(
          listed.has(change.name)
            ? `package ${change.name} no longer has a ${packageComposeFile}, so its services stop; their volumes stay`
            : `package ${change.name} left office.yaml, so its services stop; their volumes and ${environmentPath(change.name)} stay`,
          "office: ",
        );

        continue;
      }

      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, packageComposeFile), change.to);
      say(`applied package ${change.name}'s ${packageComposeFile}${change.from === undefined ? "" : " (upgraded)"}`, "office: ");
    }

    const running = appliedServices(office);

    const include = (item: ComposeSource) => {
      const dir = appliedDir(office, item.name);
      const settings = join(dir, "settings.env");

      writeFileSync(settings, settingsEnv(item));

      // The label describes what the applied copy runs, so a copy waiting for --upgrade keeps its own.
      if (!plan.pending.includes(item.name)) {
        if (item.spawnLabel === undefined) rmSync(join(dir, spawnsFile), { force: true });
        else writeFileSync(join(dir, spawnsFile), `${spawnsLabel(item.spawnLabel, office.name)}\n`);
      }

      writeFileSync(
        join(dir, "include.yaml"),
        `# Written by office up: package ${item.name}'s applied compose file, with its folder for relative paths and its own variables.\n${stringify({
          include: [{ path: join(dir, packageComposeFile), project_directory: item.dir, env_file: [environmentPath(item.name), settings] }],
        })}`,
      );
    };

    const includes = new Map<string, () => void>();

    for (const item of installed) {
      if (running.has(item.name)) includes.set(item.name, () => include(item));
    }

    return { dropped, includes };
  };

  return { upgraded, applyDefinitions };
}
