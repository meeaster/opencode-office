// Which tool a name stands for, from mise's own registry: a short name or an alias stands for the
// first backend the registry lists for it, the one mise prefers; a backend-qualified name stands
// for itself. Read offline from the operation's one mise (standard/tools/host.ts), without any
// config file, whose aliases and settings would make the answer depend on the machine.
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";

import { hostWrappers, miseShims } from "../../src/host-env.ts";
import { hostToolsRoot } from "../../src/host-tools.ts";
import type { Office } from "../../src/office.ts";
import { check } from "../../src/schema.ts";
import { defaultPins } from "../../src/versions.ts";

/** Each registry short name and alias, with the backend it stands for. */
export type ToolRegistry = ReadonlyMap<string, string>;

const registrySchema = v.array(v.object({ short: v.string(), backends: v.array(v.string()), aliases: v.optional(v.array(v.string())) }));

/** The registry from `mise registry --json`'s output: short names first, then aliases no short name has. */
export function parseRegistry(json: string): ToolRegistry {
  const read = check(v.safeParse(registrySchema, JSON.parse(json)));

  if (!read.ok) throw new Error(`mise registry --json: ${read.errors.join("; ")}`);
  const registry = new Map<string, string>();

  for (const { short, backends } of read.value) {
    if (backends[0] !== undefined) registry.set(short, backends[0]);
  }

  for (const { aliases = [], backends } of read.value) {
    for (const alias of aliases) {
      if (backends[0] !== undefined && !registry.has(alias)) registry.set(alias, backends[0]);
    }
  }

  return registry;
}

/** The backend-qualified tool `name` stands for, or undefined for a short name the registry lacks. */
export function canonicalTool(registry: ToolRegistry, name: string): string | undefined {
  return name.includes(":") ? name : registry.get(name);
}

const read = new Map<string, ToolRegistry>();

/** The registry of the mise at `mise`, an absolute path, read once per executable in this process. Throws when it can't answer. */
export function miseRegistry(mise: string): ToolRegistry {
  const known = read.get(mise);

  if (known !== undefined) return known;
  const registry = parseRegistry(execFileSync(mise, ["registry", "--json"], { cwd: "/", encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MISE_NO_CONFIG: "1" } }));

  read.set(mise, registry);

  return registry;
}

/** The mise an operation on the shared tools runs, by its real absolute path, and the version that file reports. */
export type AttestedMise = { path: string; version: string };

/** The first executable file `name` on PATH outside the office's wrappers and mise's shims, by absolute path. */
function onPath(name: string): string | undefined {
  const skip = [hostWrappers(), miseShims()];

  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir.startsWith("/") || skip.includes(dir)) continue;
    const path = join(dir, name);

    try {
      accessSync(path, constants.X_OK);

      if (statSync(path).isFile()) return path;
    } catch {
      // Not here.
    }
  }

  return undefined;
}

/** The version the mise at `path` reports, or undefined when it reports none. */
function reportedVersion(path: string): string | undefined {
  try {
    return /^(\d+\.\d+\.\d+(?:-[\w.-]+)?)/.exec(execFileSync(path, ["--version"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, MISE_NO_CONFIG: "1" } }))?.[1];
  } catch {
    return undefined;
  }
}

/** The mise version an office pins: office.yaml's `tools.mise`, else the release's default. */
export function misePin(office: Pick<Office, "tools">): string {
  return office.tools.runtimes.mise.version ?? defaultPins.mise.version;
}

/**
 * The one mise every step of an operation on the shared tools runs (registry, planning and
 * staging): the copy on PATH (the first outside the office's wrappers and mise's shims) or office's
 * private copy, by its real absolute path, whose own report is exactly `pin`. Never a bare name
 * that PATH could resolve differently later, and never another version: a newer or older mise is
 * refused, not installed over, replaced or repinned. Throws naming what each copy reports.
 */
export function toolsMise(pin: string): AttestedMise {
  const candidates = [...new Set([onPath("mise"), join(hostToolsRoot(), "bin/mise")].flatMap(path => (path !== undefined && existsSync(path) ? [realpathSync(path)] : [])))];
  const reports = candidates.map(path => ({ path, version: reportedVersion(path) }));
  const exact = reports.find(report => report.version === pin);

  if (exact !== undefined) return { path: exact.path, version: pin };
  const found = reports.map(report => `${report.path} reports ${report.version ?? "no version"}`).join(", ") || "there is no mise on PATH or in office's host tools";

  throw new Error(`the shared tools run only mise ${pin}, the version this office pins (office.yaml tools.mise), but ${found}; office doesn't install, replace or repin your mise for them: install mise ${pin} on the host PATH, or pin the version you run in office.yaml and run office pin`);
}

/** The mise the shared tools of `office` run: its pin (`toolsMise`). */
export function officeMise(office: Pick<Office, "tools">): AttestedMise {
  return toolsMise(misePin(office));
}

/** The registry of the mise the shared tools of `office` run (`officeMise`). */
export function officeRegistry(office: Pick<Office, "tools">): ToolRegistry {
  return miseRegistry(officeMise(office).path);
}
