// Finds an office and reads its office.yaml into a checked shape. Everything else takes the
// value returned here, so office.yaml is validated once, at this boundary, by the schema the
// office plugin shares.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import * as v from "valibot";
import { isMap, isNode, isScalar, isSeq, parse, parseDocument, stringify } from "yaml";

import { check, type OfficeConfig, officeSchema, type PinnedTool } from "./schema.ts";

/** Where the office is mounted in the `opencode` container, and so the folder sessions start in. */
export const containerOfficeDir = "/home/office/workspace";

export class OfficeError extends Error {}

export type Repository = OfficeConfig["references"][number];

export type Desk = { name: string } & OfficeConfig["desks"][string];

export type CopiedSkill = OfficeConfig["skills"]["copied"][number];

export type PackageEntry = OfficeConfig["packages"][number];

/**
 * Where OpenCode runs. Container mode: the office's `opencode` container. Host mode: an OpenCode
 * server on this machine, which the office never starts or stops. `url` is the server as the host
 * reaches it, `containerUrl` as Executor and the office's other containers do, and `directory` the
 * office's path as the server sees it, where sessions start.
 */
export type OpencodeMode = { mode: "container" | "host"; url: string | undefined; containerUrl: string; directory: string };

export type Office = {
  dir: string;
  name: string;
  state: string;
  opencode: OpencodeMode;
  /** The commit identity and HTTPS credentials office.yaml sets; undefined leaves git's own config. */
  git: OfficeConfig["git"];
  secrets?: OfficeConfig["secrets"];
  /** The versions office.yaml pins; undefined when it has no `versions` block (the tool's defaults apply). */
  versions: Partial<Record<PinnedTool, string>> | undefined;
  /** `upgrades` from office.yaml: `minimum_release_age` and per-tool ages. */
  upgrades: Record<string, string>;
  /** Whether package downloads go through Socket Firewall (`socket_firewall`, on unless false). */
  socketFirewall: boolean;
  references: Repository[];
  desks: Desk[];
  skills: OfficeConfig["skills"];
  plugins: { name: string; url: string; ref?: string }[];
  packages: PackageEntry[];
};

/** Walks up from `start` to the nearest folder holding office.yaml. */
export function findOffice(start: string): string {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "office.yaml"))) return dir;

    if (dirname(dir) === dir) throw new OfficeError(`no office.yaml in ${resolve(start)} or any folder above it`);
  }
}

/** The opencode container's address on the compose network. */
const containerOpencodeUrl = "http://opencode:4096";

// A host server on loopback is reached from containers through Docker's name for the host.
const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);

function opencodeMode(config: OfficeConfig["opencode"], dir: string): OpencodeMode {
  if (config === "container" || config.mode === "container") {
    return { mode: "container", url: undefined, containerUrl: containerOpencodeUrl, directory: containerOfficeDir };
  }

  const url = new URL(config.url);
  const containerUrl = new URL(url);

  if (loopback.has(url.hostname)) containerUrl.hostname = "host.docker.internal";

  return { mode: "host", url: url.origin, containerUrl: containerUrl.origin, directory: dir };
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/** office.yaml checked against the schema; its errors name each field. */
export function readConfig(dir: string): OfficeConfig {
  let document;

  try {
    document = parse(readFileSync(join(dir, "office.yaml"), "utf8"));
  } catch (error) {
    throw new OfficeError(`office.yaml: ${error instanceof Error ? error.message : String(error)}`);
  }

  const result = check(v.safeParse(officeSchema, document));

  if (!result.ok) throw new OfficeError(`office.yaml is not valid:\n${result.errors.map((line) => `  ${line}`).join("\n")}`);

  return result.value;
}

/**
 * Reads the office at `dir`. `state` is where its runtime state lives on this machine:
 * office.yaml's optional `state`, else ~/.local/share/office/<name>.
 */
export function loadOffice(dir: string): Office {
  const config = readConfig(dir);

  return {
    dir,
    name: config.name,
    state: config.state === undefined ? join(homedir(), ".local/share/office", config.name) : resolve(dir, expandHome(config.state)),
    opencode: opencodeMode(config.opencode, dir),
    git: config.git,
    secrets: config.secrets,
    versions: config.versions,
    upgrades: config.upgrades,
    socketFirewall: config.socket_firewall,
    references: config.references,
    desks: Object.entries(config.desks).map(([deskName, desk]) => ({ name: deskName, ...desk })),
    skills: config.skills,
    plugins: config.plugins.map((plugin) => ({ name: plugin.name, url: plugin.repo, ref: plugin.ref })),
    packages: config.packages,
  };
}

/**
 * office.yaml's text with `key.field` set, edited as text so every other line, comment and layout
 * stays as written: a new top-level block goes at the end, a new field after the block's last.
 */
function setField(text: string, key: string, field: string, value: string): string {
  const document = parseDocument(text, { keepSourceTokens: true });
  const block = document.get(key, true);
  const line = `${field}: ${stringify(value).trimEnd()}`;

  if (block === undefined) return `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${key}:\n  ${line}\n`;

  if (!isMap(block) || block.flow === true || block.items.length === 0) throw new OfficeError(`office.yaml: set ${key}.${field} by hand; ${key} isn't a block mapping`);

  const existing = block.get(field, true);

  if (isScalar(existing) && existing.range !== undefined && existing.range !== null) {
    return `${text.slice(0, existing.range[0])}${stringify(value).trimEnd()}${text.slice(existing.range[1])}`;
  }

  const [first] = block.items;
  const last = block.items[block.items.length - 1];
  const start = isNode(first.key) ? first.key.range?.[0] : undefined;
  const end = isNode(last.value) ? last.value.range?.[1] : isNode(last.key) ? last.key.range?.[1] : undefined;

  if (start === undefined || end === undefined) throw new OfficeError(`office.yaml: set ${key}.${field} by hand`);

  const indent = start - text.lastIndexOf("\n", start - 1) - 1;
  // After the line the last value ends on, so a comment there stays on its own line.
  const newline = text.indexOf("\n", end);
  const at = newline === -1 ? text.length : newline;

  return `${text.slice(0, at)}\n${" ".repeat(indent)}${line}${text.slice(at)}`;
}

/** Where `text`'s line holding `at` starts, when only indentation (and `prefix`) comes before `at` on it. */
function lineStart(text: string, at: number, prefix = ""): number | undefined {
  const start = text.lastIndexOf("\n", at - 1) + 1;

  return text.slice(start, at).trim() === prefix ? start : undefined;
}

/** Just past the end of the line `at` is on, its newline included. */
function lineEnd(text: string, at: number): number {
  const newline = text.indexOf("\n", at);

  return newline === -1 ? text.length : newline + 1;
}

function where(path: (string | number)[]): string {
  return path.join(".");
}

/**
 * office.yaml's text without `keys` in the block mapping at `path`, each removed with its line
 * (and a comment on that line), so every other line stays as written.
 */
export function withoutKeys(text: string, path: (string | number)[], keys: string[]): string {
  const map = parseDocument(text).getIn(path, true);

  if (!isMap(map) || map.flow === true) throw new OfficeError(`office.yaml: remove ${keys.join(", ")} from ${where(path)} by hand; it isn't a block mapping`);

  const cuts: [number, number][] = [];

  for (const pair of map.items) {
    if (!isScalar(pair.key) || !keys.includes(String(pair.key.value))) continue;

    const at = pair.key.range?.[0];
    const end = isNode(pair.value) ? pair.value.range?.[1] : pair.key.range?.[1];
    const start = at === undefined ? undefined : lineStart(text, at);

    // A key that shares its line with another (`- repo: ...`) can't go without that one.
    if (start === undefined || end === undefined) throw new OfficeError(`office.yaml: remove ${String(pair.key.value)} from ${where(path)} by hand`);

    cuts.push([start, lineEnd(text, end)]);
  }

  return cuts.reduceRight((result, [start, end]) => `${result.slice(0, start)}${result.slice(end)}`, text);
}

/** office.yaml's text without the item `value` of the list at `path`, keeping every other line as written. */
export function withoutItem(text: string, path: (string | number)[], value: string): string {
  const list = parseDocument(text).getIn(path, true);

  if (!isSeq(list)) return text;

  const item = list.items.find((candidate) => isScalar(candidate) && candidate.value === value);

  if (!isScalar(item) || item.range === undefined || item.range === null || list.range === undefined || list.range === null) return text;

  if (list.flow === true) {
    const kept = list.items.flatMap((other) => (other === item || !isNode(other) || other.range === undefined || other.range === null ? [] : [text.slice(other.range[0], other.range[1])]));

    return `${text.slice(0, list.range[0])}[${kept.join(", ")}]${text.slice(list.range[1])}`;
  }

  const start = lineStart(text, item.range[0], "-");

  if (start === undefined) throw new OfficeError(`office.yaml: remove ${value} from ${where(path)} by hand`);

  return `${text.slice(0, start)}${text.slice(lineEnd(text, item.range[1]))}`;
}

/**
 * Rewrites office.yaml with `edit` and returns the office re-read. A change that doesn't parse or
 * that the schema rejects is never written.
 */
export function editConfig(office: Office, edit: (text: string) => string): Office {
  const path = join(office.dir, "office.yaml");
  const text = edit(readFileSync(path, "utf8"));
  let document;

  try {
    document = parse(text);
  } catch (error) {
    throw new OfficeError(`office.yaml would not parse: ${error instanceof Error ? error.message : String(error)}`);
  }

  const result = check(v.safeParse(officeSchema, document));

  if (!result.ok) throw new OfficeError(`office.yaml would not be valid:\n${result.errors.map((line) => `  ${line}`).join("\n")}`);

  writeFileSync(`${path}.new`, text);
  renameSync(`${path}.new`, path);

  return loadOffice(office.dir);
}

/** Sets fields in office.yaml (`[key, field]` → value), keeping every other line as written, and returns the office re-read. */
export function updateConfig(office: Office, values: [[string, string], string][]): Office {
  return editConfig(office, (text) => values.reduce((result, [[key, field], value]) => setField(result, key, field, value), text));
}

/** The office named by --office, or the one the current folder is in. */
export function currentOffice(flags: { office?: string }): Office {
  return loadOffice(findOffice(flags.office ?? process.cwd()));
}

/** The `.opencode/skills/` folder of the root (`desk` undefined) or of one desk. */
export function skillsFolder(office: Office, desk: string | undefined): string {
  return desk === undefined ? join(office.dir, ".opencode/skills") : join(office.dir, desk, ".opencode/skills");
}

/**
 * The office's one Executor key, `EXECUTOR_TOKEN` and `EXECUTOR_ORGANIZATION`, which OpenCode, `office
 * apps deploy` and the office's own services use. Offices before it kept OpenCode's key as
 * opencode-executor.env; the first command that needs the key renames that file, in one step.
 */
export function executorEnvFile(office: Office): string {
  const path = join(office.state, "office-executor.env");
  const legacy = join(office.state, "opencode-executor.env");

  if (!existsSync(path) && existsSync(legacy)) renameSync(legacy, path);

  return path;
}

/** Reads KEY=value lines from a state file such as secrets.env; missing file → empty. */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};

  return Object.fromEntries(
    readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.includes("=") && !line.startsWith("#"))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}
