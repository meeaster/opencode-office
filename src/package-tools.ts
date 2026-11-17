// The mise tools packages declare (`tools:` in package.yaml). `office sync` writes each package's
// into its own fragment, `.mise/conf.d/<package>.toml` in the office root, which mise loads in the
// office and every folder below it, on the host and in the container. The office's own mise.toml
// in the same folder wins over a fragment, and so does a desk's. The fragment is the office's file,
// committed with it: sync adds a tool the package declares, at the version the package starts it
// at, and removes one it no longer declares, but never changes a version, which `office
// upgrade-tools` bumps like the office's own pins.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import type { Office } from "./office.ts";
import type { InstalledPackage } from "./packages.ts";

/** Where mise loads fragments from in a project folder, beside its mise.toml. */
export const fragmentsFolder = ".mise/conf.d";

/** The fragment that holds a package's tools. */
export function fragmentPath(office: Office, name: string): string {
  return join(office.dir, fragmentsFolder, `${name}.toml`);
}

// The first line of every fragment sync writes, naming its package: how sync and check tell a
// package's fragment from one the office wrote itself.
const marker = /^# The mise tools of package ([a-z0-9][a-z0-9-]*)\./;

function header(name: string): string {
  return [
    `# The mise tools of package ${name}. office sync adds a tool the package declares, at the version`,
    "# it starts at, and removes one it no longer declares, but never changes a version: from then on",
    "# each is the office's, which office upgrade-tools bumps. The same tool in mise.toml wins over it.",
    "",
  ].join("\n");
}

/** The package a fragment's first line names, or undefined for a file sync didn't write. */
function fragmentPackage(text: string): string | undefined {
  return marker.exec(text)?.[1];
}

// A key in a [tools] table: `name = ...`, the name optionally quoted.
const keyPattern = /^\s*("[^"]+"|[A-Za-z0-9_.:@/-]+)\s*=/;

/** Where a fragment's [tools] table starts, and the line of each tool in it, by name. */
type ToolLines = { table: number | undefined; entries: Map<string, number> };

/** Each tool in a fragment's [tools] table, by name, with the line it is on. */
function toolLines(lines: string[]): ToolLines {
  const entries = new Map<string, number>();
  let table: number | undefined;
  let inTools = false;

  for (const [index, line] of lines.entries()) {
    if (/^\s*\[/.test(line)) {
      inTools = /^\s*\[tools\]\s*(#.*)?$/.test(line);

      if (inTools) table ??= index;

      continue;
    }

    const match = inTools ? keyPattern.exec(line) : null;

    if (match !== null) entries.set(match[1].replaceAll('"', ""), index);
  }

  return { table, entries };
}

/** A tool's line as sync adds it. */
function toolLine(tool: string, version: string): string {
  return `"${tool}" = "${version}"`;
}

/** A fragment's new text, with the tools it added and removed. */
type UpdatedFragment = { text: string; added: string[]; removed: string[] };

/**
 * A fragment holding exactly the tools a package declares: the existing text (and every version in
 * it) kept, a declared tool it lacks added at the package's version, and a tool it no longer
 * declares removed.
 */
export function updateFragment(text: string | undefined, name: string, tools: Record<string, string>): UpdatedFragment {
  const declared = Object.keys(tools);

  if (text === undefined) {
    return { text: `${header(name)}[tools]\n${declared.map((tool) => `${toolLine(tool, tools[tool])}\n`).join("")}`, added: declared, removed: [] };
  }

  const lines = text.replace(/\n$/, "").split("\n");
  const { table, entries } = toolLines(lines);
  const added = declared.filter((tool) => !entries.has(tool));
  const removed = [...entries.keys()].filter((tool) => !declared.includes(tool));
  const dropped = new Set(removed.map((tool) => entries.get(tool)));
  const newLines = added.map((tool) => toolLine(tool, tools[tool]));
  // New tools go after the table's last entry, or its header when it has none.
  const anchor = table === undefined ? undefined : Math.max(table, ...entries.values());
  const result: string[] = [];

  for (const [index, line] of lines.entries()) {
    if (!dropped.has(index)) result.push(line);

    if (index === anchor) result.push(...newLines);
  }

  if (anchor === undefined) result.push("[tools]", ...newLines);

  return { text: `${result.join("\n")}\n`, added, removed };
}

/** The fragments in the office's `.mise/conf.d/` that sync wrote, by the package each names. */
function packageFragments(office: Office): Map<string, string> {
  const folder = join(office.dir, fragmentsFolder);
  const found = new Map<string, string>();

  if (!existsSync(folder)) return found;

  for (const file of readdirSync(folder)) {
    if (!file.endsWith(".toml")) continue;

    const owner = fragmentPackage(readFileSync(join(folder, file), "utf8"));

    if (owner !== undefined) found.set(join(folder, file), owner);
  }

  return found;
}

/** Removes `.mise/conf.d/` and `.mise/` when deleting fragments left them empty. */
function removeEmptyFolders(office: Office): void {
  for (const folder of [fragmentsFolder, ".mise"]) {
    const path = join(office.dir, folder);

    if (existsSync(path) && readdirSync(path).length === 0) rmdirSync(path);
  }
}

/**
 * Makes each installed package's fragment hold the tools its package.yaml declares, and deletes the
 * fragment of a package that declares none or that office.yaml no longer lists. `declared` names
 * every package office.yaml lists, so a package that fails to read keeps its fragment. Returns one
 * line per change; a refusal starts with FAILED.
 */
export function syncTools(office: Office, installed: InstalledPackage[], declared: string[]): string[] {
  const changes: string[] = [];

  for (const item of installed) {
    const name = item.entry.name;
    const path = fragmentPath(office, name);
    const where = relative(office.dir, path);
    const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    const tools = item.manifest.tools;

    if (current !== undefined && fragmentPackage(current) !== name) {
      changes.push(`FAILED package ${name}: ${where} is not the fragment office sync writes for it, so its tools aren't written; rename that file`);

      continue;
    }

    if (Object.keys(tools).length === 0) {
      if (current === undefined) continue;

      rmSync(path);
      changes.push(`deleted ${where}, as package ${name} declares no tools`);

      continue;
    }

    const next = updateFragment(current, name, tools);

    if (next.text === current) continue;

    mkdirSync(join(office.dir, fragmentsFolder), { recursive: true });
    writeFileSync(path, next.text);

    if (current === undefined) changes.push(`created ${where} with package ${name}'s tools: ${next.added.map((tool) => `${tool} ${tools[tool]}`).join(", ")}`);

    for (const tool of current === undefined ? [] : next.added) changes.push(`added ${tool} ${tools[tool]} to ${where}, which package ${name} declares`);

    for (const tool of next.removed) changes.push(`removed ${tool} from ${where}, as package ${name} no longer declares it`);
  }

  for (const [path, owner] of packageFragments(office)) {
    if (declared.includes(owner)) continue;

    rmSync(path);
    changes.push(`deleted ${relative(office.dir, path)}, the tools of package ${owner}, which office.yaml no longer lists`);
  }

  removeEmptyFolders(office);

  return changes;
}

/** Notes for a package's line in `office check`, and whether its tools are as declared. */
type ToolReport = { ok: boolean; notes: string[] };

/** What `office check` says of a package's tools. */
export function toolNotes(office: Office, item: InstalledPackage): ToolReport {
  const declared = Object.keys(item.manifest.tools);
  const path = fragmentPath(office, item.entry.name);
  const where = relative(office.dir, path);

  if (!existsSync(path)) return declared.length === 0 ? { ok: true, notes: [] } : { ok: false, notes: [`tools ${declared.join(", ")} are missing: ${where} doesn't exist; office sync writes it`] };

  const text = readFileSync(path, "utf8");

  if (fragmentPackage(text) !== item.entry.name) return { ok: false, notes: [`${where} is not the fragment office sync writes for this package; rename it`] };

  if (declared.length === 0) return { ok: false, notes: [`${where} is left from tools the package no longer declares; office sync deletes it`] };

  const { entries } = toolLines(text.split("\n"));
  const missing = declared.filter((tool) => !entries.has(tool));
  const extra = [...entries.keys()].filter((tool) => !declared.includes(tool));
  const notes = [`tools ${declared.filter((tool) => entries.has(tool)).join(", ") || "none"} in ${where}`];

  if (missing.length > 0) notes.push(`${where} lacks ${missing.join(", ")}; office sync adds ${missing.length === 1 ? "it" : "them"}`);

  if (extra.length > 0) notes.push(`${where} holds ${extra.join(", ")}, which the package no longer declares; office sync removes ${extra.length === 1 ? "it" : "them"}`);

  return { ok: missing.length === 0 && extra.length === 0, notes };
}

/** Fragments of packages office.yaml no longer lists, for `office check`. */
export function orphanFragments(office: Office, declared: string[]): string[] {
  return [...packageFragments(office)].flatMap(([path, owner]) => (declared.includes(owner) ? [] : [`${relative(office.dir, path)} holds the tools of package ${owner}, which office.yaml no longer lists (office sync deletes it)`]));
}

/** The fragments in the office root's `.mise/conf.d/`, the package's and the office's own, which `office upgrade-tools` bumps. */
export function fragmentFiles(office: Office): string[] {
  const folder = join(office.dir, fragmentsFolder);

  if (!existsSync(folder)) return [];

  return readdirSync(folder)
    .filter((file) => file.endsWith(".toml") && !file.startsWith("."))
    .sort()
    .map((file) => join(folder, file));
}
