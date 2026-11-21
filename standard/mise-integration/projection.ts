import { readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, relative } from "node:path";
import * as v from "valibot";
import { installs, recipes, tasks, type Install, type Task } from "../../packages/mise-integration/claims.ts";
import type { CollectionEntry } from "../../packages/office/package-context.ts";
import { requirements, type Requirement } from "../../packages/tooling/requirements.ts";
import type { Office } from "../../src/office.ts";
import type { InstalledPackage } from "../../src/packages.ts";
import { systemApplies, systemSection } from "../../src/package-system.ts";
import { bootstrapFile, settingValue, type SettingValue, systemBlock } from "../../src/schema.ts";

export function machineCollection(id: string) {
  return [requirements.id, installs.id, recipes.id, tasks.id].includes(id);
}

export type MachineClaims = { tools: Requirement[]; tasks: Task[]; install?: Install };

function asset(item: InstalledPackage, file: string) {
  const path = join(item.dir, file);

  if (!statSync(path, { throwIfNoEntry: false })?.isFile() || relative(realpathSync(item.dir), realpathSync(path)).startsWith("..")) throw new Error(`${file} must be a file inside package ${item.entry.name}`);
}

/** Decode the same rows at collection, replacement validation and inventory boundaries. */
export function project(item: InstalledPackage, rows: readonly { id: string; value: CollectionEntry }[], validateAssets = false) {
  const claims: MachineClaims = { tools: [], tasks: [] };
  const names = new Set<string>();
  let system = item.manifest.system;

  for (const { id, value } of rows) {
    if (id === requirements.id) claims.tools.push(requirements.parse(value));
    else if (id === tasks.id || id === installs.id) {
      const task = tasks.parse(value);

      if (names.has(task.name) || (item.manifest.host?.install && task.name === "install")) throw new Error(`duplicate task ${item.entry.name}:${task.name}`);
      names.add(task.name);

      if (validateAssets) asset(item, task.script);

      if (id === tasks.id) claims.tasks.push(task);
      else {
        if (claims.install || item.manifest.host?.install) throw new Error(`duplicate host install of ${item.entry.name}`);
        claims.install = installs.parse(value);
      }
    } else if (id === recipes.id) {
      if (system) throw new Error(`duplicate system setup of ${item.entry.name}`);
      const { name, ...recipe } = recipes.parse(value);
      v.parse(bootstrapFile, recipe.bootstrap);
      asset(item, recipe.bootstrap);

      if (validateAssets) {
        for (const file of [recipe.prepare, recipe.verify]) if (file !== undefined) asset(item, file);
      }

      const files = readBootstrap(item, recipe.bootstrap).files ?? {};

      const present = Object.entries(files).flatMap(([path, spec]) =>
        spec.state === "absent" || spec.remove_empty || spec.os !== undefined ? [] : [effectivePath(path)]);

      system = v.parse(systemBlock, { ...recipe, ready: [...new Set([...recipe.ready, ...present])] });

      if (item.manifest.settings[system.setting]?.default !== false) throw new Error(`${name}: system recipe needs a default-off setting`);

    }
  }

  item.manifest.system = system;
  item.machine = claims;
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
export function destinationProblems(office: Office, items: InstalledPackage[]): string[] {
  const owners = new Map<string, PathClaim>();
  const packages = new Map<string, { owner: string; spec: SettingValue }>();
  const problems: string[] = [];

  function claim(path: string, owner: string, directory = false, absent = false) {
    const key = effectivePath(path);
    const next = { owner, directory, absent };

    if (key === "/") problems.push(`package ${owner} cannot manage the filesystem root`);

    for (const [other, first] of owners) {
      if (key === other || (key.startsWith(`${other}/`) && !allowsChild(first, next)) || (other.startsWith(`${key}/`) && !allowsChild(next, first))) problems.push(`${path} claimed by both package ${first.owner} and package ${owner}`);
    }

    owners.set(key, next);
  }

  for (const item of items) {
    if (item.machineProblem) {
      problems.push(item.machineProblem);
      continue;
    }

    const host = item.manifest.host;
    const owner = item.entry.name;

    if (office.opencode.mode === "host") {
      if (item.machine?.install) claim(item.machine.install.destination, owner);

      if (host?.install && (!host.setting || String(item.settings[host.setting]) === "true")) claim(host.install.creates, owner);
    }

    if (item.manifest.system && systemApplies(office, item)) {
      try {
        const section = systemSection(office, item);

        if (!section.ok) {
          problems.push(`package ${owner}: ${section.errors.join("; ")}; .office/mise/${owner}.toml is left as it was`);
          continue;
        }

        const recipe = readBootstrap(item, item.manifest.system.bootstrap);

        for (const [path, spec] of Object.entries(recipe.files ?? {})) claim(path, owner, false, spec.state === "absent");

        for (const [path, spec] of Object.entries(recipe.directories ?? {})) claim(path, owner, true, spec.state === "absent");

        for (const [name, spec] of Object.entries(recipe.packages ?? {})) {
          const previous = packages.get(name);

          if (previous && !Bun.deepEquals(previous.spec, spec)) problems.push(`${name} requested differently by package ${previous.owner} and package ${owner}`);
          packages.set(name, { owner, spec });
        }
      } catch (error) {
        problems.push(`package ${owner}: invalid native bootstrap ${item.manifest.system.bootstrap}: ${String(error)}`);
      }
    }
  }

  return problems;
}
