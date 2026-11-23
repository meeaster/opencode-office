// Finds an office and reads its office.yaml into a checked shape. Everything else takes the
// value returned here, so office.yaml is validated once, at this boundary, by the schema the
// office plugin shares.
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { dirname, join, resolve } from "node:path";

import * as v from "valibot";
import { isMap, isNode, isScalar, isSeq, parse, parseDocument, stringify } from "yaml";

import { check, type OfficeConfig, officeSchema, type Parsed, type ResolvedTools, resolveTools, scalarSetting, type SettingValue } from "./schema.ts";

/** Where the office is mounted in the `opencode` container, and so the folder sessions start in. */
export const containerOfficeDir = "/home/office/workspace";

export class OfficeError extends Error {}

export type Repository = OfficeConfig["references"][number];

export type Desk = { name: string } & OfficeConfig["desks"][string];

export type PackageEntry = OfficeConfig["packages"][number];

/**
 * Where OpenCode runs. Container mode: the office's `opencode` container. Host mode: an OpenCode
 * server on this machine, optionally managed by office. `url` is the server as the host
 * reaches it, `containerUrl` as Executor and the office's other containers do, and `directory` the
 * office's path as the server sees it, where sessions start.
 */
export type OpencodeMode = { mode: "container" | "host"; url: string | undefined; containerUrl: string; directory: string; managed?: { envCommands: Record<string, string>; listenHost?: "0.0.0.0" } };

export type Office = {
  dir: string;
  name: string;
  state: string;
  opencode: OpencodeMode;
  catalogApps: string[];
  /** The commit identity and HTTPS credentials office.yaml sets; undefined leaves git's own config. */
  git: OfficeConfig["git"];
  secrets?: OfficeConfig["secrets"];
  /** The runtimes' versions and every release age, from `tools` (or the keys before it). */
  tools: ResolvedTools;
  /** Whether package downloads go through Socket Firewall: on unless sfw's `enabled` under `tools` is false. */
  socketFirewall: boolean;
  references: Repository[];
  desks: Desk[];
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

  const mode: OpencodeMode = { mode: "host", url: url.origin, containerUrl: containerUrl.origin, directory: dir };

  if (config.managed) mode.managed = { envCommands: config.env_commands ?? {}, listenHost: config.listen_host };

  return mode;
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/** Parse office.yaml once, validating the fields needed by this reader. */
export function readOfficeFields<S extends v.GenericSchema>(dir: string, schema: S, logLevel: "warn" | "error" = "warn"): v.InferOutput<S> {
  let document;

  try {
    document = parse(readFileSync(join(dir, "office.yaml"), "utf8"), { stringKeys: true, logLevel });
  } catch (error) {
    throw new OfficeError(`office.yaml: ${error instanceof Error ? error.message : String(error)}`);
  }

  const result = check(v.safeParse(schema, document));

  if (!result.ok) throw new OfficeError(`office.yaml is not valid:\n${result.errors.map((line) => `  ${line}`).join("\n")}`);

  return result.value;
}

export function readConfig(dir: string): OfficeConfig {
  return readOfficeFields(dir, officeSchema);
}

/**
 * Reads the office at `dir`. `state` is where its runtime state lives on this machine:
 * office.yaml's optional `state`, else ~/.local/share/office/<name>.
 */
export function loadOffice(dir: string, config = readConfig(dir)): Office {
  const tools = resolveTools(config);

  return {
    dir,
    name: config.name,
    state: config.state === undefined ? join(homedir(), ".local/share/office", config.name) : resolve(dir, expandHome(config.state)),
    opencode: opencodeMode(config.opencode, dir),
    catalogApps: config.executor?.catalog_apps ?? [],
    git: config.git,
    secrets: config.secrets,
    tools,
    socketFirewall: tools.socketFirewall,
    references: config.references,
    desks: Object.entries(config.desks).map(([deskName, desk]) => ({ name: deskName, ...desk })),
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

function where(path: (string | number)[]): string {
  return path.join(".");
}

/** `value` as a YAML scalar that reads back the same in a block or flow collection: plain when that is safe, JSON-quoted otherwise. */
function scalarText(value: string | number | boolean): string {
  const plain = stringify(value).trimEnd();

  // A number or true/false is never plain text equal to itself, and its JSON is the same YAML.
  if (plain === value && !/[,[\]{}:#]/.test(plain)) return plain;

  return JSON.stringify(value);
}

/**
 * office.yaml's text with the scalar already at `path` (such as `packages.2.ref`) replaced by
 * `value`, quoted as YAML needs, keeping every other character as written. A block scalar's
 * header comment stays on its line.
 */
export function withScalar(text: string, path: (string | number)[], value: string | number | boolean): string {
  const node = parseDocument(text).getIn(path, true);

  if (!isScalar(node) || node.range === undefined || node.range === null) throw new OfficeError(`office.yaml: set ${where(path)} to ${value} by hand`);
  const [start, end] = node.range;

  if (node.type !== "BLOCK_LITERAL" && node.type !== "BLOCK_FOLDED") return `${text.slice(0, start)}${scalarText(value)}${text.slice(end)}`;

  // A block scalar's range runs from its indicators, through the rest of its header line, to the end of its last line.
  const block = text.slice(start, end);
  const indicators = /^[|>](?:[1-9][+-]?|[+-][1-9]?)?/.exec(block)?.[0];

  if (indicators === undefined) throw new OfficeError(`office.yaml: set ${where(path)} to ${value} by hand`);
  const newline = block.indexOf("\n");
  const header = newline === -1 ? block : block.slice(0, newline).replace(/\r$/, "");
  // The header line's own ending, not the body's last, which can differ; none when the block ends the file unterminated.
  const lineBreak = block.endsWith("\n") ? block.slice(header.length, newline + 1) : "";

  return `${text.slice(0, start)}${scalarText(value)}${header.slice(indicators.length)}${lineBreak}${text.slice(end)}`;
}

function writeConfig(path: string, text: string) {
  writeFileSync(`${path}.new`, text);
  renameSync(`${path}.new`, path);
}

function decodeConfig(text: string) {
  try {
    return parse(text);
  } catch (error) {
    throw new OfficeError(`office.yaml would not parse: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Rewrites office.yaml with `edit` and returns the office re-read. A change that doesn't parse or
 * that the schema rejects is never written.
 */
export function editConfig(office: Office, edit: (text: string) => string): Office {
  const path = join(office.dir, "office.yaml");
  const text = edit(readFileSync(path, "utf8"));
  const result = check(v.safeParse(officeSchema, decodeConfig(text)));

  if (!result.ok) throw new OfficeError(`office.yaml would not be valid:\n${result.errors.map((line) => `  ${line}`).join("\n")}`);
  writeConfig(path, text);

  return loadOffice(office.dir);
}

/** A path inside a package's settings: keys and list positions, at least one. */
const settingPath = v.pipe(v.array(v.union([v.pipe(v.string(), v.nonEmpty()), v.pipe(v.number(), v.integer(), v.minValue(0))])), v.minLength(1));

type Decoded = string | number | boolean | null | Decoded[] | { [key: string]: Decoded };

/** `root` with `value` at `path`, copying each collection on the way so an aliased one elsewhere keeps its value. */
function withDecoded(root: Decoded, path: readonly (string | number)[], value: Decoded): Decoded {
  if (path.length === 0) return value;
  const [part, ...rest] = path;

  if (Array.isArray(root)) return root.map((item, index) => index === part ? withDecoded(item, rest, value) : item);

  if (root === null || typeof root !== "object") throw new OfficeError(`office.yaml: no setting at ${where([...path])}`);

  return { ...root, [part]: withDecoded(root[part], rest, value) };
}

/**
 * Replaces the scalar already at `path` in package `name`'s own settings entry, keeping every
 * other character of office.yaml. Nothing is written when the path leads outside that entry's
 * settings or to no scalar, when the edited document would read back as more than that one
 * value changed (an anchor shared through an alias, say), or when office.yaml's schema or
 * `validate` (the package's settings schema, given the edited entry) rejects the result. Returns
 * the settings `validate` gave.
 */
export function replacePackageSetting(office: Office, name: string, path: readonly (string | number)[], value: string | number | boolean, validate: (entry: PackageEntry) => Parsed<Record<string, SettingValue>>): Record<string, SettingValue> {
  const at = `packages.${name}.settings${path.map(part => `.${part}`).join("")}`;

  // A package's code calls this: its arguments are checked here, not trusted to their types.
  if (!v.is(settingPath, path)) throw new OfficeError(`${at}: a setting path is one or more keys and list positions`);

  if (!v.is(scalarSetting, value)) throw new OfficeError(`${at}: the new value must be text, a number or true/false`);
  const file = join(office.dir, "office.yaml");
  const text = readFileSync(file, "utf8");
  const packages = parseDocument(text).get("packages", true);
  const index = isSeq(packages) ? packages.items.findIndex(item => isMap(item) && item.get("name") === name) : -1;

  if (index === -1) throw new OfficeError(`${at}: office.yaml has no entry for package ${name}`);
  const target = ["packages", index, "settings", ...path];

  if (!isScalar(parseDocument(text).getIn(target, true))) throw new OfficeError(`${at}: office.yaml has no setting there to replace`);
  const candidate = withScalar(text, target, value);
  const decoded = decodeConfig(candidate);

  if (!isDeepStrictEqual(decoded, withDecoded(decodeConfig(text), target, value))) throw new OfficeError(`${at}: office.yaml would change more than that setting (is its value shared through an anchor?); edit it by hand`);
  const document = check(v.safeParse(officeSchema, decoded));

  if (!document.ok) throw new OfficeError(`office.yaml would not be valid:\n${document.errors.map((line) => `  ${line}`).join("\n")}`);
  const entry = document.value.packages.find(item => item.name === name);
  const settings = entry === undefined ? { ok: false as const, errors: [`office.yaml has no entry for package ${name}`] } : validate(entry);

  if (!settings.ok) throw new OfficeError(`${at}: the package's settings would not be valid:\n${settings.errors.map((line) => `  ${line}`).join("\n")}`);
  writeConfig(file, candidate);

  return settings.value;
}

/** Sets fields in office.yaml (`[key, field]` → value), keeping every other line as written, and returns the office re-read. */
export function updateConfig(office: Office, values: [[string, string], string][]): Office {
  return editConfig(office, (text) => values.reduce((result, [[key, field], value]) => setField(result, key, field, value), text));
}

/** The office named by --office, or the one the current folder is in. */
export function currentOffice(flags: { office?: string }): Office {
  return loadOffice(findOffice(flags.office ?? process.cwd()));
}

/**
 * The office's one Executor key, `EXECUTOR_TOKEN` and `EXECUTOR_ORGANIZATION`, which OpenCode, `office
 * apps deploy` and the office's own services use.
 */
export function executorEnvFile(office: Office): string {
  return join(office.state, "office-executor.env");
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
