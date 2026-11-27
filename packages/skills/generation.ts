// Generated sources as sync, check, list and up see them: declared by a package in this run, and
// either published, with the skills of the generation office up last published, or pending until
// their first publication. Each source keeps everything under its own folder,
// `.office/skills/generated/<id>/`: its generations in `generations/<name>/`, each holding its key
// and skill IDs in `generation.json`, the names of those it made in `generations.json`, and the
// link `current` to the published one. Switching `current` is the publication: every reader takes
// the published generation from it, and the source's skill links go through it.
import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { Entries, JsonValue } from "@office/sdk";
import { tools } from "@office/tools";
import { readLocation, resolveTool } from "@office/tools/applied";
import { stateFolder } from "./git.ts";
import { skillId } from "./settings.ts";
import { type Generate, type GeneratedSource, generatedSources } from "./sources.ts";

/** A source a package declared in this run, with the label messages name it by. */
export type Declared = { owner: string; source: GeneratedSource; label: string };

/** A source's published generation: its generator key, its folder's name and the skill IDs in it. */
export type Published = { key: string; generation: string; skills: string[] };

/** The office-relative folder holding every generated source's folder. */
export const generatedFolder = `${stateFolder}/generated`;

/** The office-relative folder holding one source's generations and its records. */
export function sourceFolder(id: string): string {
  return `${generatedFolder}/${id}`;
}

/** A generation's name: unique, and never a dot file. */
const generationName = /^[0-9a-f]{12}-[0-9a-f]{8}$/;

/** The office-relative folder of a source's generations. */
export function generationsFolder(id: string): string {
  return `${sourceFolder(id)}/generations`;
}

/** The office-relative folder of one of a source's generations. */
export function generationFolder(id: string, generation: string): string {
  return posix.join(generationsFolder(id), generation);
}

/** The file in each generation recording its key and skill IDs, written before it can be published. */
export const generationRecord = "generation.json";

/** The office-relative link to the published generation, which the source's skill links go through. */
export function currentLink(id: string): string {
  return `${sourceFolder(id)}/current`;
}

/** The office-relative record of the generations the source made, which cleanup may remove. */
export function inventoryFile(id: string): string {
  return `${sourceFolder(id)}/generations.json`;
}

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

/** Writes `text` to the office-relative `file`, in a folder `ownedFolder` checked, through a temporary file renamed into place. */
function replaceFile(office: string, file: string, text: string): void {
  const path = join(office, file);
  const temporary = `${path}.${randomUUID()}`;

  writeFileSync(temporary, text, { flag: "wx" });
  renameSync(temporary, path);
}

function regularFile(office: string, file: string, invalid: Error): string | undefined {
  const info = lstatSync(join(office, file), { throwIfNoEntry: false });

  if (info === undefined) return undefined;

  if (!info.isFile()) throw invalid;

  return readFileSync(join(office, file), "utf8");
}

function parseJson(text: string, invalid: Error): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw invalid;
  }
}

/** The names of the generations source `id` made; empty before its first. Throws naming the record when it isn't a regular file holding one. */
export function readInventory(office: string, id: string): string[] {
  const file = inventoryFile(id);
  const invalid = new Error(`${file} isn't a record of generated skill source ${id}'s generations; move it aside and run office up`);
  const text = regularFile(office, file, invalid);

  if (text === undefined) return [];
  const parsed = parseJson(text, invalid);
  const names = typeof parsed === "object" && parsed !== null && "generations" in parsed ? parsed.generations : undefined;

  if (!Array.isArray(names) || !names.every(name => typeof name === "string" && generationName.test(name))) throw invalid;

  return names;
}

/** Records `names` as the generations source `id` made, in its folder `ownedFolder` checked. */
export function writeInventory(office: string, id: string, names: readonly string[]): void {
  replaceFile(office, inventoryFile(id), `${JSON.stringify({ generations: [...new Set(names)] }, null, 2)}\n`);
}

/**
 * The source's published generation, read through `current`, or undefined before its first
 * publication. Throws naming `current` when it isn't a link to a generation holding its record.
 */
export function readPublished(office: string, id: string): Published | undefined {
  const link = currentLink(id);
  const info = lstatSync(join(office, link), { throwIfNoEntry: false });

  if (info === undefined) return undefined;

  if (!info.isSymbolicLink()) throw new Error(`${link} isn't the link office keeps to the published generation; move it aside and run office up`);
  const target = readlinkSync(join(office, link));
  const generation = target.startsWith("generations/") ? target.slice("generations/".length) : "";
  const invalid = new Error(`${link} points at ${target}, which isn't a generation office published; move it aside and run office up`);

  if (!generationName.test(generation)) throw invalid;
  const text = regularFile(office, posix.join(generationFolder(id, generation), generationRecord), invalid);

  if (text === undefined) throw invalid;
  const parsed = parseJson(text, invalid);

  if (typeof parsed !== "object" || parsed === null) throw invalid;
  const { key, skills } = parsed as Record<string, unknown>;

  if (typeof key !== "string" || !Array.isArray(skills) || !skills.every(each => typeof each === "string" && skillId.test(each))) throw invalid;

  return { key, generation, skills };
}

/** Records a generation's key and skill IDs inside it, the folder generate made. */
export function writeGenerationRecord(office: string, id: string, { key, generation, skills }: Published): void {
  replaceFile(office, posix.join(generationFolder(id, generation), generationRecord), `${JSON.stringify({ key, skills }, null, 2)}\n`);
}

/** Publishes `generation` of source `id`: points `current` at it in one rename. Throws when something else is there. */
export function publish(office: string, id: string, generation: string): void {
  if (readPublished(office, id)?.generation === generation) return;
  const staged = join(office, sourceFolder(id), `.current-${randomUUID()}`);

  symlinkSync(`generations/${generation}`, staged);

  try {
    renameSync(staged, join(office, currentLink(id)));
  } finally {
    rmSync(staged, { force: true });
  }
}

/** A fresh generation name for `key`. */
export function newGenerationName(key: string): string {
  return `${key.replace(/^sha256:/, "").slice(0, 12)}-${randomUUID().slice(0, 8)}`;
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

/** What makes two generations of a source the same: the applied tool's version and identity, the generator's revision and its inputs. */
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
