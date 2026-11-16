// Finds an office and reads its office.yaml into a checked shape. Everything else takes the
// value returned here, so office.yaml is validated once, at this boundary, by the schema the
// office plugin shares.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import * as v from "valibot";
import { isMap, isNode, isScalar, parse, parseDocument, stringify } from "yaml";

import { check, type OfficeConfig, officeSchema, type PinnedTool } from "./schema.ts";

/** Where the office is mounted in the `opencode` container, and so the folder sessions start in. */
export const containerOfficeDir = "/home/assistant/workspace";

/** The plugins the tool owns; `office sync` keeps each office's copies current. */
export const toolPlugins = ["office", "knowledge"];

export class OfficeError extends Error {}

export type Repository = OfficeConfig["references"][number];

export type Desk = { name: string } & OfficeConfig["desks"][string];

export type CopiedSkill = OfficeConfig["skills"]["copied"][number];

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
  /** The office's services that get their own Executor key, `executor.tokens` in office.yaml. */
  executorTokens: string[];
  secrets?: OfficeConfig["secrets"];
  claude?: OfficeConfig["claude"];
  /** The versions office.yaml pins; undefined when it has no `versions` block (the tool's defaults apply). */
  versions: Partial<Record<PinnedTool, string>> | undefined;
  /** `upgrades` from office.yaml: `minimum_release_age` and per-tool ages. */
  upgrades: Record<string, string>;
  references: Repository[];
  desks: Desk[];
  skills: OfficeConfig["skills"];
  plugins: { name: string; url: string; ref?: string }[];
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
    executorTokens: config.executor.tokens,
    secrets: config.secrets,
    claude: config.claude,
    versions: config.versions,
    upgrades: config.upgrades,
    references: config.references,
    desks: Object.entries(config.desks).map(([deskName, desk]) => ({ name: deskName, ...desk })),
    skills: config.skills,
    plugins: config.plugins.map((plugin) => ({ name: plugin.name, url: plugin.repo, ref: plugin.ref })),
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

/**
 * Sets fields in office.yaml (`[key, field]` → value), keeping every other line as written, and
 * returns the office re-read. A change the schema rejects is never written.
 */
export function updateConfig(office: Office, values: [[string, string], string][]): Office {
  const path = join(office.dir, "office.yaml");
  let text = readFileSync(path, "utf8");

  for (const [[key, field], value] of values) text = setField(text, key, field, value);

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

/** The office named by --office, or the one the current folder is in. */
export function currentOffice(flags: { office?: string }): Office {
  return loadOffice(findOffice(flags.office ?? process.cwd()));
}

/** The `.opencode/skills/` folder of the root (`desk` undefined) or of one desk. */
export function skillsFolder(office: Office, desk: string | undefined): string {
  return desk === undefined ? join(office.dir, ".opencode/skills") : join(office.dir, desk, ".opencode/skills");
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
