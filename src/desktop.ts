// Package panels for the OpenCode desktop app. The app loads a plugin's GUI only from its own local
// sidecar server, which reads the config of the machine the app runs on, so a package's panel is
// installed on that machine: its bundle is copied into a folder of its own, beside a generated
// package.json that exports only `./gui-experimental` (so no server part ever runs there), and the
// folder's file:// URL joins `plugins` in that machine's opencode.json. The panel still shows for
// sessions on any server and reads its data over RPC from the package's plugin in the office.
//
// The app machine is the host itself, or Windows when the CLI runs in WSL. Inside the office's
// container there is none: panels install from the host. The install is per machine, so the last
// office to sync a panel wins; a record beside the bundle says which office that was.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import * as v from "valibot";

import { check } from "./schema.ts";

/** Where a package keeps its panel's built bundle; a package has a panel when this file exists. */
export const panelBundle = "gui/dist/gui-experimental.cjs";

/** The app machine's folders, overridable so tests and scratch runs never touch the real config. */
export const configDirVariable = "OFFICE_APP_CONFIG_DIR";

export const panelsDirVariable = "OFFICE_APP_PANELS_DIR";

/** A machine whose desktop app can load panels, with its folders as this machine sees them. */
export type AppMachine = {
  /** What the machine is, for messages. */
  label: string;
  /** The app machine's OpenCode config folder, which holds opencode.json or opencode.jsonc. */
  configDir: string;
  /** The folder holding one folder per installed panel. */
  panelsDir: string;
  /** The file:// URL the app machine's sidecar loads a panel's folder from. */
  url(name: string): string;
};

/** Where the CLI runs, for panels: a reachable app machine, the office's container, or neither. */
export type Location = { kind: "app"; machine: AppMachine } | { kind: "container" } | { kind: "unreachable"; reason: string };

/** What detection reads of the machine the CLI runs on; tests give their own. */
export type Probe = {
  env: Record<string, string | undefined>;
  home: string;
  exists(path: string): boolean;
  read(path: string): string;
  /** Runs a command and returns its standard output; throws when it fails. */
  run(command: string, args: string[]): string;
};

export const systemProbe: Probe = {
  env: process.env,
  home: homedir(),
  exists: existsSync,
  read: (path) => readFileSync(path, "utf8"),
  // Windows commands run from a Windows folder, so cmd.exe doesn't warn about a UNC current folder.
  run: (command, args) => execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], cwd: existsSync("/mnt/c") ? "/mnt/c" : "/", timeout: 15_000 }),
};

/** A local folder's file:// URL, for an app machine that is this one. */
function localMachine(label: string, configDir: string, panelsDir: string): AppMachine {
  return { label, configDir, panelsDir, url: (name) => pathToFileURL(join(panelsDir, name)).href };
}

function isWsl(probe: Probe): boolean {
  // WSL_DISTRO_NAME can be empty in agent shells, so the kernel and the interop entry decide.
  if (probe.exists("/proc/sys/fs/binfmt_misc/WSLInterop")) return true;

  try {
    return probe.read("/proc/version").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

/** Windows, seen from WSL: the profile and local app data folders, through cmd.exe and wslpath. */
function windows(probe: Probe): Location {
  let printed: string | undefined;
  const failures: string[] = [];

  // Windows' folders are often left off WSL's PATH.
  for (const command of ["cmd.exe", "/mnt/c/Windows/System32/cmd.exe"]) {
    try {
      printed = probe.run(command, ["/d", "/c", "echo %USERPROFILE%^|%LOCALAPPDATA%"]);

      break;
    } catch (error) {
      failures.push(`${command}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
    }
  }

  if (printed === undefined) return { kind: "unreachable", reason: `this is WSL, but Windows couldn't be asked for its folders (${failures.join("; ")})` };

  const [profile = "", local = ""] = printed.trim().split("|");

  if (!/^[A-Za-z]:\\/.test(profile) || !/^[A-Za-z]:\\/.test(local)) return { kind: "unreachable", reason: `this is WSL, but Windows answered ${JSON.stringify(printed.trim())} for its profile and app data folders` };

  let paths;

  try {
    paths = [profile, local].map((path) => probe.run("wslpath", ["-u", path]).trim());
  } catch (error) {
    return { kind: "unreachable", reason: `this is WSL, but wslpath couldn't map Windows' folders: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}` };
  }

  const [profileDir = "", localDir = ""] = paths;
  const panels = `${local}\\office\\gui`;

  return {
    kind: "app",
    machine: {
      label: "Windows",
      configDir: join(profileDir, ".config/opencode"),
      panelsDir: join(localDir, "office/gui"),
      url: (name) => `file:///${encodeURI(`${panels}\\${name}`.replaceAll("\\", "/"))}`,
    },
  };
}

/** Where the CLI runs, and the app machine it installs panels on. */
export function locate(probe: Probe = systemProbe): Location {
  const configDir = probe.env[configDirVariable];
  const panelsDir = probe.env[panelsDirVariable];

  if (configDir !== undefined && configDir !== "" && panelsDir !== undefined && panelsDir !== "") return { kind: "app", machine: localMachine(`the app machine ${configDirVariable} and ${panelsDirVariable} stand for`, configDir, panelsDir) };

  if (probe.exists("/.dockerenv")) return { kind: "container" };

  if (isWsl(probe)) return windows(probe);

  const config = probe.env.XDG_CONFIG_HOME || join(probe.home, ".config");
  const data = probe.env.XDG_DATA_HOME || join(probe.home, ".local/share");

  return { kind: "app", machine: localMachine("this machine", join(config, "opencode"), join(data, "office/gui")) };
}

/** The app machine's config file: opencode.jsonc when there is one, else opencode.json. */
export function configFile(machine: AppMachine): string {
  const jsonc = join(machine.configDir, "opencode.jsonc");

  return existsSync(jsonc) ? jsonc : join(machine.configDir, "opencode.json");
}

type Token = { kind: string; start: number; end: number; text: string };

/** The JSON tokens of a JSONC text, without whitespace and comments; undefined when a string or comment never ends. */
function tokens(text: string): Token[] | undefined {
  const found: Token[] = [];

  for (let at = 0; at < text.length; ) {
    const char = text.charAt(at);

    if (/\s/.test(char)) {
      at++;
    } else if (text.startsWith("//", at)) {
      const end = text.indexOf("\n", at);

      at = end === -1 ? text.length : end;
    } else if (text.startsWith("/*", at)) {
      const end = text.indexOf("*/", at + 2);

      if (end === -1) return undefined;

      at = end + 2;
    } else if (char === '"') {
      let end = at + 1;

      while (end < text.length && text.charAt(end) !== '"') end += text.charAt(end) === "\\" ? 2 : 1;

      if (end >= text.length) return undefined;

      found.push({ kind: "string", start: at, end: end + 1, text: text.slice(at, end + 1) });
      at = end + 1;
    } else if ("{}[]:,".includes(char)) {
      found.push({ kind: char, start: at, end: at + 1, text: char });
      at++;
    } else {
      const end = /^[^\s{}[\]:,"/]+/.exec(text.slice(at))?.[0].length ?? 1;

      found.push({ kind: "value", start: at, end: at + end, text: text.slice(at, at + end) });
      at += end;
    }
  }

  return found;
}

/** The whitespace that starts the line `at` is on. */
function indentAt(text: string, at: number): string {
  const start = text.lastIndexOf("\n", at - 1) + 1;

  return /^[ \t]*/.exec(text.slice(start))?.[0] ?? "";
}

/** The text `insert` goes after: on its own line when the list's first item is, else after a space. */
function separator(text: string, from: number, first: Token): string {
  return text.slice(from, first.start).includes("\n") ? `\n${indentAt(text, first.start)}` : " ";
}

// Only the field the edit reads, each plugins entry as its source; OpenCode checks the rest. An
// entry is its source, or a [source, options] pair.
const pluginSource = v.union([
  v.string(),
  v.pipe(
    v.looseTuple([v.string()]),
    v.transform(([source]) => source),
  ),
]);

const configSchema = v.looseObject({ plugins: v.optional(v.array(pluginSource)) });

function parseConfig(text: string) {
  let document;

  try {
    document = Bun.JSONC.parse(text);
  } catch (error) {
    return { ok: false as const, errors: [error instanceof Error ? error.message : String(error)] };
  }

  return check(v.safeParse(configSchema, document));
}

/** What adding a plugin to a config's text came to. */
export type ConfigEdit = { kind: "present" } | { kind: "added"; text: string } | { kind: "failed"; reason: string };

/**
 * The config's text with `url` added to its top-level `plugins` (created when missing). Every other
 * character stays, comments and formatting included, and the result must parse to the same
 * configuration with the one entry added, or nothing changes.
 */
export function withPlugin(text: string, url: string): ConfigEdit {
  const before = parseConfig(text);

  if (!before.ok) return { kind: "failed", reason: `it doesn't parse as a configuration: ${before.errors.join("; ")}` };

  if ((before.value.plugins ?? []).includes(url)) return { kind: "present" };

  const found = tokens(text);

  if (found === undefined || found[0]?.kind !== "{") return { kind: "failed", reason: "it isn't one JSON object" };

  const entry = JSON.stringify(url);
  let depth = 0;
  let edited: string | undefined;

  for (const [index, token] of found.entries()) {
    if (token.kind === "{" || token.kind === "[") depth++;
    else if (token.kind === "}" || token.kind === "]") depth--;

    const open = found[index + 2];

    if (depth !== 1 || token.kind !== "string" || token.text !== '"plugins"' || found[index + 1]?.kind !== ":" || open?.kind !== "[") continue;

    // The list's closing bracket, and its last token before it.
    let level = 0;
    let close = index + 2;

    for (; close < found.length; close++) {
      const kind = found[close]?.kind;

      if (kind === "[" || kind === "{") level++;
      else if ((kind === "]" || kind === "}") && --level === 0) break;
    }

    const first = found[index + 3];
    const last = found[close - 1];

    if (first === undefined || last === undefined || close >= found.length) break;

    if (last === open) {
      edited = `${text.slice(0, open.end)}${entry}${text.slice(open.end)}`;
    } else {
      const gap = separator(text, open.end, first);
      // On a list of one item per line, the entry goes after a comment ending the last item's line.
      const lineEnd = text.indexOf("\n", last.end);
      const at = gap.startsWith("\n") && lineEnd !== -1 && /^[ \t]*(\/\/.*)?$/.test(text.slice(last.end, lineEnd)) ? lineEnd : last.end;

      edited = `${text.slice(0, last.end)}${last.kind === "," ? "" : ","}${text.slice(last.end, at)}${gap}${entry}${text.slice(at)}`;
    }

    break;
  }

  if (edited === undefined && before.value.plugins === undefined) {
    const brace = found[0];
    const firstKey = found[1];

    edited =
      firstKey === undefined || firstKey.kind === "}"
        ? `${text.slice(0, brace.end)} "plugins": [${entry}] ${text.slice(firstKey?.start ?? brace.end)}`
        : `${text.slice(0, brace.end)}${separator(text, brace.end, firstKey)}"plugins": [${entry}],${text.slice(brace.end)}`;
  }

  if (edited === undefined) return { kind: "failed", reason: "its plugins list couldn't be found in the text" };

  const after = parseConfig(edited);
  const expected = { ...before.value, plugins: [...(before.value.plugins ?? []), url] };

  return after.ok && Bun.deepEquals(after.value, expected) ? { kind: "added", text: edited } : { kind: "failed", reason: "adding the entry would have changed more than the plugins list" };
}

/** Whether the app machine's config lists `url` under `plugins`; undefined when the config can't be read. */
export function isRegistered(machine: AppMachine, url: string): boolean | undefined {
  const path = configFile(machine);

  if (!existsSync(path)) return false;

  const read = parseConfig(readFileSync(path, "utf8"));

  return read.ok ? (read.value.plugins ?? []).includes(url) : undefined;
}

/**
 * Adds a panel's folder to `plugins` in the app machine's config, creating the file when there is
 * none. Returns one line per change; a refusal starts with FAILED. Messages never quote the file,
 * which can hold credentials.
 */
export function register(machine: AppMachine, url: string): string[] {
  const path = configFile(machine);

  if (!existsSync(path)) {
    mkdirSync(machine.configDir, { recursive: true });
    writeFileSync(path, `${JSON.stringify({ plugins: [url] }, null, 2)}\n`);

    return [`created ${path} with ${url} in plugins`];
  }

  const edit = withPlugin(readFileSync(path, "utf8"), url);

  if (edit.kind === "present") return [];

  if (edit.kind === "failed") return [`FAILED to add ${url} to plugins in ${path}: ${edit.reason}; add it yourself`];

  writeFileSync(path, edit.text);

  return [`added ${url} to plugins in ${path}`];
}

/** The record beside an installed bundle: which office installed it, from which folder, and the bundle's hash. */
const recordSchema = v.object({ office: v.string(), dir: v.string(), package: v.string(), sha256: v.string(), installed: v.string() });

export type PanelRecord = v.InferOutput<typeof recordSchema>;

/** The record's name in a panel's folder. */
export const panelRecordFile = "office-panel.json";

/** The bundle's name in a panel's folder, which its package.json exports. */
const installedBundle = "gui-experimental.cjs";

/** A package's panel, as an office has it. */
export type Panel = { name: string; bundle: string };

/** The app's plugin ID for a package's panel: its generated package.json's name. */
export function panelId(name: string): string {
  return `office-${name}`;
}

export function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** A panel's folder on the app machine. */
export function panelDir(machine: AppMachine, name: string): string {
  return join(machine.panelsDir, name);
}

/** The panels installed on the app machine, by package name. */
export function installedPanelNames(machine: AppMachine): string[] {
  if (!existsSync(machine.panelsDir)) return [];

  return readdirSync(machine.panelsDir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? [entry.name] : []));
}

/** The record of an installed panel, or undefined when there is none or it can't be read. */
export function readPanelRecord(machine: AppMachine, name: string): PanelRecord | undefined {
  const path = join(panelDir(machine, name), panelRecordFile);

  if (!existsSync(path)) return undefined;

  try {
    const read = check(v.safeParse(recordSchema, JSON.parse(readFileSync(path, "utf8"))));

    return read.ok ? read.value : undefined;
  } catch {
    return undefined;
  }
}

/** An installed panel against the office's copy. */
export type PanelState = {
  /** The record of what is installed, when anything is. */
  record: PanelRecord | undefined;
  /** Whether the installed bundle is the office's, byte for byte. */
  current: boolean;
  /** Whether the app machine's config lists the panel's folder; undefined when it can't be read. */
  registered: boolean | undefined;
};

export function panelState(machine: AppMachine, panel: Panel): PanelState {
  const dir = panelDir(machine, panel.name);
  const installed = join(dir, installedBundle);
  const current = existsSync(installed) && existsSync(join(dir, "package.json")) && readFileSync(installed).equals(readFileSync(panel.bundle));

  return { record: readPanelRecord(machine, panel.name), current, registered: isRegistered(machine, machine.url(panel.name)) };
}

/**
 * Installs a package's panel on the app machine for `office`: copies the bundle when it differs from
 * the installed one, writes the generated package.json and the record, and registers the folder.
 * The bundle is renamed into place, so the watching sidecar never loads half a file. Returns one
 * line per change.
 */
export function installPanel(machine: AppMachine, office: { name: string; dir: string }, panel: Panel): string[] {
  const dir = panelDir(machine, panel.name);
  const content = readFileSync(panel.bundle);
  const hash = sha256(content);
  const state = panelState(machine, panel);
  const recorded = state.record?.sha256 === hash && state.record.office === office.name && state.record.dir === office.dir;
  const changes: string[] = [];

  if (!state.current || !recorded) {
    const manifest = `${JSON.stringify({ name: panelId(panel.name), exports: { "./gui-experimental": `./${installedBundle}` } }, null, 2)}\n`;
    const record: PanelRecord = { office: office.name, dir: office.dir, package: panel.name, sha256: hash, installed: new Date().toISOString() };

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), manifest);
    writeFileSync(join(dir, `.${installedBundle}.new`), content);
    renameSync(join(dir, `.${installedBundle}.new`), join(dir, installedBundle));
    writeFileSync(join(dir, panelRecordFile), `${JSON.stringify(record, null, 2)}\n`);

    const previous = state.record === undefined ? "" : state.record.office === office.name ? "" : `, replacing the copy office ${state.record.office} installed`;

    changes.push(`${state.record === undefined && !state.current ? "installed" : "updated"} panel ${panelId(panel.name)} on ${machine.label} in ${dir}${previous}`);
  }

  return [...changes, ...register(machine, machine.url(panel.name))];
}

/** How to remove a panel by hand: the install is per machine and other offices may use it. */
export function removalNote(machine: AppMachine, name: string): string {
  return `panel ${panelId(name)} stays installed on ${machine.label}, since other offices may use it; to remove it, delete ${panelDir(machine, name)} and remove ${machine.url(name)} from plugins in ${configFile(machine)}`;
}
