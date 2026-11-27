// What is active on this machine for the office's shared tools, in the office's state folder,
// never in the office. The on-disk layout and its reading are `@office/tools/applied`'s
// (packages/tools/applied.ts), which scripts resolve handles through; this module writes it.
//
// Only activation writes, once for every change it makes: it prepares a new generation (the
// applied record and a link per exposed executable) and switches the one `current` link to it.
// The record and PATH (`current/bin`) are the same activation, before and after the switch.
// Desired pins in office.lock never reach either.
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";

import { activeBin, type AppliedRecord, type AppliedTool, currentLink, driftMessage, driftOf, readRecord, toolsLocationPath, type ToolsLocation } from "../../../packages/tools/applied.ts";
import { type Office, OfficeError } from "../../office.ts";
import { atomicWrite } from "../secrets/secrets.ts";

export type { AppliedExecutable, AppliedTool } from "../../../packages/tools/applied.ts";

/** The applied tools, and the highest version ever applied of each tool. */
export type Applied = { tools: Map<string, AppliedTool>; highest: Map<string, string> };

/** The office's folder of tool state on this machine. */
export function toolsState(office: Pick<Office, "state">): string {
  return join(office.state, "tools");
}

/** The active projection, as PATH names it: one link per exposed executable, through the current generation. */
export function projectionPath(office: Pick<Office, "state">): string {
  return activeBin(toolsState(office));
}

/**
 * `path`, a folder of the office's tool state, made when missing; throws when it is a link or not
 * a folder, so nothing office writes or removes there is redirected elsewhere.
 */
export function ownedFolder(path: string): string {
  mkdirSync(path, { recursive: true });
  const info = lstatSync(path);

  if (!info.isDirectory()) throw new Error(`${path} is a link or not a folder, so office doesn't write its tools there; move it aside`);

  return path;
}

/** The applied tools; empty before the first activation. Throws naming the file when it can't be read. */
export function readApplied(office: Pick<Office, "state">): Applied {
  const record = readRecord(toolsState(office));

  return { tools: new Map(Object.entries(record.tools)), highest: new Map(Object.entries(record.highest)) };
}

function sorted<T>(map: ReadonlyMap<string, T>): Record<string, T> {
  return Object.fromEntries([...map].toSorted(([a], [b]) => a.localeCompare(b)));
}

// A generation's folder name, as activation makes it.
const generationName = /^g-[A-Za-z0-9]+$/;

/**
 * Activates `applied`: prepares a generation holding its record and a link per exposed executable,
 * switches `current` to it in one rename, then removes the generation it replaced. Only a folder
 * this module made, inside the generations folder, is ever removed.
 */
export function activate(office: Pick<Office, "state">, applied: Applied): void {
  const tools = ownedFolder(toolsState(office));
  const generations = ownedFolder(join(tools, "generations"));
  const link = currentLink(tools);
  const current = lstatSync(link, { throwIfNoEntry: false });

  if (current !== undefined && !current.isSymbolicLink()) throw new Error(`${link} isn't the link office switches between its tool generations; move it aside`);
  const previous = current === undefined ? undefined : readlinkSync(link);
  const folder = mkdtempSync(join(generations, "g-"));
  const bin = join(folder, "bin");
  const record: AppliedRecord = { tools: sorted(applied.tools), highest: sorted(applied.highest) };

  mkdirSync(bin);

  for (const tool of applied.tools.values()) {
    for (const [name, executable] of Object.entries(tool.bin)) symlinkSync(executable.path, join(bin, name));
  }

  writeFileSync(join(folder, "applied.json"), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o644 });
  const next = join(tools, `current.${basename(folder)}`);

  symlinkSync(relative(tools, folder), next);
  renameSync(next, link);

  if (previous === undefined) return;
  const replaced = join(tools, previous);

  if (relative(generations, replaced) === basename(replaced) && generationName.test(basename(replaced)) && lstatSync(replaced, { throwIfNoEntry: false })?.isDirectory()) rmSync(replaced, { recursive: true, force: true });
}

/**
 * The applied executable `bin` of a host-mode office's shared tools, with its tool's version;
 * undefined when none is applied. Throws, naming the drift, when that executable isn't the file
 * activation measured, so no other copy is used in its place.
 */
export function appliedExecutable(office: Pick<Office, "state" | "opencode">, bin: string): { path: string; version: string } | undefined {
  if (office.opencode.mode !== "host") return undefined;
  const tools = toolsState(office);

  for (const [name, tool] of readApplied(office).tools) {
    const executable = tool.bin[bin];

    if (executable === undefined) continue;
    const drift = driftOf(tools, bin, executable);

    if (drift !== undefined) throw new OfficeError(driftMessage(name, tool.version, drift, tools));

    return { path: executable.path, version: tool.version };
  }

  return undefined;
}

/** Tells the office's scripts where its tools are (`@office/tools/applied`); writes only when that changes. */
export function publishToolsLocation(office: Pick<Office, "dir" | "state" | "opencode">): string[] {
  const location: ToolsLocation = office.opencode.mode === "host" ? { mode: "host", tools: toolsState(office) } : { mode: "container" };
  const text = `${JSON.stringify(location)}\n`;
  const path = join(office.dir, toolsLocationPath);

  if (lstatSync(path, { throwIfNoEntry: false })?.isFile() && readFileSync(path, "utf8") === text) return [];
  atomicWrite(path, text, 0o644);

  return [`wrote ${toolsLocationPath}`];
}
