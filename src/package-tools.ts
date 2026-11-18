// The mise tools packages declare (`tools:` in package.yaml, and `host.tools` in a host-mode
// office), and a package's host install (`host.install`). `office sync` writes each package's into
// its own fragment, `.office/mise/<package>.toml`, beside `.office/packages/`: the tool's folder,
// where mise loads nothing by itself. A fragment takes effect only through its link in mise's
// global conf.d (src/machine.ts: a host-mode office's machine, or the container), as does the
// office's own `machine.toml` at its root, so both apply in every folder alike; a mise.toml (the
// office's, a desk's, a project's) wins over them in its folder, as project config wins over
// global. mise does load `mise/config.toml` and `mise.toml` in place below `.office/`, so `config`
// and `mise` are reserved package names, as is `machine`.
//
// The fragment is the office's file, committed with it. Its [tools] table is the office's: sync
// adds a tool the package declares, at the version the package starts it at, and removes one it no
// longer declares, but never changes a version, which `office upgrade-tools` bumps like the
// office's own pins. Everything after that table is sync's alone: the [hooks] postinstall and the
// `<package>:install` task of a host install, written only in a host-mode office (with the
// package's switch on), and rewritten or removed as that changes.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

import type { Office } from "./office.ts";
import type { InstalledPackage } from "./packages.ts";

/** Where sync writes packages' fragments: in the tool's `.office/`, where mise loads nothing by itself. */
export const fragmentsFolder = ".office/mise";

/** The package whose tools are the ones the office CLI itself runs: SOPS, age, gh and pre-commit (src/host-tools.ts). */
export const cliToolsPackage = "office";

/** The office's own machine-wide mise file, at its root, which mise doesn't load by itself either. */
export const machineFile = "machine.toml";

/** The fragment that holds a package's tools. */
export function fragmentPath(office: Office, name: string): string {
  return join(office.dir, fragmentsFolder, `${name}.toml`);
}

// The first line of every fragment sync writes, naming its package: how sync and check tell a
// package's fragment from one the office wrote itself.
const marker = /^# The mise tools of package ([a-z0-9][a-z0-9-]*)\./;

function header(name: string): string[] {
  return [
    `# The mise tools of package ${name}. office sync owns which tools are here: it adds a tool the`,
    "# package declares, at the version it starts at, and removes one it no longer declares (office",
    "# check reports a tool added or removed by hand). The versions are the office's: sync never changes",
    "# one, and office upgrade-tools bumps them. mise doesn't load this file where it is: in a host-mode",
    "# office, office sync links it into mise's global conf.d, and the container links it inside",
    "# itself, so it applies in every folder. machine.toml at the office root is the office's own and",
    "# wins over it, and the same tool in a mise.toml wins in that mise.toml's folder. These comment",
    "# lines and anything after the [tools] table are office sync's, rewritten on every sync.",
  ];
}

/** The package a fragment's first line names, or undefined for a file sync didn't write. */
function fragmentPackage(text: string): string | undefined {
  return marker.exec(text)?.[1];
}

/** The package whose tools the file at `path` holds, or undefined for one sync didn't write, such as machine.toml. */
export function fragmentOwner(path: string): string | undefined {
  return fragmentPackage(readFileSync(path, "utf8"));
}

/** Whether the package's own switch for its host block, if it names one, is on. */
function switchedOn(item: InstalledPackage): boolean {
  const setting = item.manifest.host?.setting;

  return setting === undefined || String(item.settings[setting]) === "true";
}

/** Whether a package's host block applies: the office runs OpenCode on the host, and the package's switch is on. */
export function hostApplies(office: Office, item: InstalledPackage): boolean {
  return item.manifest.host !== undefined && office.opencode.mode === "host" && switchedOn(item);
}

/** The tools a package's fragment holds in this office. */
function wantedTools(office: Office, item: InstalledPackage): Record<string, string> {
  return hostApplies(office, item) ? { ...item.manifest.tools, ...item.manifest.host?.tools } : item.manifest.tools;
}

// The office root as a fragment's hook and task find it: two levels up from the fragment's real
// folder, `.office/mise/`, read through its link in the global conf.d. mise runs a linked file's
// hooks and tasks from whatever folder it runs in, so a path relative to the office breaks. A
// task's `run` and `dir` don't get `config_source`, so the task takes it through `env`.
const officeRoot = "{{ config_source | canonicalize | dirname }}/../..";

/**
 * What follows the [tools] table when the package's host install applies: a postinstall hook that
 * runs its script when the file it creates is missing, and the `<package>:install` task that runs
 * it unconditionally. Both are inline commands that find the script from the fragment's own path,
 * so they work from any folder; mise puts the fragment's tools on their PATH, `bun` among them.
 */
export function hostSection(office: Office, item: InstalledPackage): string | undefined {
  const install = item.manifest.host?.install;

  if (install === undefined || !hostApplies(office, item)) return undefined;

  const script = relative(office.dir, join(item.dir, install.script));
  const creates = install.creates.replace(/^~\//, "$HOME/");

  return [
    "[hooks]",
    `# ${install.description}, in ${install.creates}: installed by mise install on this host-mode office's machine when it is missing; it updates itself.`,
    `postinstall = ${JSON.stringify(`test -x "${creates}" || bun "${officeRoot}/${script}"`)}`,
    "",
    `[tasks.${JSON.stringify(`${item.entry.name}:install`)}]`,
    `description = ${JSON.stringify(`Install or repair ${install.description} in ${install.creates}`)}`,
    `env = { OFFICE_ROOT = ${JSON.stringify(officeRoot)} }`,
    `run = ${JSON.stringify(`bun "$OFFICE_ROOT/${script}"`)}`,
    "",
  ].join("\n");
}

// A key in a [tools] table: `name = ...`, the name optionally quoted.
const keyPattern = /^\s*("[^"]+"|[A-Za-z0-9_.:@/-]+)\s*=/;

/** A fragment's lines split where sync's own part starts: the first table after [tools]. */
type FragmentParts = { tools: string[]; rest: string[] };

function splitFragment(text: string): FragmentParts {
  const lines = text.replace(/\n$/, "").split("\n");
  const table = lines.findIndex((line) => /^\s*\[tools\]\s*(#.*)?$/.test(line));
  const after = lines.findIndex((line, index) => index > table && /^\s*\[/.test(line));
  const cut = table === -1 ? lines.length : after === -1 ? lines.length : after;
  const tools = lines.slice(0, cut);

  // The blank lines before sync's part belong to it.
  while (tools.length > 0 && tools[tools.length - 1].trim() === "" && cut < lines.length) tools.pop();

  return { tools, rest: lines.slice(cut) };
}

/** The fragment with its leading comment lines, sync's header, as this release writes it. */
function withHeader(parts: FragmentParts, name: string): FragmentParts {
  const comments = parts.tools.findIndex((line) => !line.startsWith("#"));

  return { ...parts, tools: [...header(name), ...parts.tools.slice(comments === -1 ? parts.tools.length : comments)] };
}

/** Where the [tools] table starts, and the line of each tool in it, by name. */
type ToolLines = { table: number | undefined; entries: Map<string, number> };

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

/** A fragment's new text, with the tools it added and removed and whether sync's part changed. */
type UpdatedFragment = { text: string; added: string[]; removed: string[]; section: boolean };

/**
 * A fragment holding exactly `tools` and then `section`: the existing [tools] table (and every
 * version in it) kept, a tool it lacks added at the package's version, a tool no longer wanted
 * removed, and whatever followed the table replaced by `section`.
 */
export function updateFragment(text: string | undefined, name: string, tools: Record<string, string>, section?: string): UpdatedFragment {
  const wanted = Object.keys(tools);
  const tail = section === undefined ? [] : ["", ...section.replace(/\n$/, "").split("\n")];

  if (text === undefined) {
    return { text: `${[...header(name), "", "[tools]", ...wanted.map((tool) => toolLine(tool, tools[tool])), ...tail].join("\n")}\n`, added: wanted, removed: [], section: section !== undefined };
  }

  const parts = withHeader(splitFragment(text), name);
  const { table, entries } = toolLines(parts.tools);
  const added = wanted.filter((tool) => !entries.has(tool));
  const removed = [...entries.keys()].filter((tool) => !wanted.includes(tool));
  const dropped = new Set(removed.map((tool) => entries.get(tool)));
  const newLines = added.map((tool) => toolLine(tool, tools[tool]));
  // New tools go after the table's last entry, or its header when it has none.
  const anchor = table === undefined ? undefined : Math.max(table, ...entries.values());
  const result: string[] = [];

  for (const [index, line] of parts.tools.entries()) {
    if (!dropped.has(index)) result.push(line);

    if (index === anchor) result.push(...newLines);
  }

  if (anchor === undefined) result.push("[tools]", ...newLines);

  return { text: `${[...result, ...tail].join("\n")}\n`, added, removed, section: [...parts.rest].join("\n") !== tail.slice(1).join("\n") };
}

/** The fragments in `.office/mise/` that sync wrote, by the package each names. */
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

/** Removes `.office/mise/`, and `.office/` with it, when deleting fragments left them empty. */
function removeEmptyFolders(office: Office): void {
  for (const folder of [fragmentsFolder, ".office"]) {
    const path = join(office.dir, folder);

    if (existsSync(path) && readdirSync(path).length === 0) rmdirSync(path);
  }
}

/** Why a package's host install isn't in its fragment, for messages. */
function hostAbsence(office: Office, item: InstalledPackage): string {
  if (office.opencode.mode !== "host") return "the office runs OpenCode in its container (opencode: container)";

  return `its ${item.manifest.host?.setting} setting is off`;
}

/**
 * Makes each installed package's fragment hold the tools it wants in this office and its host
 * install when that applies, and deletes the fragment of a package that wants neither or that
 * office.yaml no longer lists. `declared` names every package office.yaml lists, so a package that
 * fails to read keeps its fragment. Returns one line per change; a refusal starts with FAILED.
 */
export function syncTools(office: Office, installed: InstalledPackage[], declared: string[]): string[] {
  const changes: string[] = [];

  for (const item of installed) {
    const name = item.entry.name;
    const path = fragmentPath(office, name);
    const where = relative(office.dir, path);
    const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    const tools = wantedTools(office, item);
    const section = hostSection(office, item);

    if (current !== undefined && fragmentPackage(current) !== name) {
      changes.push(`FAILED package ${name}: ${where} is not the fragment office sync writes for it, so its tools aren't written; rename that file`);

      continue;
    }

    if (Object.keys(tools).length === 0 && section === undefined) {
      if (current === undefined) continue;

      rmSync(path);
      changes.push(`deleted ${where}, as package ${name} declares no tools`);

      continue;
    }

    const next = updateFragment(current, name, tools, section);

    if (next.text === current) continue;

    mkdirSync(join(office.dir, fragmentsFolder), { recursive: true });
    writeFileSync(path, next.text);

    if (current === undefined) changes.push(`created ${where} with package ${name}'s tools: ${next.added.map((tool) => `${tool} ${tools[tool]}`).join(", ")}`);

    for (const tool of current === undefined ? [] : next.added) changes.push(`added ${tool} ${tools[tool]} to ${where}, which package ${name} declares`);

    for (const tool of next.removed) changes.push(`removed ${tool} from ${where}, as package ${name} no longer declares it here`);

    if (current !== undefined && next.added.length === 0 && next.removed.length === 0 && !next.section) changes.push(`rewrote the header comment of ${where}, which says who changes what in it`);

    if (next.section) {
      const description = item.manifest.host?.install?.description ?? "its host install";

      changes.push(section === undefined ? `removed package ${name}'s install of ${description} from ${where}: ${hostAbsence(office, item)}` : `wrote package ${name}'s install of ${description} to ${where}: mise install installs it once, through the link (or mise run ${name}:install)`);
    }
  }

  for (const [path, owner] of packageFragments(office)) {
    if (declared.includes(owner)) continue;

    rmSync(path);
    changes.push(`deleted ${relative(office.dir, path)}, the tools of package ${owner}, which office.yaml no longer lists`);
  }

  removeEmptyFolders(office);

  return changes;
}

/** Notes for a package's line in `office check`, and whether its fragment and host install are as they should be. */
type FragmentReport = { ok: boolean; notes: string[] };

/** The host install's notes: why it is off here, or whether what it creates exists. */
function hostNotes(office: Office, item: InstalledPackage): FragmentReport {
  const host = item.manifest.host;
  const install = host?.install;

  if (host === undefined || !switchedOn(item)) return { ok: true, notes: [] };

  const what = install?.description ?? "its host-mode tools";

  if (office.opencode.mode !== "host") return { ok: true, notes: [`${what} is host-mode only, so this container-mode office doesn't have it`] };

  if (install === undefined) return { ok: true, notes: [] };

  // $HOME first, as the hook's test reads it.
  const path = install.creates.replace(/^~\//, `${process.env.HOME ?? homedir()}/`);

  return existsSync(path)
    ? { ok: true, notes: [`${what} installed in ${install.creates}; it updates itself`] }
    : { ok: false, notes: [`${what} is missing from ${install.creates}; office up installs it (or mise install, or mise run ${item.entry.name}:install, once the office's tools are linked)`] };
}

/** What `office check` says of a package's fragment and its host install. */
export function fragmentNotes(office: Office, item: InstalledPackage): FragmentReport {
  const wanted = Object.keys(wantedTools(office, item));
  const section = hostSection(office, item);
  const path = fragmentPath(office, item.entry.name);
  const where = relative(office.dir, path);
  const host = hostNotes(office, item);
  const report = (ok: boolean, notes: string[]): FragmentReport => ({ ok: ok && host.ok, notes: [...notes, ...host.notes] });

  if (!existsSync(path)) {
    return wanted.length === 0 && section === undefined ? report(true, []) : report(false, [`tools ${wanted.join(", ")} are missing: ${where} doesn't exist; office sync writes it`]);
  }

  const text = readFileSync(path, "utf8");

  if (fragmentPackage(text) !== item.entry.name) return report(false, [`${where} is not the fragment office sync writes for this package; rename it`]);

  if (wanted.length === 0 && section === undefined) return report(false, [`${where} is left from tools the package no longer declares; office sync deletes it`]);

  const parts = splitFragment(text);
  const { entries } = toolLines(parts.tools);
  const missing = wanted.filter((tool) => !entries.has(tool));
  const extra = [...entries.keys()].filter((tool) => !wanted.includes(tool));
  const stale = updateFragment(text, item.entry.name, wantedTools(office, item), section).section;
  const notes = [`tools ${wanted.filter((tool) => entries.has(tool)).join(", ") || "none"} in ${where}`];

  if (missing.length > 0) notes.push(`${where} lacks ${missing.join(", ")}; office sync adds ${missing.length === 1 ? "it" : "them"}`);

  if (extra.length > 0) notes.push(`${where} holds ${extra.join(", ")}, which the package no longer declares here; office sync removes ${extra.length === 1 ? "it" : "them"}`);

  if (stale) notes.push(`${where} ${section === undefined ? "still holds the package's host install" : "lacks or differs from the package's host install"}; office sync rewrites it`);

  return report(missing.length === 0 && extra.length === 0 && !stale, notes);
}

/** Fragments of packages office.yaml no longer lists, for `office check`. */
export function orphanFragments(office: Office, declared: string[]): string[] {
  return [...packageFragments(office)].flatMap(([path, owner]) => (declared.includes(owner) ? [] : [`${relative(office.dir, path)} holds the tools of package ${owner}, which office.yaml no longer lists (office sync deletes it)`]));
}

/**
 * The office's machine-wide mise files, which apply through links in mise's global conf.d: each
 * package's fragment, by name, and the office's own machine.toml last. `office upgrade-tools` bumps
 * them.
 */
export function machineFiles(office: Office): string[] {
  const own = join(office.dir, machineFile);

  return [...[...packageFragments(office).keys()].sort(), ...(existsSync(own) ? [own] : [])];
}

/** Files in `.office/mise/` sync didn't write, for `office check`: nothing links or bumps them. */
export function strayFragments(office: Office): string[] {
  const folder = join(office.dir, fragmentsFolder);

  if (!existsSync(folder)) return [];

  const ours = packageFragments(office);

  return readdirSync(folder)
    .map((file) => join(folder, file))
    .filter((path) => !ours.has(path))
    .map((path) => `${relative(office.dir, path)} isn't a fragment office sync wrote, and .office/ is the tool's, so nothing links it; move its tools to machine.toml`);
}
