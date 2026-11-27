import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, relative } from "node:path";
import * as v from "valibot";
import { installs, recipes, tasks, type Install, type Recipe, type Task } from "../../packages/mise-integration/claims.ts";
import type { RegistryEntry } from "../../sdk/index.ts";
import { requirements, type Requirement } from "../../packages/tooling/requirements.ts";
import { tools, type Provision, type Requirement as ToolRequirement } from "../../packages/tools/handles.ts";
import type { Office } from "../../src/office.ts";
import type { GatheredPackage } from "../../src/gather.ts";
import type { InstalledPackage } from "../../src/packages.ts";
import { gateDefaultProblem, systemApplies, systemSection } from "./system.ts";
import { defaultOffSetting, settingValue, type SettingValue, systemBlock, type SystemBlock } from "../../src/schema.ts";

/** Whether a registry holds machine claims: tools, tasks, host installs or system recipes. */
export function machineCollection(id: string) {
  return [requirements.id, tools.requirements.id, tools.providers.id, installs.id, recipes.id, tasks.id].includes(id);
}

/**
 * What a package claims on the machine in this run, as their parsers returned them: tools by
 * `@office/tooling` (`tools`) and by `@office/tools` (`required`, `provided`), tasks, a host install
 * and a system recipe.
 */
export type MachineClaims = { tools: Requirement[]; required: ToolRequirement[]; provided: Provision[]; tasks: Task[]; install?: Install; recipe?: Recipe };

/** A package's claims and its effective system block: its own, or the recipe it contributed. */
export type Projection = { claims: MachineClaims; system: SystemBlock | undefined };

function asset(item: InstalledPackage, file: string) {
  const path = join(item.dir, file);

  if (!statSync(path, { throwIfNoEntry: false })?.isFile() || relative(realpathSync(item.dir), realpathSync(path)).startsWith("..")) throw new Error(`${file} must be a file inside package ${item.entry.name}`);
}

/** A contributed recipe's system block without its ready paths, which its bootstrap file adds to. */
const recipeBlock = v.object(v.omit(systemBlock, ["ready"]).entries);

/**
 * Decode one package's parsed machine entries without reading a file; throws naming what is wrong.
 * A contributed recipe's block holds only the ready paths it names: `recipeSystem` adds its
 * bootstrap file's. The manifest is not changed.
 */
export function project(item: InstalledPackage, rows: readonly { id: string; value: RegistryEntry }[]): Projection {
  const claims: MachineClaims = { tools: [], required: [], provided: [], tasks: [] };
  const names = new Set<string>();
  let system = item.manifest.system;

  for (const { id, value } of rows) {
    if (id === requirements.id) claims.tools.push(requirements.parse(value));
    else if (id === tools.requirements.id) claims.required.push(tools.requirements.parse(value));
    else if (id === tools.providers.id) claims.provided.push(tools.providers.parse(value));
    else if (id === tasks.id || id === installs.id) {
      const task = tasks.parse(value);

      if (names.has(task.name) || (item.manifest.host?.install && task.name === "install")) throw new Error(`duplicate task ${item.entry.name}:${task.name}`);
      names.add(task.name);

      if (id === tasks.id) claims.tasks.push(task);
      else {
        if (claims.install || item.manifest.host?.install) throw new Error(`duplicate host install of ${item.entry.name}`);
        claims.install = installs.parse(value);
      }
    } else if (id === recipes.id) {
      if (system) throw new Error(`duplicate system setup of ${item.entry.name}`);
      const recipe = recipes.parse(value);

      system = { ...v.parse(recipeBlock, recipe), ready: recipe.ready };

      if (!defaultOffSetting(item.manifest.settings, system.setting)) throw new Error(`system recipe ${recipe.name}: its setting ${system.setting} must be declared type: boolean with default: false, so it defaults to off`);
      const problem = gateDefaultProblem(item.entry, item.settings, system.setting);

      if (problem) throw new Error(`system recipe ${recipe.name}: ${problem}`);
      claims.recipe = recipe;
    }
  }

  return { claims, system };
}

/**
 * A contributed recipe's effective system block, for what applies or checks the machine: its ready
 * paths and each file its bootstrap file makes present. Reads that file; throws naming what is wrong.
 */
export function recipeSystem(item: InstalledPackage, { name, ...block }: Recipe): SystemBlock {
  asset(item, block.bootstrap);

  const files = readBootstrap(item, block.bootstrap).files ?? {};

  const present = Object.entries(files).flatMap(([path, spec]) =>
    spec.state === "absent" || spec.remove_empty || spec.os !== undefined ? [] : [effectivePath(path)]);

  try {
    return v.parse(systemBlock, { ...block, ready: [...new Set([...block.ready, ...present])] });
  } catch (error) {
    throw new Error(`system recipe ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Sync's check of the files a package's claims name: each task's script and its recipe's scripts are files inside it. */
export function claimAssetProblems(item: GatheredPackage): string[] {
  const files = [...item.claims.tasks, ...(item.claims.install ? [item.claims.install] : [])].map(task => task.script);

  if (item.claims.recipe) files.push(...[item.claims.recipe.prepare, item.claims.recipe.verify].filter(file => file !== undefined));

  return files.flatMap(file => {
    try {
      asset(item, file);

      return [];
    } catch (error) {
      return [error instanceof Error ? error.message : String(error)];
    }
  });
}

// Inspect the resource fields that affect ownership and positive presence. The
// original TOML, including the rest of the resource's native options, is delivered.
const resources = v.optional(v.record(v.pipe(v.string(), v.regex(/^(?:\/|~\/).+/)), v.object({
  state: v.optional(v.picklist(["absent", "present"])),
  remove_empty: v.optional(v.boolean()),
  os: v.optional(v.union([v.string(), v.array(v.string())])),
})));

const native = v.strictObject({ bootstrap: v.strictObject({
  packages: v.optional(v.record(v.string(), settingValue)),
  files: resources,
  directories: resources,
}) });

function effectivePath(path: string) {
  return resolve(path.startsWith("~/") ? join(process.env.HOME ?? homedir(), path.slice(2)) : path);
}

function readBootstrap(item: InstalledPackage, file: string) {
  return v.parse(native, Bun.TOML.parse(readFileSync(join(item.dir, file), "utf8"))).bootstrap;
}

type PathClaim = { owner: string; directory: boolean; absent: boolean };

function allowsChild(parent: PathClaim, child: PathClaim) {
  return parent.directory && (!parent.absent || child.absent);
}

/** Install roots own their subtree; native directories manage the directory itself. */
export function destinationProblems(office: Office, items: GatheredPackage[], conflict?: (...owners: string[]) => void): string[] {
  const owners = new Map<string, PathClaim>();
  const packages = new Map<string, { owner: string; spec: SettingValue }>();
  const problems: string[] = [];

  function claim(path: string, owner: string, directory = false, absent = false) {
    const key = effectivePath(path);
    const next = { owner, directory, absent };

    if (key === "/") problems.push(`package ${owner} cannot manage the filesystem root`);

    for (const [other, first] of owners) {
      if (key === other || (key.startsWith(`${other}/`) && !allowsChild(first, next)) || (other.startsWith(`${key}/`) && !allowsChild(next, first))) {
        conflict?.(first.owner, owner);
        problems.push(`${path} claimed by both package ${first.owner} and package ${owner}`);
      }
    }

    owners.set(key, next);
  }

  for (const item of items) {
    const host = item.manifest.host;
    const owner = item.entry.name;

    if (office.opencode.mode === "host") {
      if (item.claims.install) claim(item.claims.install.destination, owner);

      if (host?.install && (!host.setting || String(item.settings[host.setting]) === "true")) claim(host.install.creates, owner);
    }

    if (item.system && systemApplies(office, item)) {
      try {
        const section = systemSection(office, item);

        if (!section.ok) {
          problems.push(`package ${owner}: ${section.errors.join("; ")}; .office/mise/${owner}.toml is left as it was`);
          continue;
        }

        const recipe = readBootstrap(item, item.system.bootstrap);

        for (const [path, spec] of Object.entries(recipe.files ?? {})) claim(path, owner, false, spec.state === "absent");

        for (const [path, spec] of Object.entries(recipe.directories ?? {})) claim(path, owner, true, spec.state === "absent");

        for (const [name, spec] of Object.entries(recipe.packages ?? {})) {
          const previous = packages.get(name);

          if (previous && !Bun.deepEquals(previous.spec, spec)) problems.push(`${name} requested differently by package ${previous.owner} and package ${owner}`);
          packages.set(name, { owner, spec });
        }
      } catch (error) {
        problems.push(`package ${owner}: invalid native bootstrap ${item.system.bootstrap}: ${String(error)}`);
      }
    }
  }

  return problems;
}
