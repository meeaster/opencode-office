// Deliver resolved requirements, tasks, install-once hooks and native bootstrap recipes.
//
// - Tools required in container mode go in `machine.packages.toml` at the office root, beside the
//   office's own `machine.toml`: a single [tools] table, one line per tool, each with a comment
//   naming the packages that declare it. Sync owns which tools are there and the comments; the
//   versions are the office's. A package's version is the one it was tested with and a floor: sync
//   adds a tool at the highest version its packages declare, leaves a line at or above every
//   package's version alone, raises one below it (and says so), and removes a tool no package
//   declares any more. `office upgrade-tools` bumps the versions. A version office can't order
//   against a package's (a range such as "2", or "latest") stays as the office wrote it.
// - A package's setup goes in its own fragment, `.office/mise/<package>.toml`, beside
//   `.office/packages/`: the tool's folder, entirely sync's and rewritten on every sync. It holds
//   the [hooks] postinstall and the `<package>:install` task of a host install, written only in a
//   host-mode office (with the package's switch on), then a package's system setup where it
//   applies (system.ts). A package with neither has no fragment.
//
// mise loads neither where it is. Both take effect only through links in mise's global conf.d
// (machine-files.ts for a host-mode office, or the container entrypoint), as does `machine.toml`, which
// loads last and so wins over the packages' versions; a mise.toml (the office's, a working
// repository's) wins over all of them in its folder, as project config wins over global. mise does
// load `mise/config.toml` and `mise.toml` in place below `.office/`, so `config` and `mise` are
// reserved package names, as is `machine`.
import { failure, type Change } from "../../lib/change.ts";
import { accessSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

import * as v from "valibot";

import { packageDeliveryDir } from "../../bound-paths.ts";
import { adoptVersion, declaredTools, wantedTools } from "./package-tools.ts";
import { toolPins } from "./mise-toml.ts";
import type { Office } from "../../office.ts";
import { shellQuote } from "../tools/sfw.ts";
import { projectionPath } from "../tools/applied.ts";
import { compareToolVersions } from "../tools/versions.ts";
import { fragmentOfficeRoot, systemApplyCommand, systemMarker, systemNotes, systemSection, systemState } from "./system.ts";
import type { ProjectedPackage } from "./projection.ts";
import type { Parsed } from "../../parse.ts";

/** Where sync writes packages' fragments: in the tool's `.office/`, where mise loads nothing by itself. */
const fragmentsFolder = ".office/mise";

/** The office's own machine-wide mise file, at its root, which mise doesn't load by itself either. */
export const machineFile = "machine.toml";

/** One TOML key path as written at the start of `text` (bare, "basic" and 'literal' keys joined by dots), and what follows it; undefined when it starts with none. */
function keyPath(text: string): { path: string[]; rest: string } | undefined {
  const path: string[] = [];
  let rest = text;

  for (;;) {
    rest = rest.trimStart();
    const match = /^"(?:[^"\\]|\\.)*"/.exec(rest) ?? /^'[^']*'/.exec(rest) ?? /^[A-Za-z0-9_-]+/.exec(rest);

    if (match === null) return undefined;
    const raw = match[0];
    let key: string | undefined = raw;

    // A quoted key is read as TOML reads it.
    if (!/^[A-Za-z0-9_-]/.test(raw)) {
      try {
        key = Object.keys(Bun.TOML.parse(`${raw} = 0`))[0];
      } catch {
        return undefined;
      }
    }

    if (key === undefined) return undefined;
    path.push(key);
    rest = rest.slice(raw.length).trimStart();

    if (!rest.startsWith(".")) return { path, rest };
    rest = rest.slice(1);
  }
}

// A mise file as far as its [tools] go.
const toolsDocument = v.looseObject({ tools: v.optional(v.record(v.string(), v.unknown())) });

/** `text` as mise reads it, without the [tools] entries `keys` names, and without [tools] once it is empty; undefined when it isn't such a file. */
function parsedWithout(text: string, keys: ReadonlySet<string>) {
  const read = v.safeParse(toolsDocument, Bun.TOML.parse(text));

  if (!read.success) return undefined;
  const { tools, ...rest } = read.output;
  const kept = Object.entries(tools ?? {}).filter(([key]) => !keys.has(key));

  return kept.length ? { ...rest, tools: Object.fromEntries(kept) } : rest;
}

/**
 * `text`, a mise TOML file, without the [tools] entries `keys` names, in any form TOML writes one
 * (`key = …` under [tools], a dotted `tools.key`, or a `[tools.key]` table), every other line as
 * written. The result must parse to the same document without those entries, as mise reads it;
 * undefined when it doesn't, such as for an entry whose text office can't place.
 */
export function withoutTools(text: string, keys: ReadonlySet<string>): string | undefined {
  let table: string[] = [];
  let dropping = false;

  const kept = text.split("\n").filter(line => {
    const header = /^\s*\[(?!\[)(.*)\]\s*(?:#.*)?$/.exec(line);
    const headerPath = header === null ? undefined : keyPath(header[1]);

    if (headerPath !== undefined && headerPath.rest === "") {
      table = headerPath.path;
      dropping = table[0] === "tools" && table.length > 1 && keys.has(table[1]);

      return !dropping;
    }

    if (/^\s*\[\[/.test(line)) {
      table = [];
      dropping = false;

      return true;
    }

    if (dropping) return false;
    const entry = keyPath(line);
    const full = entry !== undefined && entry.rest.startsWith("=") ? [...table, ...entry.path] : [];

    return !(full[0] === "tools" && full.length > 1 && keys.has(full[1]));
  }).join("\n");

  try {
    // Both without an empty [tools]: taking every entry out of a [tools] table leaves its header.
    const [after, wanted] = [parsedWithout(kept, new Set()), parsedWithout(text, keys)];

    return after !== undefined && Bun.deepEquals(after, wanted) ? kept : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What of the owner's machine.toml mise loads in a host-mode office whose packages require some of
 * its tools: the file without the [tools] entries `held` names (withoutTools, which admission
 * checks first). Those are the owner's holds of shared tools, which office.lock and the applied
 * tools carry (src/features/tools/), so mise's global config never selects a desired version. The
 * owner's file stays as it is.
 */
export function ownerProjection(text: string, held: ReadonlySet<string>): string {
  const kept = withoutTools(text, held);

  if (kept === undefined) throw new Error(`${machineFile}'s entries for ${[...held].join(", ")} can't be taken out of what mise loads; write each as key = "version" under [tools]`);

  return [`# office: ${machineFile} as mise loads it, without the shared tools the office's packages require (${[...held].join(", ")}), which office installs from office.lock. Written by office sync from ${machineFile}; edit that file instead.`, kept].join("\n");
}

/** The packages' tools, one line each, beside machine.toml; mise loads it only through its link. */
export const packagesFile = "machine.packages.toml";

/** The fragment that holds a package's mise setup. */
function fragmentPath(office: Office, name: string): string {
  return join(office.dir, fragmentsFolder, `${name}.toml`);
}

/** The path of machine.packages.toml. */
export function packagesPath(office: Office): string {
  return join(office.dir, packagesFile);
}

// The first line of every fragment sync writes, naming its package: how sync and check tell a
// package's fragment from one the office wrote itself.
const marker = /^# The mise setup of package ([a-z0-9][a-z0-9-]*)\./;

function header(name: string): string[] {
  return [
    `# The mise setup of package ${name}. office sync writes this file and rewrites it on every sync, so`,
    "# change nothing here. mise loads it through a global conf.d link: office sync places the link",
    "# on the host in host mode, and the container places it inside itself in container mode,",
    "# so it applies in every folder.",
  ];
}

/** The package a fragment's first line names, or undefined for a file sync didn't write. */
function fragmentPackage(text: string): string | undefined {
  return marker.exec(text)?.[1];
}

/** The package whose setup the file at `path` holds, or undefined for one sync didn't write, such as machine.toml. */
export function fragmentOwner(path: string): string | undefined {
  return fragmentPackage(readFileSync(path, "utf8"));
}

/** A line of machine.packages.toml: the tool's version, the packages its comment names, and where it is. */
type PackageLine = { version: string; packages: string[]; index: number };

/** The lines of machine.packages.toml's [tools] table, by tool, with the packages each line's comment names. */
export function packageLines(text: string): Map<string, PackageLine> {
  const lines = text.split("\n");

  return new Map(
    toolPins(text).map((pin) => {
      const comment = /#\s*(.*)$/.exec(lines[pin.index].slice(lines[pin.index].lastIndexOf('"') + 1))?.[1] ?? "";

      return [pin.tool, { version: pin.version, index: pin.index, packages: comment.split(",").map((name) => name.trim()).filter((name) => /^[a-z0-9][a-z0-9-]*$/.test(name)) }];
    }),
  );
}

/** machine.packages.toml's text, or undefined when it doesn't exist. */
function readPackagesFile(office: Office): string | undefined {
  const path = packagesPath(office);

  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

const packagesHeader = [
  "# The mise tools this office's packages need, one line per tool, naming the packages that need it.",
  "# office sync owns which tools are here: it adds a tool a package declares and removes one no",
  "# package declares any more (office check reports a tool added or removed by hand). The versions are",
  "# the office's: office upgrade-tools bumps them, and sync changes one only to raise it to the version",
  "# a package needs at least, which it says when it does. To hold a tool back, pin it in machine.toml",
  "# beside this file, the office's own, which wins over it. The OpenCode container links this file",
  "# into mise's global conf.d, so it applies in every folder. The same tool in a mise.toml wins in that file's",
  "# folder. These comment lines and each line's comment are office sync's, rewritten on every sync.",
];

/** A tool's line as sync writes it. */
function packageLine(tool: string, version: string, packages: string[]): string {
  return `"${tool}" = "${version}" # ${packages.join(", ")}`;
}

/** machine.packages.toml's text with these lines, in this order. */
const containerProjection = "# Projected for container mode.";

function containerMarker(office: Office) {
  return office.opencode.mode === "container" ? [containerProjection] : [];
}

function renderPackages(lines: [string, { version: string; packages: string[] }][], modeMarker: string[] = []): string {
  return `${[...packagesHeader, ...modeMarker, "", "[tools]", ...lines.map(([tool, line]) => packageLine(tool, line.version, line.packages))].join("\n")}\n`;
}

/** A change sync makes to machine.packages.toml, and what it says of it. */
type PackageChange = { kind: "added" | "raised" | "removed"; tool: string; line: string };

/** What sync would make of machine.packages.toml: its text (undefined: no file), and each tool-level change. */
type PackagesPlan = { text: string | undefined; changes: PackageChange[] };

/**
 * machine.packages.toml as sync makes it: a line for each tool the packages declare, at the
 * office's version unless that is below what a package needs. A line whose comment names a package
 * office.yaml lists but that didn't read (`declared`, not installed) stays as it is, since what that
 * package declares isn't known.
 */
function planPackageTools(office: Office, installed: ProjectedPackage[], declared: string[]): PackagesPlan {
  const current = readPackagesFile(office);
  const existing = current === undefined ? new Map<string, PackageLine>() : packageLines(current);
  const tools = declaredTools(office, installed);
  const unread = declared.filter((name) => !installed.some((item) => item.entry.name === name));
  const lines: [string, { version: string; packages: string[] }][] = [];
  const changes: PackageChange[] = [];

  for (const [tool, wanted] of tools) {
    const line = existing.get(tool);
    const names = [...wanted.packages.map((entry) => entry.name), ...(line?.packages.filter((name) => unread.includes(name)) ?? [])];

    const version = adoptVersion(wanted.floor, line?.version);

    if (line === undefined) {
      lines.push([tool, { version, packages: names }]);
      changes.push({ kind: "added", tool, line: `added ${tool} ${wanted.floor} to ${packagesFile}, which package ${names.join(" and ")} ${names.length === 1 ? "declares" : "declare"}` });

      continue;
    }

    if (version !== line.version) {
      const needs = wanted.packages.filter((entry) => (compareToolVersions(line.version, entry.version) ?? 0) < 0 && entry.version === wanted.floor).map((entry) => entry.name);

      lines.push([tool, { version, packages: names }]);
      changes.push({ kind: "raised", tool, line: `raised ${tool} from ${line.version} to ${wanted.floor} in ${packagesFile}: package ${needs.join(" and ")} ${needs.length === 1 ? "needs" : "need"} at least ${wanted.floor}` });

      continue;
    }

    lines.push([tool, { version: line.version, packages: names }]);
  }

  for (const [tool, line] of existing) {
    if (tools.has(tool)) continue;

    if (line.packages.some((name) => unread.includes(name))) {
      lines.push([tool, { version: line.version, packages: line.packages }]);

      continue;
    }

    changes.push({ kind: "removed", tool, line: `removed ${tool} from ${packagesFile}, as no package declares it here any more` });
  }

  // An unread owner may have contributed host-only tools. Preserving
  // its pins does not authorize a container to consume a host generation.
  const retained = lines.some(([, line]) => line.packages.some(name => unread.includes(name)));
  const modeMarker = retained && !current?.split("\n\n", 1)[0].split("\n").includes(containerProjection) ? [] : containerMarker(office);

  return { text: lines.length === 0 ? undefined : renderPackages(lines, modeMarker), changes };
}

/** Writes machine.packages.toml as `planPackageTools` makes it. Returns one line per change. */
function syncPackageTools(office: Office, installed: ProjectedPackage[], declared: string[]): string[] {
  const current = readPackagesFile(office);
  const plan = planPackageTools(office, installed, declared);

  if (plan.text === current) return [];

  if (plan.text === undefined) {
    rmSync(packagesPath(office));

    return [`deleted ${packagesFile}, as no package declares a tool here`];
  }

  writeFileSync(packagesPath(office), plan.text);

  if (current === undefined) return [`created ${packagesFile}, the packages' tools: ${toolPins(plan.text).map((pin) => `${pin.tool} ${pin.version}`).join(", ")}`];

  return plan.changes.length > 0 ? plan.changes.map((change) => change.line) : [`rewrote the comments of ${packagesFile}, which say who changes what in it and which packages need each tool`];
}

// The office root as a fragment's hook and task find it: two levels up from the fragment's real
// folder, `.office/mise/`, read through its link in the global conf.d. mise runs a linked file's
// hooks and tasks from whatever folder it runs in, so a path relative to the office breaks. A
// task's `run` and `dir` don't get `config_source`, so the task takes it through `env`.
const officeRoot = fragmentOfficeRoot;

/**
 * In a host-mode office, what puts the applied shared tools' links (src/features/tools/applied.ts)
 * first on a task's or hook's PATH, so it runs the office's applied bun rather than whatever a
 * global or desired pin selects; nothing in container mode.
 */
function appliedFirst(office: Office): string {
  return office.opencode.mode === "host" ? `PATH=${shellQuote(projectionPath(office))}:"$PATH" ` : "";
}

function installTask(item: ProjectedPackage) {
  return `${item.entry.name}:${item.claims.install?.name ?? "install"}`;
}

function afterInstall(item: ProjectedPackage): string {
  return item.claims.install?.executable === false ? `mise run ${installTask(item)} repairs or updates it` : "it updates itself";
}

/** Whether `path` is what a host install creates: a regular file, executable unless the install says otherwise. */
function installed(path: string, executable: boolean): boolean {
  try {
    if (!statSync(path).isFile()) return false;

    if (executable) accessSync(path, constants.X_OK);

    return true;
  } catch {
    return false;
  }
}

/**
 * The fragment's part for a host install, when it applies: a postinstall hook that runs its script
 * when the file it creates is missing, and the `<package>:install` task that runs it
 * unconditionally. Both are inline commands that find the script from the fragment's own path, so
 * they work from any folder; mise puts the office's tools on their PATH, `bun` among them.
 */
function hostSection(office: Office, item: ProjectedPackage): string | undefined {
  const install = item.claims.install;

  if (install === undefined || office.opencode.mode !== "host") return undefined;

  const script = relative(office.dir, join(packageDeliveryDir(office.dir, item), install.script));
  const creates = install.ready.replace(/^~\//, "$HOME/");
  const test = install.executable ? "test -x" : "test -f";

  return [
    "[hooks]",
    `# ${install.description}, in ${install.ready}: installed by mise install on this host-mode office's machine when it is missing; ${afterInstall(item)}.`,
    `postinstall = ${JSON.stringify(`${test} "${creates}" || ${appliedFirst(office)}bun "${officeRoot}/${script}"`)}`,
    "",
    `[tasks.${JSON.stringify(installTask(item))}]`,
    `description = ${JSON.stringify(`Install or repair ${install.description} in ${install.ready}`)}`,
    `env = { OFFICE_ROOT = ${JSON.stringify(officeRoot)} }`,
    `run = ${JSON.stringify(`${appliedFirst(office)}bun "$OFFICE_ROOT/${script}"`)}`,
    "",
  ].join("\n");
}

/** A package's mise setup: the host install, then the system setup, each where it applies; undefined for neither. */
function fragmentSection(office: Office, item: ProjectedPackage): Parsed<string | undefined> {
  const system = systemSection(office, item);

  if (!system.ok) return system;

  const tasks = item.claims.tasks.map(task => {
    const path = relative(office.dir, join(packageDeliveryDir(office.dir, item), task.script));
    const runner = path.endsWith(".ts") ? "bun" : "bash";

    return [`[tasks.${JSON.stringify(`${item.entry.name}:${task.name}`)}]`, `description = ${JSON.stringify(task.description)}`, `env = { OFFICE_ROOT = ${JSON.stringify(officeRoot)} }`, `run = ${JSON.stringify(`${appliedFirst(office)}${runner} "$OFFICE_ROOT/${path}"`)}`, ""].join("\n");
  });

  const parts = [hostSection(office, item), ...tasks, system.value].filter((part) => part !== undefined);

  return { ok: true, value: parts.length === 0 ? undefined : parts.join("\n") };
}

/** The fragment's text for a package's setup. */
function fragmentText(name: string, section: string, modeMarker: string[] = []): string {
  return `${[...header(name), ...modeMarker, "", ...section.replace(/\n$/, "").split("\n")].join("\n")}\n`;
}

/** The line of the host install's task in a fragment, which tells sync's messages it is there. */
function hostMarker(item: ProjectedPackage): string {
  return `[tasks.${JSON.stringify(installTask(item))}]`;
}

/** The fragments in `.office/mise/` that sync wrote, by the package each names. */
function packageFragments(office: Office): Map<string, string> {
  const folder = join(office.dir, fragmentsFolder);
  const found = new Map<string, string>();

  if (!existsSync(folder)) return found;

  for (const file of readdirSync(folder).sort()) {
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
function hostAbsence(office: Office): string {
  if (office.opencode.mode !== "host") return "the office runs OpenCode in its container (opencode: container)";

  return "its setup no longer selects the install";
}

/** What changed in a package's setup, from `before` (the fragment's old text) to now, one line each. */
function sectionChanges(office: Office, item: ProjectedPackage, before: string, where: string): string[] {
  const name = item.entry.name;
  const lines: string[] = [];
  const host = hostSection(office, item);
  const install = item.claims.install?.description ?? "its host install";

  if (host === undefined && before.includes(hostMarker(item))) lines.push(`removed package ${name}'s install of ${install} from ${where}: ${hostAbsence(office)}`);
  else if (host !== undefined && !before.includes(host.trim())) lines.push(`wrote package ${name}'s install of ${install} to ${where}: mise install installs it once, through the link (or mise run ${installTask(item)})`);

  const system = item.system;
  const state = systemState(office, item);
  const part = systemSection(office, item);
  const wanted = part.ok ? part.value : undefined;

  if (system === undefined || state === undefined) return lines;

  if (wanted === undefined && before.includes(systemMarker(item))) lines.push(`removed package ${name}'s system setup, ${system.description}, from ${where}: ${state.applies ? "it no longer applies" : state.reason}; what it installed stays on the machine`);
  else if (wanted !== undefined && !before.includes(wanted.trim())) lines.push(`wrote package ${name}'s system setup, ${system.description}, to ${where}: ${systemApplyCommand} offers to apply it on this machine (mise asks for sudo); nothing else does`);

  return lines;
}

/**
 * Makes each installed package's fragment hold its setup where that applies, and deletes the
 * fragment of a package with none or that office.yaml no longer lists. `declared` names every
 * package office.yaml lists, so a package that fails to read keeps its fragment.
 */
function syncFragments(office: Office, installed: ProjectedPackage[], declared: string[]): Change[] {
  const changes: Change[] = [];

  for (const item of installed) {
    const name = item.entry.name;
    const path = fragmentPath(office, name);
    const where = relative(office.dir, path);
    const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    const composed = fragmentSection(office, item);

    if (current !== undefined && fragmentPackage(current) !== name) {
      changes.push(failure(`FAILED package ${name}: ${where} is not the fragment office sync writes for it, so its mise setup isn't written; rename that file`));

      continue;
    }

    if (!composed.ok) {
      changes.push(failure(`FAILED package ${name}: ${composed.errors.join("; ")}; ${where} is left as it was`));

      continue;
    }

    const section = composed.value;

    if (section === undefined) {
      if (current === undefined) continue;

      rmSync(path);
      changes.push(...sectionChanges(office, item, current, where), `deleted ${where}, as package ${name} has no mise setup here`);

      continue;
    }

    const text = fragmentText(name, section, containerMarker(office));

    if (text === current) continue;

    mkdirSync(join(office.dir, fragmentsFolder), { recursive: true });
    writeFileSync(path, text);

    const said = sectionChanges(office, item, current ?? "", where);

    changes.push(...(said.length > 0 ? said : [`rewrote ${where}, package ${name}'s mise setup, as office sync writes it now`]));
  }

  for (const [path, owner] of packageFragments(office)) {
    if (declared.includes(owner)) continue;

    rmSync(path);
    changes.push(`deleted ${relative(office.dir, path)}, the mise setup of package ${owner}, which office.yaml no longer lists`);
  }

  removeEmptyFolders(office);

  return changes;
}

/**
 * Writes the packages' tools to machine.packages.toml and their setup to their fragments.
 * `declared` names every package office.yaml lists. Returns one line per change; a refusal starts
 * with FAILED.
 */
export function syncTools(office: Office, installed: ProjectedPackage[], declared: string[]): Change[] {
  return [...syncPackageTools(office, installed, declared), ...syncFragments(office, installed, declared)];
}

/** Notes for a package's line in `office check`, and whether its tools and setup are as they should be. */
type FragmentReport = { ok: boolean; notes: string[] };

/** The host install's notes: why it is off here, or whether what it creates exists. */
function hostNotes(office: Office, item: ProjectedPackage): FragmentReport {
  const install = item.claims.install;

  if (install === undefined) return { ok: true, notes: [] };
  const what = install.description;

  if (office.opencode.mode !== "host") return { ok: true, notes: [`${what} is host-mode only, so this container-mode office doesn't have it`] };

  // $HOME first, as the hook's test reads it.
  const path = install.ready.replace(/^~\//, `${process.env.HOME ?? homedir()}/`);

  if (installed(path, install.executable)) return { ok: true, notes: [`${what} installed in ${install.ready}; ${afterInstall(item)}`] };

  const wrong = install.executable ? "not an executable file" : "not a regular file";
  const state = existsSync(path) ? `is ${wrong} in ${install.ready}` : `is missing from ${install.ready}`;

  return { ok: false, notes: [`${what} ${state}; office up installs it (or mise install, or mise run ${installTask(item)}, once the office's tools are linked)`] };
}

/** What `office check` says of a package's lines in machine.packages.toml. */
function toolNotes(office: Office, item: ProjectedPackage): FragmentReport {
  const wanted = wantedTools(office, item);
  const tools = Object.keys(wanted);

  if (tools.length === 0) return { ok: true, notes: [] };

  const current = readPackagesFile(office);

  if (current === undefined) return { ok: false, notes: [`tools ${tools.join(", ")} are missing: ${packagesFile} doesn't exist; office sync writes it`] };

  const lines = packageLines(current);
  const present = tools.filter((tool) => lines.has(tool));
  const missing = tools.filter((tool) => !lines.has(tool));
  const notes = [`tools ${present.join(", ") || "none"} in ${packagesFile}`];
  let ok = missing.length === 0;

  if (missing.length > 0) notes.push(`${packagesFile} lacks ${missing.join(", ")}; office sync adds ${missing.length === 1 ? "it" : "them"}`);

  for (const tool of present) {
    const version = lines.get(tool)?.version ?? "";
    const order = compareToolVersions(version, wanted[tool]);

    if (order === undefined) notes.push(`${packagesFile} holds ${tool} ${version}, which office can't order against the ${wanted[tool]} this package declares, so office sync leaves it`);
    else if (order < 0) {
      ok = false;
      notes.push(`${packagesFile} holds ${tool} ${version}, below the ${wanted[tool]} this package needs; office sync raises it`);
    }
  }

  return { ok, notes };
}

/** What `office check` says of a package's fragment: whether it holds the setup sync writes. */
function setupNotes(office: Office, item: ProjectedPackage, section: string | undefined): FragmentReport {
  const path = fragmentPath(office, item.entry.name);
  const where = relative(office.dir, path);

  if (!existsSync(path)) return section === undefined ? { ok: true, notes: [] } : { ok: false, notes: [`${where} doesn't exist, so the package's host install or system setup is missing; office sync writes it`] };

  const text = readFileSync(path, "utf8");

  if (fragmentPackage(text) !== item.entry.name) return { ok: false, notes: [`${where} is not the fragment office sync writes for this package; rename it`] };

  if (section === undefined) return { ok: false, notes: [`${where} is left from a mise setup the package no longer has here; office sync deletes it`] };

  if (text !== fragmentText(item.entry.name, section, containerMarker(office))) return { ok: false, notes: [`${where} lacks or differs from the package's host install or system setup; office sync rewrites it`] };

  return { ok: true, notes: [`mise setup in ${where}`] };
}

/** What `office check` says of a package's tools, its fragment and its host install. */
export function fragmentNotes(office: Office, item: ProjectedPackage): FragmentReport {
  const composed = fragmentSection(office, item);
  const parts = [toolNotes(office, item), setupNotes(office, item, composed.ok ? composed.value : undefined), hostNotes(office, item), systemNotes(office, item)];

  return { ok: parts.every((part) => part.ok) && composed.ok, notes: [...parts.flatMap((part) => part.notes), ...(composed.ok ? [] : composed.errors)] };
}

/**
 * What `office check` says of machine.packages.toml as a whole: tools no package declares, and
 * comments sync would rewrite. A missing or low tool is its package's line.
 */
export function packagesFileProblems(office: Office, installed: ProjectedPackage[], declared: string[]): string[] {
  const current = readPackagesFile(office);
  const plan = planPackageTools(office, installed, declared);
  const removed = plan.changes.filter((change) => change.kind === "removed").map((change) => change.tool);
  const problems = removed.map((tool) => `${packagesFile} holds ${tool}, which no package declares here; office sync removes it`);

  if (current !== undefined && plan.text === undefined) problems.push(`${packagesFile} is left from tools no package declares; office sync deletes it`);

  if (plan.changes.length === 0 && current !== undefined && plan.text !== undefined && plan.text !== current) problems.push(`${packagesFile}'s comments differ from what office sync writes (which packages need each tool); office sync rewrites them`);

  return problems;
}

/**
 * Tools machine.toml pins below what a package needs, for a warning in `office check`: machine.toml
 * wins, so the office runs a version older than the package was tested with.
 */
export function machineBelowFloors(office: Office, installed: ProjectedPackage[]): string[] {
  const path = join(office.dir, machineFile);

  if (!existsSync(path)) return [];

  const tools = declaredTools(office, installed);

  return toolPins(readFileSync(path, "utf8")).flatMap((pin) => {
    const below = (tools.get(pin.tool)?.packages ?? []).filter((entry) => (compareToolVersions(pin.version, entry.version) ?? 0) < 0);

    return below.map((entry) => `${machineFile} pins ${pin.tool} ${pin.version}, below the ${entry.version} package ${entry.name} needs; it wins over ${packagesFile}, so the package runs an older ${pin.tool} than it was tested with`);
  });
}

/** Fragments of packages office.yaml no longer lists, for `office check`. */
export function orphanFragments(office: Office, declared: string[]): string[] {
  return [...packageFragments(office)].flatMap(([path, owner]) => (declared.includes(owner) ? [] : [`${relative(office.dir, path)} holds the mise setup of package ${owner}, which office.yaml no longer lists (office sync deletes it)`]));
}

/**
 * The office's machine-wide mise files, in the order mise loads their links in the global conf.d:
 * machine.packages.toml, each package's fragment by name, and the office's own machine.toml last,
 * so it wins.
 */
export function machineFiles(office: Office): string[] {
  const own = join(office.dir, machineFile);
  const packages = packagesPath(office);

  return [...(existsSync(packages) ? [packages] : []), ...packageFragments(office).keys(), ...(existsSync(own) ? [own] : [])];
}

/** The machine-wide files that pin versions, which `office upgrade-tools` bumps: machine.packages.toml and machine.toml. */
export function pinnedMachineFiles(office: Office): string[] {
  return [packagesPath(office), join(office.dir, machineFile)].filter((path) => existsSync(path));
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
