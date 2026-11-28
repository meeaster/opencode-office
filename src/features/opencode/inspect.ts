import { existsSync, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { configFile, installedPanelNames, isRegistered, locate, panelDir, readPanelRecord } from "./desktop.ts";
import { findOffice, loadOffice, OfficeError, readOfficeFields, type Office } from "../../office.ts";
import { requiredPackages, resolvePackages } from "../../loader/sources/selection.ts";
import { separateFolders } from "../../layout.ts";
import { officeSchema } from "../../schema.ts";
import { cloneTarget, declarationBinding, pluginClones, pluginProblem } from "./delivery.ts";
import { configSources, conventionSources, projectDirectories, type Source } from "./native.ts";
import { readDeclarations } from "./declarations.ts";
import { officeTarget, pluginFolder, readCopies } from "./ownership.ts";
import { readPackageJson } from "../../loader/sources/manifest.ts";

/** What the last sync recorded of a selected package's panel: declared, withheld, or not confirmed for its current inputs. */
type PanelState = "declared" | "withheld" | "unconfirmed";

/**
 * Desktop registration is machine-wide and can outlive deselection or a withdrawn claim. Show only
 * this office's records, naming the package only while the last sync recorded it declaring that
 * panel for its current settings and source; a selected package without such a record, even with
 * no record at all, gets a retained panel.
 */
function desktopSources(office: Office, selected: Set<string>, panels: ReadonlyMap<string, PanelState>): string[] {
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
    const state = panels.get(name) ?? "withheld";

    const label = !selected.has(name)
      ? "previously delivered panel"
      : state === "declared" ? name : state === "unconfirmed" ? "retained panel, registration not confirmed since its last sync" : "retained panel, not declared by its package";

    found.push(`desktop: ${label} (${present ? "bundle present" : "bundle missing or not a regular file"}; ${registration} in app-machine ${basename(configFile(machine))})`);
  }

  return found.length ? found : ["desktop: no panel installation recorded here for this office"];
}

const layoutFolders = ["references", ...separateFolders];

// Echo structural Office names only. An arbitrary directory, even one with ordinary filename
// syntax, may carry a credential. Ordinals refer to the single ancestor chain being inspected.
function scopePath(office: Office, dir: string) {
  if (dir === office.dir) return "";
  const parts = relative(office.dir, dir).split(sep);
  // The office's own layout folders; what is inside them is named only by position.
  const known = layoutFolders.includes(parts[0]) ? 1 : 0;

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
  const copies = readCopies(office);
  const { packages, problems } = resolvePackages(office);
  const kinds = new Map(packages.map(item => [item.entry.name, item.kind === "remote" ? "pinned Git" : item.kind]));
  const panels = new Map<string, PanelState>();

  const lines = [
    `OpenCode sources for ${scopePath(office, dirs[dirs.length - 1]) || "."} (office-relative; runtime not checked)`,
    "Ordinary project discovery inside the office only; external config, policies and runtime overrides are not evaluated.",
  ];

  function describe(dir: string, source: Source) {
    const part = scopePath(office, dir);
    const scope = !part ? "office" : `folder ${part}`;
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
      const owned = target !== undefined && officeTarget(name, target);
      const copied = dirname(path) === managed && copies.has(name);
      const clone = !copied && owned && target === cloneTarget(name);
      const known = dirname(path) === managed && (selected.has(name) || office.plugins.some(item => item.name === name));
      const origin = join(scopePath(office, dir), ".opencode", basename(dirname(path)), known ? name : `<entry-${index + 1}>`);
      const state = selected.has(name) ? `selected ${kinds.get(name) ?? "unresolved"} package` : "not selected";
      const declared = office.plugins.some(item => item.name === name) ? "declared" : "not declared";
      const kind = copied ? `Office package copy (${state})` : clone ? `Office link to a Git clone (${declared})` : owned ? `Office package link (${state})` : "convention plugin candidate";

      describe(dir, { origin, description: identity ? kind : `${kind} (dangling)`, identity });
    }
  }

  for (const item of packages) {
    const { entry, dir } = item;
    const declared = declarations.get(entry.name);

    if (declared) {
      const json = readPackageJson(dir, entry.name);
      const origin = `${relative(office.dir, dir)}/${json.ok ? json.value.definition : "package.json"}#setup`;

      if (declared.state === "unavailable") {
        panels.set(entry.name, "unconfirmed");
        describe(office.dir, { origin, description: "OpenCode registration unavailable at last sync" });
      } else if (declared.binding !== declarationBinding(item)) {
        panels.set(entry.name, "unconfirmed");
        describe(office.dir, { origin, description: "OpenCode declaration inputs changed; sync required" });
      } else {
        const { server, panel } = declared.paths;

        panels.set(entry.name, panel ? "declared" : "withheld");
        describe(office.dir, { origin, description: `last synced registration: server ${server ? "declared" : "withheld"}, desktop ${panel ? "declared" : "withheld"}` });

        if (server) {
          const plugin = item.kind === "local"
            ? { kind: "link", target: relative(managed, join(dir, server)) } as const
            : { kind: "copy", source: join(dir, server) } as const;

          const problem = pluginProblem(office, entry.name, plugin, copies);

          if (problem) describe(office.dir, { origin, description: `declared server ${plugin.kind} missing or different` });
        }
      }

      continue;
    }

    if (!existsSync(dir)) describe(office.dir, { origin: relative(office.dir, dir), description: `selected ${kinds.get(entry.name)} package ${entry.name} (source missing; plugin not inspected)` });
  }

  for (const problem of problems) lines.push(`package selection unresolved: ${problem.packages.join(", ")} (see office check)`);

  for (const clone of pluginClones(office)) {
    const status = existsSync(join(clone.dir, ".git")) ? ".git present; identity not checked" : "no checkout observed";
    const link = !copies.has(clone.name) && linkTarget(clone.link) === cloneTarget(clone.name) ? `linked as ${pluginFolder}/${clone.name}` : `not linked as ${pluginFolder}/${clone.name}`;
    describe(office.dir, { origin: `office.yaml plugins: ${clone.name} -> ${relative(office.dir, clone.dir)}`, description: `declared Git clone (${status}; ${link})` });
  }

  for (const [identity, sources] of matches) {
    if (sources.length > 1) lines.push(`possible duplicate source (${identity.startsWith("npm:") ? "same package name or ID; versions not resolved" : "same filesystem target"}; activation not checked):`, ...sources.map(line => `  ${line}`));
  }

  return [...lines, ...desktopSources(office, selected, panels)];
}

export function inspect(folder: string, officeDir: string | undefined) {
  let root: string;

  try {
    root = realpathSync(findOffice(officeDir ?? folder));
  } catch {
    throw new OfficeError("cannot inspect: no readable office at the requested location");
  }

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
