import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { configFile, installedPanelNames, isRegistered, locate, panelDir, readPanelRecord } from "../../src/desktop.ts";
import { findOffice, loadOffice, OfficeError, readOfficeFields, type Office } from "../../src/office.ts";
import { requiredPackages, resolvePackages } from "../../src/packages.ts";
import { officeSchema } from "../../src/schema.ts";
import { packageLink, pluginClones, pluginFolder } from "./delivery.ts";
import { configSources, conventionSources, displayPath, projectDirectories, remoteHost, type Source } from "./native.ts";

/** Desktop registration is machine-wide and can outlive deselection. Show only this office's records. */
function desktopSources(office: Office): string[] {
  const location = locate(undefined, false);

  if (location.kind !== "app") return ["desktop: app machine not inspected"];

  const { machine } = location;
  const found: string[] = [];

  for (const name of installedPanelNames(machine).sort()) {
    const record = readPanelRecord(machine, name);

    if (record?.dir !== office.dir || record.package !== name) continue;

    const dir = panelDir(machine, name);
    const registered = isRegistered(machine, machine.url(name));
    const registration = registered === undefined ? "registration unknown" : registered ? "listed" : "not listed";

    found.push(`desktop: ${displayPath(dir)} (${existsSync(join(dir, "gui-experimental.cjs")) ? "bundle present" : "bundle missing"}; ${registration} in ${displayPath(configFile(machine))})`);
  }

  return found.length ? found : ["desktop: no panel installation recorded here for this office"];
}

function inventory(office: Office, folder: string) {
  const dirs = projectDirectories(office.dir, folder);
  const selected = new Set([...requiredPackages, ...office.packages.map(entry => entry.name)]);
  const managed = join(office.dir, pluginFolder);
  const matches = new Map<string, string[]>();

  const lines = [
    `OpenCode sources for ${displayPath(relative(office.dir, dirs[dirs.length - 1]) || ".")} (office-relative; runtime not checked)`,
    "Ordinary project discovery inside the office only; external config, policies and runtime overrides are not evaluated.",
  ];

  function describe(dir: string, source: Source) {
    const part = relative(office.dir, dir);
    const scope = !part ? "office" : office.desks.some(desk => desk.name === part) ? `desk ${part}` : `folder ${displayPath(part)}`;
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
        for (const source of configSources(office.dir, join(dir, prefix, file))) describe(dir, source);
      }
    }
  }

  for (const dir of dirs) {
    for (const { path, identity } of conventionSources(office.dir, dir)) {
      const name = basename(path);
      const target = dirname(path) === managed ? packageLink(path) : undefined;
      const kind = target ? `Office package link (${selected.has(name) ? "selected" : "not selected"}; ${displayPath(target)})` : "convention plugin candidate";

      describe(dir, { origin: displayPath(relative(office.dir, path)), description: identity ? kind : `${kind} (dangling)`, identity });
    }
  }

  const { packages, problems } = resolvePackages(office);

  for (const { entry, dir } of packages) {
    if (!existsSync(dir)) {
      describe(office.dir, { origin: displayPath(relative(office.dir, dir)), description: `selected package ${entry.name} (source missing; plugin not inspected)` });
    } else if (existsSync(join(dir, "plugin")) && packageLink(join(managed, entry.name)) !== relative(managed, join(dir, "plugin"))) {
      describe(office.dir, { origin: displayPath(relative(office.dir, join(dir, "plugin"))), description: `selected package ${entry.name} (expected link missing or different)` });
    }
  }

  for (const problem of problems) lines.push(`package selection unresolved: ${problem.packages.join(", ")} (see office check)`);

  for (const clone of pluginClones(office)) {
    const status = existsSync(join(clone.dir, ".git")) ? ".git present; identity not checked" : "no checkout observed";
    const host = remoteHost(clone.url);

    describe(office.dir, { origin: `office.yaml plugins: ${clone.name} -> ${displayPath(relative(office.dir, clone.dir))}`, description: `declared Git clone (${host ? `${host}; ` : ""}${status})` });
  }

  for (const sources of matches.values()) {
    if (sources.length > 1) lines.push("possible duplicate source (same target; activation not checked):", ...sources.map(line => `  ${line}`));
  }

  return [...lines, ...desktopSources(office)];
}

export function inspect(folder: string, officeDir?: string) {
  const root = realpathSync(findOffice(officeDir ?? folder));
  let office: Office;

  try {
    // YAML warnings can quote an entire source line to stderr even when parsing succeeds.
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
