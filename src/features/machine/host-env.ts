import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import type { GatheredPackage } from "../../gather.ts";
import { sha256 } from "../../lib/hash.ts";
import type { InstalledPackage } from "../../loader/definitions/inventory.ts";
import type { Office } from "../../office.ts";
import { managedAgentEnvironment } from "../../schema.ts";
import { projectionPath } from "../tools/applied.ts";
import { systemVariables } from "../mise-integration/system.ts";
import { hostApplies } from "../tooling/requirements.ts";
import { dropFromPath, type Environment, hostWrappers, marker, releaseAgeVariables, shellQuote } from "../tools/sfw.ts";
import type { PlanContext, WantedFile } from "./owned-files.ts";
import { envFilePath, home, machineDirVariable, miseShims, opencodeBin } from "./paths.ts";

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
 * The host's environment: the wrappers first while the firewall is on, the applied shared tools'
 * links (src/features/tools/applied.ts), mise's shims, OpenCode's bin,
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
  // The shared tools applied on this machine come before mise's shims, so a desired pin is never what runs.
  const path = [...(office.socketFirewall ? [hostWrappers()] : []), projectionPath(office), miseShims(), opencodeBin()];

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

/** The environment file's own path, which it exports, so `office check` and a shell can tell it was sourced. */
const envFileVariable = "OFFICE_ENV_FILE";

/**
 * The environment file: POSIX shell for sh, bash and zsh that puts `path` first on PATH in that
 * order, moving an entry already there rather than adding it twice, so sourcing it again changes
 * nothing, then exports the variables. It prints nothing and runs no other program.
 */
export function envScript(what: string, file: string, environment: Environment): string {
  return [
    marker(what),
    "# It sets PATH and plain variables only. Source it with `. <this file>`, after `mise activate` in",
    "# your shell's startup file so the Socket Firewall wrappers stay ahead of mise's tool folders.",
    "__office_path() {",
    ...dropFromPath("__office_rest", "$1").map((line) => `  ${line}`),
    "  __office_rest=${__office_rest%:}",
    '  if [ -n "$__office_rest" ]; then PATH="$1:$__office_rest"; else PATH=$1; fi',
    "}",
    ...environment.path.toReversed().map((entry) => `__office_path ${shellQuote(entry)}`),
    "unset -f __office_path",
    "unset __office_rest",
    "export PATH",
    `export ${envFileVariable}=${shellQuote(file)}`,
    ...environment.variables.map(([name, value]) => `export ${name}=${shellQuote(value)}`),
    "",
  ].join("\n");
}

export function wantedEnvironment({ office, record, packages, unread }: PlanContext) {
  const path = envFilePath();
  const previous = record.files.find(file => file.path === path);
  const retained = previous?.kind === "file" ? previous.contributions?.filter(item => unread.has(item.name)) : [];
  const { environment, problems, contributions } = hostEnvironment(office, packages, retained);
  const text = envScript(`the environment of office ${office.name}, which agents and your terminal share`, path, environment);

  const entry = {
    file: { kind: "file", path, package: null, sha256: sha256(text), contributions },
    what: "the office's environment file",
    made: "; source it from your shell's startup file (office setup prints the line)",
    text,
  } satisfies WantedFile;

  return { entry, problems };
}
