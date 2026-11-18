// Socket Firewall (sfw, https://github.com/SocketDev/sfw-free): every package download an office
// makes goes through it. sfw runs a command behind a local proxy that refuses packages Socket knows
// to be malicious, so the office puts a folder of wrappers first on PATH, one per package manager,
// each running `sfw <tool>`, and a `mise` wrapper that routes mise's installs through it. Package
// managers also wait the minimum release age below before they take a new release.
//
// This module is the one list of what is wrapped and of the variables, and writes the wrappers and
// the environment file both for the container (its image and entrypoint) and for a host-mode
// office's machine (src/machine.ts).
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** How old a package release must be before a package manager takes it, and before upgrade-tools moves sfw. */
export const packageAge = "3d";

/** The package managers whose commands go through sfw, by the names their wrappers have on PATH. */
export const wrappedCommands = ["npm", "npx", "pnpm", "pip", "pip3", "uv", "uvx", "cargo"] as const;

/**
 * The variables that make package managers wait `packageAge` before they take a release: npm in
 * days, pnpm in minutes, uv as a duration it reads relative to now, pip as an ISO 8601 duration.
 */
export const releaseAgeVariables = {
  NPM_CONFIG_MIN_RELEASE_AGE: "3",
  pnpm_config_minimum_release_age: "4320",
  UV_EXCLUDE_NEWER: "3 days",
  PIP_UPLOADED_PRIOR_TO: "P3D",
} satisfies Record<string, string>;

/**
 * Set by a wrapper for the command it runs behind sfw: a wrapper that finds it set runs the real
 * command directly, so a nested call never starts a second sfw even where a shell put the
 * wrappers' folder back on PATH (a script that sources the environment file again).
 */
export const behindSfwVariable = "OFFICE_BEHIND_SFW";

/** The environment file's own path, which it exports, so `office check` and a shell can tell it was sourced. */
export const envFileVariable = "OFFICE_ENV_FILE";

/** Where the sfw binary, its wrappers' script and their folder are, and the real mise the mise wrapper runs. */
export type SfwLayout = { root: string; sfw: string; script: string; bin: string; mise: string };

/** The layout under `root`: sfw at `<root>/sfw`, the wrappers in `<root>/bin`, their script beside them. */
export function sfwLayout(root: string, sfw: string, mise: string): SfwLayout {
  return { root, sfw, script: join(root, "package-manager.sh"), bin: join(root, "bin"), mise };
}

/** `value` as one word for sh, bash and zsh, with nothing in it expanded. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The first line of every file the office writes for sfw and the environment, after a script's `#!` line. */
export function marker(what: string): string {
  return `# office: ${what}. Written by office; don't edit it, office sync or the image rewrites it.`;
}

// Removes every `$1` from PATH, in POSIX sh with no subprocess, leaving the rest in order.
const dropFromPath = (variable: string, entry: string) => [
  `${variable}=":$PATH:"`,
  "while :; do",
  `  case $${variable} in`,
  `    *":${entry}:"*) ${variable}="\${${variable}%%":${entry}:"*}:\${${variable}#*":${entry}:"}" ;;`,
  "    *) break ;;",
  "  esac",
  "done",
  `${variable}=\${${variable}#:}`,
];

/** Refuses to run a download without sfw, rather than run it unchecked: a host-mode office's sfw comes with `office up`. */
function missingSfw(layout: SfwLayout, indent: string): string[] {
  const message = `office: Socket Firewall is not installed at ${layout.sfw}, so this download doesn't run; run office up in the office (or set socket_firewall: false in its office.yaml and run office sync)`;

  return [`if [ ! -x ${shellQuote(layout.sfw)} ]; then`, `${indent}echo ${shellQuote(message)} >&2`, `${indent}exit 127`, "fi"];
}

/**
 * The script every package manager's wrapper links to, run under the wrapper's name: it drops the
 * wrappers' folder from PATH, so sfw finds the real command and a nested call (an npm script that
 * runs npm) reaches the real one behind the same proxy, then runs `sfw <name>`.
 */
export function packageManagerScript(layout: SfwLayout): string {
  return [
    "#!/bin/sh",
    marker(`the Socket Firewall wrapper for ${wrappedCommands.join(", ")}, which link to it`),
    `# It runs the command it was called as through sfw, once: it drops its folder from PATH, and ${behindSfwVariable}=1`,
    "# marks a command already behind sfw.",
    `bin=${shellQuote(layout.bin)}`,
    ...dropFromPath("rest", "$bin"),
    "PATH=${rest%:}",
    "export PATH",
    'name=${0##*/}',
    `if [ "\${${behindSfwVariable}-}" = 1 ]; then exec "$name" "$@"; fi`,
    ...missingSfw(layout, "    "),
    `${behindSfwVariable}=1`,
    `export ${behindSfwVariable}`,
    `exec ${shellQuote(layout.sfw)} "$name" "$@"`,
    "",
  ].join("\n");
}

/**
 * The `mise` wrapper, in the wrappers' folder: `mise install`, `use` and `upgrade` (and their short
 * forms) run behind sfw, `reshim` runs without the folder on PATH so mise points its shims at the
 * real mise, and everything else runs the real mise under the name it was called as, since mise
 * reads its name to act as a tool's shim and `mise activate` writes it into the shell's hook. bash,
 * for `exec -a`.
 */
export function miseWrapperScript(layout: SfwLayout): string {
  return [
    "#!/usr/bin/env bash",
    marker("the mise wrapper that runs mise's installs through Socket Firewall"),
    `real=${shellQuote(layout.mise)}`,
    `bin=${shellQuote(layout.bin)}`,
    "drop() {",
    ...dropFromPath("rest", "$bin").map((line) => `  ${line}`),
    "  PATH=${rest%:}",
    "  export PATH",
    "}",
    '[ "${0##*/}" = mise ] || exec -a "$0" "$real" "$@"',
    'case "${1-}" in',
    "  install | i | use | u | upgrade | up)",
    "    drop",
    `    [ "\${${behindSfwVariable}-}" = 1 ] && exec "$real" "$@"`,
    ...missingSfw(layout, "    "),
    `    export ${behindSfwVariable}=1`,
    `    exec ${shellQuote(layout.sfw)} "$real" "$@"`,
    "    ;;",
    "  reshim)",
    "    drop",
    '    exec "$real" "$@"',
    "    ;;",
    "esac",
    'exec -a "$0" "$real" "$@"',
    "",
  ].join("\n");
}

/** The files of the wrappers' folder: the script, a link to it per package manager, and the mise wrapper. */
export type WrapperFiles = { script: { path: string; text: string }; links: { path: string; target: string }[]; mise: { path: string; text: string } };

export function wrapperFiles(layout: SfwLayout): WrapperFiles {
  return {
    script: { path: layout.script, text: packageManagerScript(layout) },
    links: wrappedCommands.map((command) => ({ path: join(layout.bin, command), target: layout.script })),
    mise: { path: join(layout.bin, "mise"), text: miseWrapperScript(layout) },
  };
}

/** What the environment file sets: PATH entries, first to last, and plain variables. */
export type Environment = { path: string[]; variables: [string, string][] };

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

/** The image's sfw layout: sfw and mise in /usr/local/bin, the wrappers in /usr/local/lib/office/sfw. */
export const containerLayout = sfwLayout("/usr/local/lib/office/sfw", "/usr/local/bin/sfw", "/usr/local/bin/mise");

/** Where the container's entrypoint writes the environment file, which OpenCode, cron and `office exec` source. */
export const containerEnvFile = "/etc/opencode/env.sh";

/** mise's shims in the container user's home, which the image's PATH already puts first. */
const containerShims = "/home/office/.local/share/mise/shims";

/** The container's environment: the wrappers first unless the office turned the firewall off, mise's shims, and the release ages. */
export function containerEnvironment(socketFirewall: boolean): Environment {
  return { path: [...(socketFirewall ? [containerLayout.bin] : []), containerShims], variables: Object.entries(releaseAgeVariables) };
}

/** Writes the image's wrappers (`office sfw-wrappers`, run as root when the image is built). */
export function writeContainerWrappers(): string[] {
  const files = wrapperFiles(containerLayout);

  mkdirSync(containerLayout.bin, { recursive: true });
  writeFileSync(files.script.path, files.script.text, { mode: 0o755 });
  writeFileSync(files.mise.path, files.mise.text, { mode: 0o755 });

  for (const link of files.links) {
    rmSync(link.path, { force: true });
    symlinkSync(link.target, link.path);
  }

  return [files.script.path, files.mise.path, ...files.links.map((link) => link.path)];
}
