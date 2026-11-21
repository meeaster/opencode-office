import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { claimsInspect } from "../../src/command-table.ts";
import { configFile, installedPanelNames, isRegistered, locate, panelDir, readPanelRecord } from "../../src/desktop.ts";
import { findOffice, loadOffice, OfficeError, readOfficeFields, type Office } from "../../src/office.ts";
import { requiredPackages, resolvePackages } from "../../src/packages.ts";
import { officeSchema } from "../../src/schema.ts";
import { readSnapshot, referenceFile } from "../../src/reference-snapshot.ts";
import { cloneTarget, declarationBinding, pluginClones, pluginFolder } from "./delivery.ts";
import { configSources, conventionSources, projectDirectories, type Source } from "./native.ts";
import { readDeclarations } from "./declarations.ts";
import { officeTarget } from "./ownership.ts";

/**
 * Desktop registration is machine-wide and can outlive deselection or a withdrawn claim. Show only
 * this office's records, naming the package only while it still declares that panel.
 */
function desktopSources(office: Office, selected: Set<string>, withheld: Set<string>): string[] {
  const location = locate(undefined, false);

  if (location.kind !== "app") return ["desktop: app machine not inspected"];

  const { machine } = location;
  const found: string[] = [];

  for (const name of installedPanelNames(machine).sort()) {
    const record = readPanelRecord(machine, name);

    if (record?.dir !== office.dir || record.office !== office.name || record.package !== name) continue;

    const dir = panelDir(machine, name);
    const registered = isRegistered(machine, machine.url(name));
    const registration = registered === undefined ? "registration unknown" : registered ? "listed" : "not listed";

    const present = lstatSync(join(dir, "gui-experimental.cjs"), { throwIfNoEntry: false })?.isFile();
    const label = !selected.has(name) ? "previously delivered panel" : withheld.has(name) ? "retained panel, not declared by its package" : name;
    found.push(`desktop: ${label} (${present ? "bundle present" : "bundle missing or not a regular file"}; ${registration} in app-machine ${basename(configFile(machine))})`);
  }

  return found.length ? found : ["desktop: no panel installation recorded here for this office"];
}

// Echo structural Office names only. An arbitrary directory, even one with ordinary filename
// syntax, may carry a credential. Ordinals refer to the single ancestor chain being inspected.
function scopePath(office: Office, dir: string) {
  if (dir === office.dir) return "";
  const parts = relative(office.dir, dir).split(sep);
  const desk = office.desks.find(item => item.name === parts[0]);
  const repo = desk && parts[1] === "repos" && desk.repos.some(item => item.name === parts[2]);
  const known = repo ? 3 : desk ? 1 : 0;

  return parts.map((part, i) => i < known ? part : `<folder-${i + 1}>`).join("/");
}

function linkTarget(path: string) {
  return lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() ? readlinkSync(path) : undefined;
}

function inventory(office: Office, folder: string) {
  const dirs = projectDirectories(office.dir, folder);
  const selected = new Set([...requiredPackages, ...office.packages.map(entry => entry.name)]);
  const managed = join(office.dir, pluginFolder);
  const matches = new Map<string, string[]>();
  const declarations = readDeclarations(office);
  const { packages, problems } = resolvePackages(office);
  const kinds = new Map(packages.map(item => [item.entry.name, item.kind === "remote" ? "pinned Git" : item.kind]));
  const withheld = new Set<string>();

  const lines = [
    `OpenCode sources for ${scopePath(office, dirs[dirs.length - 1]) || "."} (office-relative; runtime not checked)`,
    "Ordinary project discovery inside the office only; external config, policies and runtime overrides are not evaluated.",
  ];

  function describe(dir: string, source: Source) {
    const part = scopePath(office, dir);
    const scope = !part ? "office" : office.desks.some(desk => desk.name === part) ? `desk ${part}` : `folder ${part}`;
    const line = `[${scope}] ${source.description}: ${source.origin}`;

    lines.push(line);

    if (source.identity) {
      const origins = matches.get(source.identity) ?? [];

      origins.push(line);
      matches.set(source.identity, origins);
    }
  }

  for (const prefix of ["", ".opencode"]) {
    for (const dir of dirs) {
      // Inspecting .opencode itself (or a child) reaches that same document by both walks.
      if (!prefix && dir !== office.dir && basename(dir) === ".opencode") continue;

      for (const file of ["opencode.json", "opencode.jsonc"]) {
        const origin = join(scopePath(office, dir), prefix, file);

        for (const source of configSources(office.dir, join(dir, prefix, file), origin)) describe(dir, source);
      }
    }
  }

  for (const dir of dirs) {
    for (const [index, { path, identity }] of conventionSources(office.dir, dir).entries()) {
      const name = basename(path);
      const target = dirname(path) === managed && lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined;
      const owned = target !== undefined && officeTarget("plugins", "../../", name, target);
      const clone = owned && target === cloneTarget(name);
      const known = dirname(path) === managed && (selected.has(name) || office.plugins.some(item => item.name === name));
      const origin = join(scopePath(office, dir), ".opencode", basename(dirname(path)), known ? name : `<entry-${index + 1}>`);
      const state = selected.has(name) ? `selected ${kinds.get(name) ?? "unresolved"} package` : "not selected";
      const declared = office.plugins.some(item => item.name === name) ? "declared" : "not declared";
      const kind = clone ? `Office link to a Git clone (${declared})` : owned ? `Office package link (${state})` : "convention plugin candidate";

      describe(dir, { origin, description: identity ? kind : `${kind} (dangling)`, identity });
    }
  }

  for (const item of packages) {
    const { entry, dir } = item;
    const declared = declarations.get(entry.name);

    if (declared) {
      const origin = `${relative(office.dir, dir)}/office.ts#opencode`;

      if (declared.state === "unavailable") describe(office.dir, { origin, description: "OpenCode registration unavailable at last sync" });
      else if (declared.binding !== declarationBinding(item)) describe(office.dir, { origin, description: "OpenCode declaration inputs changed; sync required" });
      else {
        const { server, panel } = declared.paths;

        if (!panel) withheld.add(entry.name);
        describe(office.dir, { origin, description: `last synced registration: server ${server ? "declared" : "withheld"}, desktop ${panel ? "declared" : "withheld"}` });
        const link = join(managed, entry.name);

        if (server && (!lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink() || readlinkSync(link) !== relative(managed, join(dir, server)))) describe(office.dir, { origin, description: "declared server link missing or different" });
      }

      continue;
    }

    if (!existsSync(dir)) {
      describe(office.dir, { origin: relative(office.dir, dir), description: `selected ${kinds.get(entry.name)} package ${entry.name} (source missing; plugin not inspected)` });
    } else if (existsSync(join(dir, "plugin")) && linkTarget(join(managed, entry.name)) !== relative(managed, join(dir, "plugin"))) {
      describe(office.dir, { origin: relative(office.dir, join(dir, "plugin")), description: `selected ${kinds.get(entry.name)} package ${entry.name} (conventional asset present; no matching link or recorded registration)` });
    }
  }

  for (const problem of problems) lines.push(`package selection unresolved: ${problem.packages.join(", ")} (see office check)`);

  for (const clone of pluginClones(office)) {
    const status = existsSync(join(clone.dir, ".git")) ? ".git present; identity not checked" : "no checkout observed";
    const link = linkTarget(clone.link) === cloneTarget(clone.name) ? `linked as ${pluginFolder}/${clone.name}` : `not linked as ${pluginFolder}/${clone.name}`;
    describe(office.dir, { origin: `office.yaml plugins: ${clone.name} -> ${relative(office.dir, clone.dir)}`, description: `declared Git clone (${status}; ${link})` });
  }

  for (const [identity, sources] of matches) {
    if (sources.length > 1) lines.push(`possible duplicate source (${identity.startsWith("npm:") ? "same package name or ID; versions not resolved" : "same filesystem target"}; activation not checked):`, ...sources.map(line => `  ${line}`));
  }

  return [...lines, ...desktopSources(office, selected, withheld)];
}

function requireFreeRoute(dir: string) {
  let read;

  try {
    const file = lstatSync(join(dir, referenceFile), { throwIfNoEntry: false });

    if (file && !file.isFile() && !(file.isSymbolicLink() && readlinkSync(join(dir, referenceFile)) === "../current/references.json")) throw new Error();
    read = readSnapshot(dir);
  } catch {
    throw new OfficeError("cannot check ownership of opencode inspect: unreadable command generation");
  }

  if (!read.ok) throw new OfficeError("cannot check ownership of opencode inspect: unreadable command generation");

  if (read.value?.contributors.some(claimsInspect)) {
    throw new OfficeError("opencode inspect conflicts with a previously indexed package command or alias. See office --help for the claimant. Rename the package route or deselect its owner, then run office sync --packages; keep the generation for pinned repair");
  }
}

export function inspectInvocation(start: string) {
  let dir: string;

  try {
    dir = findOffice(start);
  } catch { return undefined; } // Inspecting an office by path from outside.

  requireFreeRoute(dir);

  return dir;
}

export function inspect(folder: string, officeDir: string | undefined, invocation: string | undefined) {
  let root: string;

  try {
    root = realpathSync(findOffice(officeDir ?? folder));
  } catch {
    throw new OfficeError("cannot inspect: no readable office at the requested location");
  }

  if (invocation !== root) requireFreeRoute(root);
  let office: Office;

  try {
    // YAML warnings can quote an entire source line to stderr even when parsing succeeds.
    if (!statSync(join(root, "office.yaml")).isFile()) throw new Error();
    office = loadOffice(root, readOfficeFields(root, officeSchema, "error"));
  } catch {
    throw new OfficeError("cannot inspect: office.yaml is unreadable or invalid");
  }

  try {
    return inventory(office, folder);
  } catch (error) {
    if (error instanceof OfficeError) throw error;

    throw new OfficeError("cannot inspect: an inventory path is unreadable");
  }
}
