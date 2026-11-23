// What a host-mode office writes in its own data folder (`$XDG_DATA_HOME/office`, the folder that also
// holds the machine record and host-tools) for Socket Firewall and the shared environment:
//
// - `sfw/sfw`, the pinned Socket Firewall, which `office up` downloads and checks against office.lock;
// - `sfw/package-manager.sh` and `sfw/bin/`, the wrappers (src/sfw.ts), which `office sync` writes;
// - `env.sh`, the environment agents and the user's terminal share: PATH entries (the wrappers, mise's
//   shims, OpenCode's bin, then what packages declare) and plain variables (the release ages for
//   package managers and mise, from `tools.minimum_release_age`, then what packages declare). The user sources it from their shell's startup file; the OpenCode
//   server's unit will source it once the office owns that unit.
//
// Each is a file in the machine record (src/machine.ts), written only with the user's consent. The
// folder is the office tool's own, so these names carry no office name: a machine has one host-mode
// office, and the user's startup file names one stable path.
//
// OFFICE_MACHINE_DIR replaces the folder for tests and scratch offices.
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { hostToolsRoot } from "./host-tools.ts";
import type { Office } from "./office.ts";
import { systemVariables } from "./package-system.ts";
import { hostApplies } from "./package-tools.ts";
import type { GatheredPackage } from "./gather.ts";
import type { InstalledPackage } from "./packages.ts";
import { managedAgentEnvironment } from "./schema.ts";
import { type Environment, releaseAgeVariables, type SfwLayout, sfwLayout, shellQuote } from "./sfw.ts";

export const machineDirVariable = "OFFICE_MACHINE_DIR";

/** The home folder: `$HOME` first, as the shells that source the environment file read it. */
function home(): string {
  return process.env.HOME || homedir();
}

/** The office tool's data folder on this machine: `$OFFICE_MACHINE_DIR`, else `$XDG_DATA_HOME/office`. */
export function machineDir(): string {
  return process.env[machineDirVariable] || join(process.env.XDG_DATA_HOME || join(home(), ".local/share"), "office");
}

/** The environment file the user's shell (and, later, the server's unit) sources. */
export function envFilePath(): string {
  return join(machineDir(), "env.sh");
}

/** The host's sfw layout, its mise wrapper running the real mise at `mise`. */
export function hostLayout(mise: string): SfwLayout {
  const root = join(machineDir(), "sfw");

  return sfwLayout(root, join(root, "sfw"), mise);
}

/** The folder of the host's wrappers, which the environment file puts first on PATH. */
export function hostWrappers(): string {
  return join(machineDir(), "sfw/bin");
}

/** mise's shims on this machine, as mise finds its data folder. */
export function miseShims(): string {
  return join(process.env.MISE_DATA_DIR || join(process.env.XDG_DATA_HOME || join(home(), ".local/share"), "mise"), "shims");
}

/** Where OpenCode's installer puts the `opencode` command. */
export function opencodeBin(): string {
  return join(home(), ".opencode/bin");
}

/** Whether `path` is an executable program file, not a script: a wrapper such as the office's or mise-guard starts with `#!`. */
function isProgram(path: string): boolean {
  let fd;

  try {
    const stats = statSync(path);

    if (!stats.isFile() || (stats.mode & 0o111) === 0) return false;

    fd = openSync(path, "r");

    const head = Buffer.alloc(2);

    return readSync(fd, head, 0, 2, 0) === 2 && head.toString("latin1") !== "#!";
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The real mise the mise wrapper runs: the first mise program on PATH outside the wrappers' folder
 * and mise's shims, skipping wrappers such as Mindframe-Z's mise-guard, else the office's own copy
 * in host-tools. Undefined when there is none.
 */
export function realMise(): string | undefined {
  const skip = [hostWrappers(), miseShims()];

  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir === "" || skip.includes(dir)) continue;

    if (isProgram(join(dir, "mise"))) return join(dir, "mise");
  }

  const managed = join(hostToolsRoot(), "bin/mise");

  return isProgram(managed) ? managed : undefined;
}

/** What a package's host block adds to the environment file, with absolute folders. */
export type PackageEnvironment = { name: string; path: string[]; variables: [string, string][] };

/** A declared folder as an absolute path: `~/…` in the home folder, `/…` as it is, anything else in the package. */
function folder(item: InstalledPackage, entry: string): string {
  if (entry.startsWith("~/")) return join(home(), entry.slice(2));

  return entry.startsWith("/") ? entry : resolve(item.dir, entry);
}

/** A package's host block's folders and variables where it applies, then its system block's variables where that applies. */
function packageEnvironment(office: Office, item: GatheredPackage): PackageEnvironment {
  const host = item.manifest.host;
  const system = systemVariables(office, item);

  if (host === undefined || !hostApplies(office, item)) return { name: item.entry.name, path: [], variables: system };

  return { name: item.entry.name, path: host.path.map((entry) => folder(item, entry)), variables: [...Object.entries(host.env), ...system] };
}

/** The environment file's content, and a problem per variable two packages both set. */
export type HostEnvironment = { environment: Environment; problems: string[]; contributions: PackageEnvironment[] };

/**
 * The host's environment: the wrappers first while the firewall is on, mise's shims, OpenCode's bin,
 * then the folders packages declare; the release ages, then the variables packages declare. A
 * variable two packages set is left out, named in `problems`.
 */
export function hostEnvironment(office: Office, installed: GatheredPackage[], retained: PackageEnvironment[] = []): HostEnvironment {
  const current = new Map(installed.map(item => [item.entry.name, packageEnvironment(office, item)]));
  const prior = new Map(retained.map(item => [item.name, item]));
  const declared = [...new Set(["office", ...office.packages.map(item => item.name)])].flatMap(name => current.get(name) ?? prior.get(name) ?? []);
  const setters = new Map<string, string[]>();

  for (const item of declared) {
    for (const [name] of item.variables) setters.set(name, [...(setters.get(name) ?? []), item.name]);
  }

  const problems = [...setters].flatMap(([name, names]) => (names.length > 1 ? [`packages ${names.join(" and ")} both set ${name} in their host or system block, so ${envFilePath()} sets neither; remove it from one`] : []));
  const variables: [string, string][] = releaseAgeVariables(office.tools.minimumReleaseAge);
  const path = [...(office.socketFirewall ? [hostWrappers()] : []), miseShims(), opencodeBin()];

  if (office.opencode.managed !== undefined) variables.push(...Object.entries(managedAgentEnvironment));

  for (const item of declared) {
    for (const entry of item.path) if (!path.includes(entry)) path.push(entry);

    for (const [name, value] of item.variables) if ((setters.get(name) ?? []).length === 1) variables.push([name, value]);
  }

  const contributions = declared.flatMap(item => {
    const applied = item.variables.filter(([name]) => setters.get(name)?.length === 1);

    return applied.length || item.path.length ? [{ ...item, variables: applied }] : [];
  });

  return { environment: { path, variables }, problems, contributions };
}

/** The line that sources the environment file, for the user's shell startup file, guarded by its existence. */
export function sourceLine(): string {
  const file = envFilePath();
  const folder = home();
  const shown = file.startsWith(`${folder}/`) ? `"$HOME/${file.slice(folder.length + 1)}"` : shellQuote(file);

  return `[ -r ${shown} ] && . ${shown}`;
}

/** The shell startup files office looks in, in the home folder (zsh's in $ZDOTDIR when set). */
function startupFiles(): string[] {
  const folder = home();
  const zsh = process.env.ZDOTDIR || folder;

  return [...[".zshenv", ".zprofile", ".zshrc", ".zlogin"].map((name) => join(zsh, name)), ...[".bashrc", ".bash_profile", ".profile"].map((name) => join(folder, name))];
}

/** A path as a startup file writes it, with `~`, `$HOME` and `${HOME}` expanded. */
function expand(path: string): string {
  return path.replace(/^(?:~|\$HOME|\$\{HOME\})(?=\/)/, home()).replace(/^["']|["']$/g, "");
}

/** Whether a line, not a comment, names the environment file in any of the ways a startup file would. */
function namesEnvFile(line: string): boolean {
  const file = envFilePath();
  const folder = home();
  const code = line.replace(/(^|\s)#.*$/, "");
  const forms = [file, ...(file.startsWith(`${folder}/`) ? [`/${file.slice(folder.length + 1)}`] : []), ...(process.env[machineDirVariable] ? [] : ["/office/env.sh"])];

  return forms.some((form) => code.includes(form));
}

/**
 * Where the user's shell startup sources the environment file: the first startup file (read through
 * its link, as a dotfiles repository keeps them) or a file one of them sources that names it.
 * Undefined when none does. It reads files only and never runs a shell, so it can't see a line
 * built at run time; a shell that has sourced the file has OFFICE_ENV_FILE set, which is checked first.
 */
export function sourcedBy(): string | undefined {
  if (process.env.OFFICE_ENV_FILE === envFilePath()) return "this shell's environment (OFFICE_ENV_FILE)";

  for (const file of startupFiles()) {
    if (!existsSync(file)) continue;

    const lines = readFileSync(file, "utf8").split("\n");

    if (lines.some(namesEnvFile)) return file;

    for (const line of lines) {
      const included = /^\s*(?:source|\.)\s+(\S+)/.exec(line)?.[1];
      const path = included === undefined ? undefined : expand(included);

      if (path !== undefined && path.startsWith("/") && existsSync(path) && statSync(path).isFile() && readFileSync(path, "utf8").split("\n").some(namesEnvFile)) return `${path}, which ${file} sources`;
    }
  }

  return undefined;
}
