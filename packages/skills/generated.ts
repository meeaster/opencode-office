import { createHash } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { Entries, JsonValue } from "@office/sdk";
import { tools } from "@office/tools";
import { readLocation, resolveTool } from "@office/tools/applied";
import { stateFolder } from "./git.ts";
import { skillId } from "./settings.ts";
import { type Generate, type GeneratedSource, generatedSources } from "./sources.ts";

/** A source a package declared in this run, with the label messages name it by. */
export type Declared = { owner: string; source: GeneratedSource; label: string };

type OutputRecord = { key: string; skills: string[] };

export type Published = OutputRecord & { folder: string };

/** The office-relative folder holding every generated source's folder. */
export const generatedFolder = `${stateFolder}/generated`;

/** The office-relative folder holding one source's output and any staging for it. */
export function sourceFolder(id: string): string {
  return `${generatedFolder}/${id}`;
}

export function outputFolder(id: string): string {
  return `${sourceFolder(id)}/output`;
}

export const outputRecord = "skills.json";

/**
 * Checks that each folder from the office down to the office-relative `folder` is a real folder,
 * not a link or a file, before anything is written or removed through it; with `create`, makes
 * those missing. Returns whether `folder` is there. Throws naming the first that isn't a folder.
 */
export function ownedFolder(office: string, folder: string, create = false): boolean {
  const parts = folder.split("/");

  for (let end = 1; end <= parts.length; end++) {
    const shown = parts.slice(0, end).join("/");
    const info = lstatSync(join(office, shown), { throwIfNoEntry: false });

    if (info === undefined) {
      if (!create) return false;
      mkdirSync(join(office, shown));
    } else if (!info.isDirectory()) {
      throw new Error(`${shown} is a link or not a folder, so office neither writes nor removes generated skills through it; move it aside and run office up`);
    }
  }

  return true;
}

function isOutputRecord(value: unknown): value is OutputRecord {
  return typeof value === "object" && value !== null && "key" in value && typeof value.key === "string"
    && "skills" in value && Array.isArray(value.skills) && value.skills.every(skill => typeof skill === "string" && skillId.test(skill));
}

export function readPublished(office: string, id: string): Published | undefined {
  const folder = outputFolder(id);

  if (!ownedFolder(office, folder)) return;
  const record = join(office, folder, outputRecord);

  try {
    if (lstatSync(record).isFile()) {
      const value = JSON.parse(readFileSync(record, "utf8"));

      if (isOutputRecord(value)) return { key: value.key, skills: value.skills, folder };
    }
  } catch (error) {
    throw new Error(`${folder}/${outputRecord} isn't a record of published skills; move ${folder} aside and run office up`, { cause: error });
  }

  throw new Error(`${folder}/${outputRecord} isn't a record of published skills; move ${folder} aside and run office up`);
}

/**
 * The generated sources packages declared, and a problem for each whose tool isn't one its package
 * requires at that minimum and executable: a handle `tools.require` didn't return, which nothing
 * would ever install.
 */
export function declaredSources(entries: Entries) {
  const required = entries(tools.requirements);
  const sources: Declared[] = [];
  const problems: string[] = [];

  for (const { owner, value } of entries(generatedSources)) {
    const label = `generated source ${value.id} (package ${owner})`;
    const { name, minimum, bin } = value.tool;

    if (required.some(entry => entry.owner === owner && entry.value.name === name && entry.value.minimum === minimum && entry.value.bin.includes(bin))) sources.push({ owner, source: value, label });
    else problems.push(`${label}: package ${owner} doesn't require tool ${name} ${minimum} with executable ${bin}; pass the handle its tools.require returned`);
  }

  return { sources, problems };
}

function canonical(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonical);

  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Record<string, JsonValue>)[key])]));

  return value;
}

/** What identifies a source's output: the applied tool's version and identity, the generator's revision and its inputs. */
export type KeyParts = { version: string; identity: string; revision: string; inputs: JsonValue };

/** The generator key, `sha256:<hex>`: equal parts give equal keys, whatever order the inputs' fields are in. */
export function generatorKey(parts: KeyParts): string {
  const text = JSON.stringify(["office.skills.generated/1", parts.version, parts.identity, parts.revision, canonical(parts.inputs)]);

  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

function onPath(name: string): string | undefined {
  for (const folder of (process.env.PATH ?? "").split(":").filter(Boolean)) {
    try {
      accessSync(join(folder, name), constants.X_OK);

      return join(folder, name);
    } catch {}
  }
}

/** Where this process runs: whether the office is in container mode, and whether this is the container's own process. */
export type Runner = { container: boolean; inContainer?: () => boolean };

const inDocker = () => existsSync("/.dockerenv");

/** The executable that would generate `source`, with its version and identity, or why none can run here. */
function runnable(office: string, source: GeneratedSource, { container, inContainer = inDocker }: Runner): { executable: string; version: string; identity: string } | { waiting: string } {
  const { name, minimum, bin } = source.tool;
  const location = readLocation(office);

  if (container) {
    if (location === undefined) return { waiting: "office sync hasn't recorded where the office's tools are yet; office sync records it" };

    if (location.mode !== "container") return { waiting: "this office runs in container mode, but its tools record is a host-mode office's; office sync rewrites it" };

    if (!inContainer()) return { waiting: `this office's tools are its container's, and this process isn't running in a container, so ${bin} isn't run here; office up generates it from inside the office's container` };
    const found = onPath(bin);

    if (found === undefined) return { waiting: `${bin} isn't on the container's PATH` };

    return { executable: found, version: "container", identity: `sha256:${createHash("sha256").update(readFileSync(realpathSync(found))).digest("hex")}` };
  }

  if (location?.mode === "container") return { waiting: "this office runs in host mode, but its tools record says a container supplies them; office sync rewrites it" };
  const state = resolveTool(office, source.tool);

  if (state.status === "ready") return { executable: state.path, version: state.version, identity: state.identity };

  if (state.status === "upgrade-pending") return { waiting: `the applied ${name} ${state.version} is below the ${minimum} it needs; office up --upgrade applies a newer one and generates the source` };

  if (state.status === "drifted") return { waiting: state.message };

  return { waiting: `tool ${name} isn't installed yet; office up installs it and generates the source` };
}

/** Why a source that hasn't published yet waits, and what publishes it. */
export function pendingReason(office: string, source: GeneratedSource, runner: Runner): string {
  const found = runnable(office, source, runner);

  return "waiting" in found ? found.waiting : "office up generates it";
}

/** A source ready to generate: the executable to run, its version, the inputs, the key and the generator. */
export type Generation = { executable: string; version: string; key: string; inputs: JsonValue; generate: Generate };

/**
 * The executable and key of a source's next generation, computed without generating, or why it
 * can't generate here. In a host-mode office only the applied tool runs. In a container-mode office
 * only the container's own on PATH, inside that container, whose file's SHA-256 stands in for the
 * applied identity; an applied record of the other mode is refused.
 */
export function nextGeneration(office: string, source: GeneratedSource, runner: Runner): { ready: Generation } | { waiting: string } {
  const functions = generatedSources.generator(source.generator);

  if (functions === undefined) throw new Error(`generated skill source ${source.id}: its generator isn't in this process; declare it with skills.sources.generated`);
  const found = runnable(office, source, runner);

  if ("waiting" in found) return found;
  const { executable, version, identity } = found;
  const inputs = functions.inputs(office);

  return { ready: { executable, version, inputs, key: generatorKey({ version, identity, revision: source.revision, inputs }), generate: functions.generate } };
}
