// The shared tools applied on this machine, as the office records them and a package's script or
// plugin resolves them: `resolveTool(officeRoot, requirement)` is what a handle resolves to. It
// imports only Node's built-ins, so Bun runs it as delivered, through `@office/tools/applied`.
//
// A host-mode office's tools folder (in its state folder, never in the office) holds one
// generation per activation, `generations/<id>/`, with the applied record (`applied.json`) and a
// link per exposed executable (`bin/`). `current` is the one link that names the active
// generation: switching it is the activation, so the record and PATH (`current/bin`) never
// disagree. Sync tells scripts where that folder is in `.office/runtime/tools.json`.
//
// An applied executable is ready only while it is the file activation measured: still there,
// inside the tools folder by its real path, with the SHA-256 recorded. Anything else is drift,
// which identifies a changed file, not who published it; nothing else stands in for a drifted tool.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { compareToolVersions } from "./versions.ts";

/** An executable an applied tool exposes: where it is, and its SHA-256 when activated. */
export type AppliedExecutable = { path: string; sha256: string };

/** One tool as activated: its version, its identity (its executables' SHA-256 as staged), the names its consumers require it by, and its executables. */
export type AppliedTool = { version: string; identity: string; names: string[]; bin: Record<string, AppliedExecutable> };

/** The active tools by backend-qualified name, and the highest version ever applied of every tool, active or not. */
export type AppliedRecord = { tools: Record<string, AppliedTool>; highest: Record<string, string> };

/** Where sync says, inside the office, which tools folder its scripts resolve through. Never committed. */
export const toolsLocationPath = ".office/runtime/tools.json";

/** What `toolsLocationPath` holds: a host-mode office's tools folder, or that a container supplies the tools. */
export type ToolsLocation = { mode: "host"; tools: string } | { mode: "container" };

/** The link naming the active generation. */
export function currentLink(tools: string): string {
  return join(tools, "current");
}

/** The active projection, through the current link: what PATH names. */
export function activeBin(tools: string): string {
  return join(currentLink(tools), "bin");
}

/** The applied record of the active generation, through the current link. */
export function activeRecord(tools: string): string {
  return join(currentLink(tools), "applied.json");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStrings(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every(item => typeof item === "string");
}

function isExecutable(value: unknown): value is AppliedExecutable {
  return isObject(value) && typeof value.path === "string" && typeof value.sha256 === "string";
}

function isTool(value: unknown): value is AppliedTool {
  return isObject(value) && typeof value.version === "string" && typeof value.identity === "string"
    && Array.isArray(value.names) && value.names.every(name => typeof name === "string")
    && isObject(value.bin) && Object.values(value.bin).every(isExecutable);
}

/** The applied record's text checked; throws naming `path` when it isn't one. */
export function parseRecord(text: string, path: string): AppliedRecord {
  let document: unknown;

  try {
    document = JSON.parse(text);
  } catch {
    throw new Error(`${path} isn't the applied tools record: it isn't JSON`);
  }

  if (!isObject(document) || !isObject(document.tools) || !isStrings(document.highest)) throw new Error(`${path} isn't the applied tools record`);
  const tools: Record<string, AppliedTool> = {};

  for (const [name, tool] of Object.entries(document.tools)) {
    if (!isTool(tool)) throw new Error(`${path} isn't the applied tools record: tool ${name} isn't one`);
    tools[name] = tool;
  }

  return { tools, highest: document.highest };
}

/** The active generation's record in `tools`; empty before the first activation. Throws naming the file when it can't be read. */
export function readRecord(tools: string): AppliedRecord {
  const current = lstatSync(currentLink(tools), { throwIfNoEntry: false });

  if (current === undefined) return { tools: {}, highest: {} };

  if (!current.isSymbolicLink()) throw new Error(`${currentLink(tools)} isn't the link office switches between its tool generations; move it aside`);
  const path = activeRecord(tools);

  return parseRecord(readFileSync(path, "utf8"), path);
}

/** How an applied executable differs from what activation measured: gone, outside the tools folder, or changed to the SHA-256 found. */
export type Drift = { bin: string; path: string; recorded: string } & ({ state: "missing" | "outside" } | { state: "changed"; found: string });

/** How `executable`, exposed as `bin` from the tools folder `tools`, differs from what activation recorded; undefined while it is that file. */
export function driftOf(tools: string, bin: string, executable: AppliedExecutable): Drift | undefined {
  const at = { bin, path: executable.path, recorded: executable.sha256 };

  if (!existsSync(executable.path)) return { ...at, state: "missing" };
  const real = realpathSync(executable.path);
  const way = relative(realpathSync(tools), real);

  if (way === "" || way === ".." || way.startsWith(`..${sep}`) || way.startsWith(sep)) return { ...at, state: "outside" };
  const found = `sha256:${createHash("sha256").update(readFileSync(real)).digest("hex")}`;

  return found === executable.sha256 ? undefined : { ...at, state: "changed", found };
}

/** What drift of `tool` at `version` means, for messages: what changed, and that office neither runs nor replaces it. */
export function driftMessage(tool: string, version: string, drift: Drift, tools: string): string {
  const what = drift.state === "changed" ? `is ${drift.found}, not the ${drift.recorded} office activated` : drift.state === "missing" ? "is missing" : "resolves outside the office's tools folder";

  return `tool ${tool} ${version}: its applied executable ${drift.bin} at ${drift.path} ${what}; office neither runs a changed tool nor substitutes another copy: restore the file, or move the office's tools folder ${tools} aside for office up to install afresh`;
}

/** What a requirement resolves to on this machine: nothing yet, an applied version below its minimum, the applied executable, an applied executable that changed since activation, or a container's own tools. */
export type Resolved =
  | { status: "missing" }
  | { status: "upgrade-pending"; version: string }
  | { status: "ready"; version: string; identity: string; path: string }
  | { status: "drifted"; version: string; identity: string; path: string; message: string }
  | { status: "container" };

/** A requirement as `tools.require` declares it, with the one executable to resolve. */
export type Wanted = { name: string; minimum: string; bin: string };

/**
 * `wanted` against `record`, the tools folder `tools`'s: its applied executable only when the
 * applied version meets `wanted.minimum` and the file is still the one activation measured; else
 * `drifted`, with the identity activation recorded.
 */
export function resolveIn(record: AppliedRecord, wanted: Wanted, tools: string): Resolved {
  const name = record.tools[wanted.name] === undefined ? Object.keys(record.tools).find(key => record.tools[key].names.includes(wanted.name)) : wanted.name;
  const tool = name === undefined ? undefined : record.tools[name];
  const executable = tool?.bin[wanted.bin];

  if (name === undefined || tool === undefined || executable === undefined) return { status: "missing" };

  if ((compareToolVersions(tool.version, wanted.minimum) ?? -1) < 0) return { status: "upgrade-pending", version: tool.version };
  const drift = driftOf(tools, wanted.bin, executable);

  if (drift !== undefined) return { status: "drifted", version: tool.version, identity: tool.identity, path: executable.path, message: driftMessage(name, tool.version, drift, tools) };

  return { status: "ready", version: tool.version, identity: tool.identity, path: executable.path };
}

/** Where the office in `officeRoot` keeps its tools, as its last sync said; undefined before one. Throws for a redirected or unreadable file. */
export function readLocation(officeRoot: string): ToolsLocation | undefined {
  const root = resolve(officeRoot);
  const path = join(root, toolsLocationPath);

  for (const part of [join(root, ".office"), join(root, ".office/runtime")]) {
    const info = lstatSync(part, { throwIfNoEntry: false });

    if (info === undefined) return undefined;

    if (!info.isDirectory()) throw new Error(`${part} is a link or not a folder, so the office's applied tools aren't read through it; move it aside and run office sync`);
  }

  const info = lstatSync(path, { throwIfNoEntry: false });

  if (info === undefined) return undefined;

  if (!info.isFile()) throw new Error(`${path} is a link or not a regular file; move it aside and run office sync`);
  const location: unknown = JSON.parse(readFileSync(path, "utf8"));

  if (isObject(location) && location.mode === "container") return { mode: "container" };

  if (isObject(location) && location.mode === "host" && typeof location.tools === "string") return { mode: "host", tools: location.tools };
  throw new Error(`${path} isn't where the office's tools are; run office sync`);
}

/**
 * What `wanted` resolves to in the office in `officeRoot`: the applied executable of that tool once
 * office up has activated a version at or above `wanted.minimum`. A version below it is
 * `upgrade-pending`, and one changed since activation `drifted`, whatever else is on PATH; `container` means the office's container supplies
 * its tools. Throws naming the file when the office's records can't be read.
 */
export function resolveTool(officeRoot: string, wanted: Wanted): Resolved {
  const location = readLocation(officeRoot);

  if (location === undefined) return { status: "missing" };

  if (location.mode === "container") return { status: "container" };

  return resolveIn(readRecord(location.tools), wanted, location.tools);
}
