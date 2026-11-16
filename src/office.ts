// Finds an office and reads its office.yaml into a checked shape. Everything else takes the
// value returned here, so office.yaml is validated once, at this boundary.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { parse } from "yaml";

/** Where the office is mounted in the `opencode` container, and so the folder sessions start in. */
export const containerOfficeDir = "/home/assistant/workspace";

/** The plugins the tool owns; `office sync` keeps each office's copies current. */
export const toolPlugins = ["office", "knowledge"];

export class OfficeError extends Error {}

/** A git repository to clone: references, desk repositories and plugins share this shape. */
export type Repository = { name: string; url: string; ref: string | undefined; description: string | undefined };

export type Desk = { name: string; description: string | undefined; repos: Repository[]; skills: string[] };

export type CopiedSkill = { name: string; repo: string; ref: string | undefined; path: string };

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
  references: Repository[];
  desks: Desk[];
  skills: { enabled: string[]; copied: CopiedSkill[] };
  plugins: Omit<Repository, "description">[];
};

/** A parsed YAML value, as office.yaml arrives before it is checked. */
type Yaml = string | number | boolean | null | undefined | Yaml[] | { [key: string]: Yaml };

type Mapping = { [key: string]: Yaml };

const namePattern = /^[a-z0-9][a-z0-9-]*$/;

/** Walks up from `start` to the nearest folder holding office.yaml. */
export function findOffice(start: string): string {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "office.yaml"))) return dir;

    if (dirname(dir) === dir) throw new OfficeError(`no office.yaml in ${resolve(start)} or any folder above it`);
  }
}

function fail(where: string, message: string): never {
  throw new OfficeError(`office.yaml: ${where}: ${message}`);
}

function optionalText(value: Yaml, where: string): string | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value !== "string" || value === "") fail(where, "must be a non-empty string");

  return value;
}

function text(value: Yaml, where: string): string {
  return optionalText(value, where) ?? fail(where, "is required");
}

function name(value: Yaml, where: string): string {
  const checked = text(value, where);

  if (!namePattern.test(checked)) fail(where, `"${checked}" must be lowercase letters, digits and dashes`);

  return checked;
}

function list(value: Yaml, where: string): Yaml[] {
  if (value === undefined || value === null) return [];

  if (!Array.isArray(value)) fail(where, "must be a list");

  return value;
}

function record(value: Yaml, where: string): Mapping {
  if (value === undefined || value === null) return {};

  if (typeof value !== "object" || Array.isArray(value)) fail(where, "must be a mapping");

  return value;
}

function unique<Item extends { name: string }>(items: Item[], where: string): Item[] {
  const seen = new Set<string>();

  for (const item of items) {
    if (seen.has(item.name)) fail(where, `"${item.name}" appears twice`);

    seen.add(item.name);
  }

  return items;
}

function repository(value: Yaml, where: string): Repository {
  const entry = record(value, where);

  return {
    name: name(entry.name, `${where}.name`),
    url: text(entry.url, `${where}.url`),
    ref: optionalText(entry.ref, `${where}.ref`),
    description: optionalText(entry.description, `${where}.description`),
  };
}

function skillNames(value: Yaml, where: string): string[] {
  return list(value, where).map((entry, index) => name(entry, `${where}[${index}]`));
}

/** The opencode container's address on the compose network. */
const containerOpencodeUrl = "http://opencode:4096";

// A host server on loopback is reached from containers through Docker's name for the host.
const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);

function opencodeMode(value: Yaml, dir: string): OpencodeMode {
  const entry = typeof value === "string" ? { mode: value } : record(value, "opencode");
  const mode = entry.mode ?? "container";

  if (mode === "container") {
    if (entry.url !== undefined) fail("opencode.url", "is only read in host mode");

    return { mode, url: undefined, containerUrl: containerOpencodeUrl, directory: containerOfficeDir };
  }

  if (mode !== "host") fail("opencode", `mode must be container or host, not "${String(mode)}"`);

  const url = new URL(text(entry.url, "opencode.url"));
  const containerUrl = new URL(url);

  if (loopback.has(url.hostname)) containerUrl.hostname = "host.docker.internal";

  return { mode, url: url.origin, containerUrl: containerUrl.origin, directory: dir };
}

function expandHome(path: string): string {
  return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

function parseOffice(dir: string): Yaml {
  try {
    return parse(readFileSync(join(dir, "office.yaml"), "utf8"));
  } catch (error) {
    throw new OfficeError(`office.yaml: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Reads the office at `dir`. `state` is where its runtime state lives on this machine:
 * office.yaml's optional `state`, else ~/.local/share/office/<name>.
 */
export function loadOffice(dir: string): Office {
  const config = record(parseOffice(dir), "the file");
  const officeName = name(config.name, "name");
  const skills = record(config.skills, "skills");
  const state = optionalText(config.state, "state");

  const desks = Object.entries(record(config.desks, "desks")).map(([deskName, value]) => {
    const where = `desks.${deskName}`;
    const desk = record(value, where);

    return {
      name: name(deskName, where),
      description: optionalText(desk.description, `${where}.description`),
      repos: unique(
        list(desk.repos, `${where}.repos`).map((entry, index) => repository(entry, `${where}.repos[${index}]`)),
        `${where}.repos`,
      ),
      skills: skillNames(desk.skills, `${where}.skills`),
    };
  });

  const plugins = unique(
    list(config.plugins, "plugins").map((value, index) => {
      const where = `plugins[${index}]`;
      const entry = record(value, where);
      const pluginName = name(entry.name, `${where}.name`);

      // The tool's own plugins live under the same names; a clone there would fight `office sync`.
      if (toolPlugins.includes(pluginName)) fail(`${where}.name`, `"${pluginName}" is one of the tool's own plugins`);

      return { name: pluginName, url: text(entry.repo, `${where}.repo`), ref: optionalText(entry.ref, `${where}.ref`) };
    }),
    "plugins",
  );

  return {
    dir,
    name: officeName,
    state: state === undefined ? join(homedir(), ".local/share/office", officeName) : resolve(dir, expandHome(state)),
    opencode: opencodeMode(config.opencode, dir),
    references: unique(
      list(config.references, "references").map((entry, index) => repository(entry, `references[${index}]`)),
      "references",
    ),
    desks,
    skills: {
      enabled: skillNames(skills.enabled, "skills.enabled"),
      copied: unique(
        list(skills.copied, "skills.copied").map((value, index) => {
          const where = `skills.copied[${index}]`;
          const entry = record(value, where);

          return {
            name: name(entry.name, `${where}.name`),
            repo: text(entry.repo, `${where}.repo`),
            ref: optionalText(entry.ref, `${where}.ref`),
            path: text(entry.path, `${where}.path`),
          };
        }),
        "skills.copied",
      ),
    },
    plugins,
  };
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
