// What OpenCode sessions in an office load from outside it: the global config folder, the
// compatibility skill folders in the home, the system config folder and the folders above the office,
// as OpenCode discovers them. `office check` lists these for information only.
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

import * as v from "valibot";

import { containerOfficeDir, type Office } from "./office.ts";
import { check } from "./schema.ts";

export type OutsideKind = "config" | "instructions" | "skill" | "plugin" | "agent" | "command" | "MCP server";

/** Printing order: what applies everywhere first, then each kind of item. */
export const outsideKinds: OutsideKind[] = ["config", "instructions", "skill", "plugin", "agent", "command", "MCP server"];

export type OutsideItem = {
  kind: OutsideKind;
  name: string;
  /** Where OpenCode reads it, on this machine. */
  path: string;
  /** The link's target, when `path` is a symbolic link. */
  target?: string;
  /** For a skill the server loaded from elsewhere, the folder or file that won. */
  shadowedBy?: string;
  notes: string[];
};

/** The folders a session reads outside the office, as paths on this machine. */
export type Places = {
  /** Which home this is, for the reader: "the host's home" or "the container's home". */
  label: string;
  /** The session's home, on this machine. */
  home: string;
  /** OpenCode's global config folder. */
  configDir: string;
  /** The system config folder, when this machine can read the session's. */
  systemDir?: string;
  /** Folders above the office that OpenCode's upward walk reaches; `instructions` when it reads their AGENTS.md too. */
  ancestors: { dir: string; instructions: boolean }[];
  /** A path as the session's server reports it, on this machine; undefined when this machine can't read it. */
  fromSession: (path: string) => string | undefined;
};

const containerHome = "/home/office";

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);

  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep));
}

/** Each folder above `dir` up to the filesystem root, or `stop` when given, nearest first. */
function above(dir: string, stop?: string): string[] {
  const folders: string[] = [];

  for (let current = dirname(dir); ; current = dirname(current)) {
    if (stop !== undefined && !contains(stop, current)) break;

    folders.push(current);

    if (dirname(current) === current) break;
  }

  return folders;
}

/** OpenCode's system config folder on this platform. */
function systemDirectory(): string {
  if (process.platform === "darwin") return "/Library/Application Support/opencode";

  if (process.platform === "win32") return join(process.env.ProgramData || "C:\\ProgramData", "opencode");

  return "/etc/opencode";
}

/**
 * Where a session of the office's mode finds its home. On the host (or inside the container) that is
 * this process's home and the config folder OpenCode would pick from XDG_CONFIG_HOME and
 * OPENCODE_CONFIG_DIR; from the host in container mode, the container's home in the office's state.
 */
export function sessionPlaces(office: Pick<Office, "dir" | "state"> & { opencode: Pick<Office["opencode"], "mode"> }, env: NodeJS.ProcessEnv = process.env, home = homedir()): Places {
  if (office.opencode.mode === "container" && env.OFFICE_CONTAINER !== "1") {
    const hostHome = join(office.state, "opencode-home");
    const onHost = (path: string) => (contains(containerOfficeDir, path) ? join(office.dir, relative(containerOfficeDir, path)) : contains(containerHome, path) ? join(hostHome, relative(containerHome, path)) : undefined);

    return {
      label: `the container's home (${containerHome}, kept at ${hostHome})`,
      home: hostHome,
      configDir: join(hostHome, ".config/opencode"),
      // Above the home, the container's folders aren't readable from here.
      ancestors: above(containerOfficeDir, containerHome).map((dir) => ({ dir: join(hostHome, relative(containerHome, dir)), instructions: true })),
      fromSession: onHost,
    };
  }

  const configDir = env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
  const inHome = contains(home, office.dir);

  return {
    label: `${env.OFFICE_CONTAINER === "1" ? "the container's" : "the host's"} home (${home})`,
    home,
    configDir,
    systemDir: systemDirectory(),
    // Config folders are found up to the root; AGENTS.md files up to the home, or not at all outside it.
    ancestors: above(office.dir).map((dir) => ({ dir, instructions: inHome && contains(home, dir) })),
    fromSession: (path) => path,
  };
}

// Backup, trash and editor leftovers: not meant to load, so not listed.
// Matched as a whole name or a trailing suffix, so a skill such as backup-restore still counts.
const leftover = /^(backups?|bak|trash)$|[-_.](backups?|bak|trash)([-_.]?\d*)$|\.(bak|old|orig)$|~$/i;

function ignored(name: string): boolean {
  return name.startsWith(".") || name === "node_modules" || name === "__pycache__" || leftover.test(name);
}

type Entry = { name: string; path: string; type: "file" | "dir" | "other" };

/** A folder's entries, following symbolic links; none when it can't be read. */
function entries(dir: string): Entry[] {
  let names: string[];

  try {
    names = readdirSync(dir).toSorted();
  } catch {
    return [];
  }

  return names.map((name) => {
    const path = join(dir, name);

    try {
      const info = statSync(path);

      return { name, path, type: info.isDirectory() ? "dir" : info.isFile() ? "file" : "other" };
    } catch {
      return { name, path, type: "other" };
    }
  });
}

function linkTarget(path: string): string | undefined {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined;
  } catch {
    return undefined;
  }
}

function item(kind: OutsideKind, name: string, path: string, notes: string[] = []): OutsideItem {
  const target = linkTarget(path);

  const found: OutsideItem = { kind, name, path, notes };

  if (target !== undefined) found.target = target;

  return found;
}

/** Skills in one source folder, as OpenCode finds them: SKILL.md folders up to six levels down, and Markdown files at the top. */
function skills(root: string): OutsideItem[] {
  const found: OutsideItem[] = [];
  const queue = [{ dir: root, depth: 0 }];

  for (const { dir, depth } of queue) {
    const children = entries(dir).filter((entry) => !ignored(entry.name));

    if (children.some((entry) => entry.type === "file" && entry.name === "SKILL.md")) {
      found.push(item("skill", dir.slice(dirname(dir).length + 1), dir));

      continue;
    }

    if (depth === 0) {
      for (const entry of children) {
        if (entry.type === "file" && entry.name.endsWith(".md")) found.push(item("skill", entry.name.slice(0, -3), entry.path));
      }
    }

    // A folder without a SKILL.md isn't a skill; OpenCode looks inside it for grouped ones.
    if (depth < 6) queue.push(...children.filter((entry) => entry.type === "dir").map((entry) => ({ dir: entry.path, depth: depth + 1 })));
  }

  return found;
}

/** Markdown files below `dir` (all levels, or only the top), named by their path without `.md`. */
function markdown(kind: OutsideKind, dir: string, nested: boolean, prefix = "", depth = 0): OutsideItem[] {
  return entries(dir).flatMap((entry) => {
    if (ignored(entry.name)) return [];

    if (entry.type === "file" && entry.name.endsWith(".md")) return [item(kind, `${prefix}${entry.name.slice(0, -3)}`, entry.path)];

    if (entry.type === "dir" && nested && depth < 10) return markdown(kind, entry.path, nested, `${prefix}${entry.name}/`, depth + 1);

    return [];
  });
}

// Only the names the listing reads; OpenCode checks the rest, and nothing else is printed. An
// entry that isn't what OpenCode reads names nothing.
const nothing = v.pipe(v.unknown(), v.transform((): string[] => []));

// A plugin entry: a package or path, { package, options }, or V1's [package, options].
const pluginName = v.union([
  v.pipe(v.string(), v.transform((name) => [name])),
  v.pipe(v.looseObject({ package: v.string() }), v.transform((entry) => [entry.package])),
  v.pipe(v.tuple([v.string(), v.unknown()]), v.transform((entry) => [entry[0]])),
  nothing,
]);

// A server has a type, a command or a url; V1 puts servers directly under `mcp`, V2 under `mcp.servers`.
const server = v.union([v.looseObject({ type: v.string() }), v.looseObject({ command: v.array(v.string()) }), v.looseObject({ url: v.string() })]);

type McpEntry = { server: boolean; names: string[] };

const mcpEntry = v.union([
  v.pipe(server, v.transform((): McpEntry => ({ server: true, names: [] }))),
  v.pipe(v.looseObject({}), v.transform((entry): McpEntry => ({ server: false, names: Object.keys(entry) }))),
  v.pipe(v.unknown(), v.transform((): McpEntry => ({ server: false, names: [] }))),
]);

const configSchema = v.looseObject({
  plugin: v.optional(v.array(pluginName), []),
  plugins: v.optional(v.array(pluginName), []),
  mcp: v.optional(v.record(v.string(), mcpEntry), {}),
});

/** The config file, and the plugins and MCP servers it names. Only names are read from it: it can hold credentials. */
function configFile(path: string): OutsideItem[] {
  const file = item("config", path.slice(dirname(path).length + 1), path);
  let document: unknown;

  try {
    document = Bun.JSONC.parse(readFileSync(path, "utf8"));
  } catch {
    return [{ ...file, notes: ["isn't valid JSON, so its plugins and MCP servers aren't listed"] }];
  }

  const read = check(v.safeParse(configSchema, document));

  if (!read.ok) return [{ ...file, notes: ["doesn't have the shape OpenCode reads, so its plugins and MCP servers aren't listed"] }];

  // Removals and wildcards switch plugins off or on; they add none.
  const plugins = [...read.value.plugin, ...read.value.plugins].flat().flatMap((name) => (name.startsWith("-") || name.includes("*") ? [] : [{ kind: "plugin" as const, name, path, notes: ["listed in its plugins"] }]));

  const servers = Object.entries(read.value.mcp).flatMap(([name, entry]) => {
    if (entry.server) return [name];

    if (name === "servers") return entry.names;

    // `timeout`, and V1 entries with only `enabled`, which OpenCode drops.
    return [];
  });

  return [file, ...plugins, ...servers.map((name) => ({ kind: "MCP server" as const, name, path, notes: [] }))];
}

/** Plugins OpenCode discovers in a config folder's plugin/ and plugins/: .ts and .js files and folders. */
function pluginFolder(dir: string): OutsideItem[] {
  return ["plugin", "plugins"].flatMap((name) =>
    entries(join(dir, name)).flatMap((entry) => {
      if (ignored(entry.name)) return [];

      if (entry.type === "dir") return [item("plugin", entry.name, entry.path)];

      if (entry.type === "file" && /\.(ts|js)$/.test(entry.name)) return [item("plugin", entry.name.replace(/\.(ts|js)$/, ""), entry.path)];

      return [];
    }),
  );
}

/** What a config folder (global, system, or a .opencode/ above the office) contributes. */
function configFolder(dir: string): OutsideItem[] {
  return [
    ...["opencode.json", "opencode.jsonc"].flatMap((name) => (existsSync(join(dir, name)) ? configFile(join(dir, name)) : [])),
    ...["skill", "skills"].flatMap((name) => skills(join(dir, name))),
    ...pluginFolder(dir),
    ...["agent", "agents"].flatMap((name) => markdown("agent", join(dir, name), true)),
    ...["mode", "modes"].flatMap((name) => markdown("agent", join(dir, name), false)),
    ...["command", "commands"].flatMap((name) => markdown("command", join(dir, name), true)),
  ];
}

function resolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** The folder's AGENTS.md, or its CLAUDE.md when it has none, as OpenCode reads them. */
function instructionFile(dir: string): OutsideItem[] {
  const file = ["AGENTS.md", "CLAUDE.md"].find((name) => existsSync(join(dir, name)));

  return file === undefined ? [] : [item("instructions", file, join(dir, file))];
}

// The skills installer's record: skill names and the source each came from.
// Only a plain owner/repo source is shown; anything else in the record isn't printed.
const skillLockSchema = v.looseObject({
  skills: v.record(v.string(), v.looseObject({ source: v.fallback(v.optional(v.pipe(v.string(), v.regex(/^[\w.-]+\/[\w.-]+$/))), undefined) })),
});

/** The skills `~/.agents/.skill-lock.json` records, with each one's source when it is a plain owner/repo name. */
function skillLock(home: string): Map<string, string | undefined> {
  const path = join(home, ".agents/.skill-lock.json");
  let document: unknown;

  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return new Map();
  }

  const read = check(v.safeParse(skillLockSchema, document));

  if (!read.ok) return new Map();

  return new Map(Object.entries(read.value.skills).map(([name, entry]) => [name, entry.source]));
}

/** Everything a session would load from `places`, by reading the folders; nothing is changed. */
export function scanOutside(places: Places): OutsideItem[] {
  const { home, configDir, systemDir } = places;
  const claude = join(home, ".claude");
  const agents = join(home, ".agents");
  const globalRoots = new Set([configDir, claude, agents, ...(systemDir === undefined ? [] : [systemDir])].map(resolved));
  const found: OutsideItem[] = [];

  // The global AGENTS.md; ~/.claude/CLAUDE.md stands in when there is none.
  if (existsSync(join(configDir, "AGENTS.md"))) found.push(item("instructions", "AGENTS.md", join(configDir, "AGENTS.md")));
  else if (existsSync(join(claude, "CLAUDE.md"))) found.push(item("instructions", "CLAUDE.md", join(claude, "CLAUDE.md"), ["read because there is no global AGENTS.md"]));

  if (systemDir !== undefined) found.push(...configFolder(systemDir));

  found.push(...configFolder(configDir), ...skills(join(claude, "skills")), ...skills(join(agents, "skills")));

  // Above the office: config files, .opencode/ folders, compatibility skill folders, AGENTS.md.
  for (const { dir, instructions } of places.ancestors) {
    if (instructions) found.push(...instructionFile(dir));

    for (const name of ["opencode.json", "opencode.jsonc"]) {
      const path = join(dir, name);

      if (existsSync(path) && !globalRoots.has(resolved(dirname(path)))) found.push(...configFile(path));
    }

    const opencode = join(dir, ".opencode");

    if (!globalRoots.has(resolved(opencode))) found.push(...configFolder(opencode));

    for (const name of [".claude", ".agents"]) {
      if (!globalRoots.has(resolved(join(dir, name)))) found.push(...skills(join(dir, name, "skills")));
    }
  }

  const lock = skillLock(home);
  const lockFolders = [join(agents, "skills"), join(claude, "skills"), join(configDir, "skills")];

  for (const entry of found) {
    if (entry.kind !== "skill" || !lock.has(entry.name) || !lockFolders.some((folder) => resolved(dirname(entry.path)) === resolved(folder))) continue;

    const source = lock.get(entry.name);

    entry.notes.push(`recorded in ~/.agents/.skill-lock.json by the skills installer${source === undefined ? "" : `, from ${source}`}`);
  }

  return found;
}

/** What the office itself provides, by name, with a label for each: library skills, package skills, package plugins. */
export type Provided = { skills: Map<string, string>; plugins: Map<string, string> };

/** What the session's server reported loading, as paths on this machine where it can read them. */
export type Loaded = { skills: Map<string, string>; plugins: { id: string; path: string; active: boolean }[] };

/** One warning per outside skill or plugin that has the name of one the office provides, saying which one loads. */
export function shadowing(items: OutsideItem[], provided: Provided, home: string, loaded?: Loaded): string[] {
  return items.flatMap((entry) => {
    const at = shortPath(home, entry.path);

    if (entry.kind === "skill") {
      const own = provided.skills.get(entry.name);

      if (own === undefined) return [];

      const winner = loaded?.skills.get(entry.name);

      const verdict =
        winner === undefined
          ? own.startsWith("package")
            ? "this outside one loads: OpenCode reads skill folders after plugins register their skills"
            : "the office's loads: its .opencode/skills/ is read after global and compatibility skill folders"
          : isSkill(entry, winner)
            ? "the server loads this outside one instead of the office's"
            : "the server loads the office's";

      return [`skill ${entry.name} at ${at} has the name of ${own}; ${verdict}`];
    }

    if (entry.kind === "plugin") {
      const own = provided.plugins.get(entry.name);

      if (own === undefined) return [];

      return [`plugin ${entry.name} at ${at} has the name of ${own}; OpenCode loads plugins outside the office first, and of two with the same plugin ID it keeps the first and rejects the office's as a duplicate`];
    }

    return [];
  });
}

/**
 * Adds what the server reported to the scan: whether each outside skill and plugin found on disk
 * loaded, and the outside ones it loaded that the scan didn't find (such as a `skills` entry in a
 * global config, or a skill in a folder the scan skips as a leftover).
 */
export function withLoaded(items: OutsideItem[], loaded: Loaded, office: string): OutsideItem[] {
  const result = items.map((entry) => {
    if (entry.kind === "skill") {
      const winner = loaded.skills.get(entry.name);

      // Compared as written, not resolved: two links to one skill folder are still two sources.
      if (winner !== undefined && isSkill(entry, winner)) return entry;

      return winner === undefined ? { ...entry, notes: [...entry.notes, "not loaded"] } : { ...entry, shadowedBy: winner.endsWith(`${sep}SKILL.md`) ? dirname(winner) : winner };
    }

    if (entry.kind === "plugin" && !isConfigFile(entry.path)) {
      const match = loaded.plugins.find((plugin) => plugin.path === entry.path || resolved(plugin.path) === resolved(entry.path));

      return match === undefined ? { ...entry, notes: [...entry.notes, "not loaded"] } : { ...entry, name: match.id, notes: [...entry.notes, ...(match.active ? [] : ["failed to load"])] };
    }

    return entry;
  });

  for (const [name, path] of loaded.skills) {
    if (path.includes("://") || contains(office, path) || result.some((entry) => entry.kind === "skill" && isSkill(entry, path))) continue;

    result.push({ kind: "skill", name, path: path.endsWith(`${sep}SKILL.md`) ? dirname(path) : path, notes: ["reported by the server"] });
  }

  for (const plugin of loaded.plugins) {
    if (contains(office, plugin.path) || result.some((entry) => entry.kind === "plugin" && resolved(entry.path) === resolved(plugin.path))) continue;

    result.push({ kind: "plugin", name: plugin.id, path: plugin.path, notes: ["reported by the server", ...(plugin.active ? [] : ["failed to load"])] });
  }

  return result;
}

/** Whether the server's path for a skill (its SKILL.md, or a Markdown file) is this item. */
function isSkill(entry: OutsideItem, path: string): boolean {
  return path === entry.path || path === join(entry.path, "SKILL.md");
}

function isConfigFile(path: string): boolean {
  return /(^|[/\\])opencode\.jsonc?$/.test(path);
}

/** A path under the home as ~/…, others as they are. */
function shortPath(home: string, path: string): string {
  return contains(home, path) ? join("~", relative(home, path)) : path;
}

/** One line per item, in kind order, with paths under the home shortened to ~. */
export function describeOutside(items: OutsideItem[], home: string): string[] {
  const short = (path: string) => shortPath(home, path);

  return outsideKinds.flatMap((kind) =>
    items.flatMap((entry) => {
      if (entry.kind !== kind) return [];

      const where = kind === "config" || kind === "instructions" ? short(entry.path) : `${entry.name}: ${short(entry.path)}`;
      const notes = [...(entry.target === undefined ? [] : [`links to ${entry.target}`]), ...entry.notes, ...(entry.shadowedBy === undefined ? [] : [`not loaded: ${short(entry.shadowedBy)} has the same name and wins`])];

      return [`${kind} ${where}${notes.length === 0 ? "" : ` (${notes.join("; ")})`}`];
    }),
  );
}
