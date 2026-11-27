// Admission of `@office/tools` claims across every package, before anything is published or
// installed. Requirements are grouped by the tool they stand for: a short name, an alias and the
// backend-qualified name mise's registry gives them are one tool, with one floor (the highest
// applicable minimum), the union of the executables they name, and every consumer's age. A
// package's own provision of a tool is that tool by its literal name. One release per tool must
// satisfy every applicable minimum, one package at most provides a tool, no two tools expose the
// same executable, and an owner's entry for a required tool in machine.toml must be one exact
// version at or above every minimum: it is then that tool's hold. Gathering reports these problems,
// so sync refuses the candidate and up refuses to start, both naming who is involved.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";

import type { SettingValue } from "../../sdk/index.ts";
import type { GatheredPackage, GatherProblem } from "../../src/gather.ts";
import type { Office } from "../../src/office.ts";
import { machineFile, withoutTools } from "../mise-integration/delivery.ts";
import { compareToolVersions, wantedTools } from "../tooling/requirements.ts";
import { canonicalTool, officeRegistry, type ToolRegistry } from "./registry.ts";

/** A package that requires a tool, the name it requires it by, and the minimum it requires. */
export type Consumer = { package: string; name: string; minimum: string };

/** A tool the applicable requirements ask for, by its backend-qualified name: its floor, who asks, and every executable they name. */
export type Demand = { name: string; floor: string; consumers: Consumer[]; bin: string[] };

/** The owner's exact choice of a required tool in machine.toml, under the key it is written with. */
type Hold = { key: string; version: string };

/**
 * What admission establishes: the demands by tool, those mise installs (`managed`: the ones no
 * package provides), the owner's holds by tool, and every problem.
 */
export type Admission = { demands: Map<string, Demand>; managed: Demand[]; holds: Map<string, Hold>; problems: GatherProblem[] };

/** A tool one package installs itself, at the exact version its setting holds. */
type Provided = { name: string; package: string; version: SettingValue | undefined; setting: string; bin: string[] };

// One exact version as mise writes one: no range, prefix (`prefix:`), `latest`, `lts` or ref.
const exactVersion = /^v?\d[0-9A-Za-z._+-]*$/;

function byName(packages: readonly GatheredPackage[]): GatheredPackage[] {
  return packages.toSorted((a, b) => a.entry.name.localeCompare(b.entry.name));
}

function packagesNamed(names: readonly string[]): string {
  return `package ${[...new Set(names)].join(" and package ")}`;
}

/** The packages that require `demand`, such as `package a and package b`. */
export function consumersOf(demand: Demand): string {
  return packagesNamed(demand.consumers.map(consumer => consumer.package));
}

/** The packages that require `demand` and the verb agreeing with them: `package a requires`, `package a and package b require`. */
export function consumersThat(demand: Demand, singular: string, plural: string): string {
  return `${consumersOf(demand)} ${demand.consumers.length === 1 ? singular : plural}`;
}

/** The consumers whose minimum `version` is below. */
function below(demand: Demand, version: string): Consumer[] {
  return demand.consumers.filter(consumer => (compareToolVersions(version, consumer.minimum) ?? -1) < 0);
}

function lowConsumers(consumers: readonly Consumer[]): string {
  return consumers.map(consumer => `${consumer.minimum} package ${consumer.package} needs`).join(", ");
}

// The owner's machine.toml as far as holds go: its [tools] entries, each read on its own.
const machineTools = v.object({ tools: v.optional(v.record(v.string(), v.unknown()), {}) });

// One exact version, alone or as a mapping's `version` beside the owner's other options.
const heldEntry = v.union([v.pipe(v.string(), v.regex(exactVersion)), v.pipe(v.object({ version: v.pipe(v.string(), v.regex(exactVersion)) }), v.transform(entry => entry.version))]);

/** The office's machine.toml: its text and [tools] entries; undefined when there is none. Throws when it can't be read. */
function ownerTools(office: Office) {
  const path = join(office.dir, machineFile);

  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  const read = v.safeParse(machineTools, Bun.TOML.parse(text));

  if (!read.success) throw new Error("its [tools] isn't a table");

  return { text, tools: read.output.tools };
}

/** How many dotted parts a version's release number has: 2 for 1.4, 3 for v1.4.4-rc.1. */
function parts(version: string): number {
  return version.replace(/^v/, "").split(/[-+]/)[0].split(".").length;
}

/**
 * Everything admission establishes about the packages' `@office/tools` claims. `registry` reads
 * mise's registry; it is called only when a short name must be resolved.
 */
export function admitTools(office: Office, packages: readonly GatheredPackage[], registry: () => ToolRegistry = () => officeRegistry(office)): Admission {
  const problems: GatherProblem[] = [];
  const provided: Provided[] = byName(packages).flatMap(item => item.claims.provided.map(provision => ({ name: provision.name, package: item.entry.name, version: item.settings[provision.versionSetting], setting: provision.versionSetting, bin: provision.bin })));
  const providedNames = new Set(provided.map(provider => provider.name));
  const demands = new Map<string, Demand>();
  let known: ToolRegistry | Error | undefined;

  const lookup = (name: string): string | Error | undefined => {
    if (providedNames.has(name) || name.includes(":")) return name;

    try {
      known ??= registry();
    } catch (error) {
      known = error instanceof Error ? error : new Error(String(error));
    }

    return known instanceof Error ? known : canonicalTool(known, name);
  };

  for (const item of byName(packages)) {
    for (const requirement of item.claims.required) {
      if (requirement.hostOnly && office.opencode.mode !== "host") continue;

      const tool = lookup(requirement.name);

      if (tool === undefined || tool instanceof Error) {
        problems.push({ packages: [item.entry.name], named: true, message: `package ${item.entry.name} requires tool ${requirement.name}, ${tool === undefined ? "which mise's registry doesn't name; require it by its backend-qualified name, such as npm:<package>" : `but mise's registry can't be read: ${tool.message}`}` });

        continue;
      }

      const consumer = { package: item.entry.name, name: requirement.name, minimum: requirement.minimum };
      const demand = demands.get(tool);

      if (demand === undefined) {
        demands.set(tool, { name: tool, floor: requirement.minimum, consumers: [consumer], bin: [...requirement.bin] });

        continue;
      }

      demand.consumers.push(consumer);
      demand.bin = [...new Set([...demand.bin, ...requirement.bin])];

      if ((compareToolVersions(requirement.minimum, demand.floor) ?? 0) > 0) demand.floor = requirement.minimum;
    }
  }

  for (const provider of provided) {
    const demand = demands.get(provider.name);

    if (typeof provider.version !== "string" || !exactVersion.test(provider.version)) {
      problems.push({ packages: [provider.package], named: true, message: `package ${provider.package} provides tool ${provider.name}, but its setting ${provider.setting} doesn't hold an exact version` });

      continue;
    }

    const low = demand === undefined ? [] : below(demand, provider.version);

    if (low.length) problems.push({ packages: [provider.package, ...low.map(consumer => consumer.package)], named: true, message: `package ${provider.package} provides tool ${provider.name} ${provider.version} (its setting ${provider.setting}), below the ${lowConsumers(low)}` });
    const unoffered = demand === undefined ? [] : demand.bin.filter(bin => !provider.bin.includes(bin));

    if (demand !== undefined && unoffered.length) problems.push({ packages: [provider.package, ...demand.consumers.map(consumer => consumer.package)], named: true, message: `${consumersThat(demand, "requires", "require")} executable ${unoffered.join(", ")} of tool ${provider.name}, which package ${provider.package} provides without it (it stages ${provider.bin.join(", ")})` });
  }

  const holds = new Map<string, Hold>();
  const keys = new Map<string, string>();
  const managed = [...demands.values()].filter(demand => !providedNames.has(demand.name));
  let owner: ReturnType<typeof ownerTools>;

  try {
    owner = managed.length ? ownerTools(office) : undefined;
  } catch (error) {
    problems.push({ packages: managed.flatMap(demand => demand.consumers.map(consumer => consumer.package)), named: true, message: `${machineFile} can't be read, so the owner's choices for the tools packages require are unknown: ${error instanceof Error ? error.message : String(error)}` });
  }

  for (const [key, value] of Object.entries(owner?.tools ?? {})) {
    const tool = lookup(key);

    // Unknown, a hold of a required tool would be lost: it stops admission instead.
    if (tool instanceof Error) {
      problems.push({ packages: managed.flatMap(demand => demand.consumers.map(consumer => consumer.package)), named: true, message: `mise's registry can't be read, so whether ${machineFile}'s ${key} is a tool the packages require is unknown: ${tool.message}` });

      continue;
    }

    const demand = tool === undefined ? undefined : demands.get(tool);

    if (demand === undefined || providedNames.has(demand.name)) continue;

    const consumers = demand.consumers.map(consumer => consumer.package);
    const held = v.safeParse(heldEntry, value);
    const other = keys.get(demand.name);

    keys.set(demand.name, key);

    if (other !== undefined) {
      holds.delete(demand.name);
      problems.push({ packages: consumers, named: true, message: `${machineFile} pins tool ${demand.name} twice, as ${other} and as ${key}, which ${consumersThat(demand, "requires", "require")}; keep one entry` });

      continue;
    }

    if (!held.success) {
      problems.push({ packages: consumers, named: true, message: `${machineFile} gives tool ${key} ${JSON.stringify(value)}, which isn't one exact version, and ${consumersThat(demand, "requires", "require")} it as ${demand.name}: pin one exact version there, or remove the entry` });

      continue;
    }

    const prefix = demand.consumers.find(consumer => parts(held.output) < parts(consumer.minimum));

    if (prefix !== undefined) {
      problems.push({ packages: consumers, named: true, message: `${machineFile} gives tool ${key} ${held.output}, a prefix mise matches against several releases, and ${consumersThat(demand, "requires", "require")} it as ${demand.name}: pin one exact release there, such as ${prefix.minimum}, or remove the entry` });

      continue;
    }

    holds.set(demand.name, { key, version: held.output });
    const low = below(demand, held.output);

    if (low.length) problems.push({ packages: low.map(consumer => consumer.package), named: true, message: `${machineFile} pins tool ${key} ${held.output}, below the ${lowConsumers(low)}; raise or remove the pin there` });
  }

  if (owner !== undefined && holds.size && withoutTools(owner.text, new Set([...holds.values()].map(hold => hold.key))) === undefined) {
    problems.push({ packages: managed.flatMap(demand => demand.consumers.map(consumer => consumer.package)), named: true, message: `${machineFile} holds tool ${[...holds.values()].map(hold => hold.key).join(", ")} in a form office can't leave out of what mise loads; write each as key = "version" under [tools]` });
  }

  // A tool a package still declares the older way would be installed a second way, through machine.packages.toml.
  if (office.opencode.mode === "host") {
    for (const item of byName(packages)) {
      for (const name of Object.keys(wantedTools(office, item))) {
        const tool = lookup(name);

        if (tool === undefined || tool instanceof Error) continue;
        const demand = demands.get(tool);
        const provider = provided.find(entry => entry.name === tool);
        const owners = demand !== undefined ? consumersThat(demand, "requires", "require") : provider !== undefined ? `package ${provider.package} provides` : undefined;

        if (owners !== undefined) problems.push({ packages: [item.entry.name, ...(demand?.consumers.map(consumer => consumer.package) ?? []), ...(provider === undefined ? [] : [provider.package])], named: true, message: `package ${item.entry.name} declares tool ${name} through @office/tooling, which machine.packages.toml installs, and ${owners} it as ${tool} through @office/tools: declare it one way, with tools.require` });
      }
    }
  }

  const exposed = new Map<string, { tool: string; packages: string[] }>();

  const claimants = [
    ...[...demands.values()].map(demand => ({ tool: demand.name, packages: demand.consumers.map(consumer => consumer.package), bin: demand.bin })),
    ...provided.map(provider => ({ tool: provider.name, packages: [provider.package], bin: provider.bin })),
  ];

  for (const claimant of claimants) {
    for (const bin of claimant.bin) {
      const first = exposed.get(bin);

      if (first === undefined) exposed.set(bin, claimant);
      else if (first.tool !== claimant.tool) problems.push({ packages: [...new Set([...first.packages, ...claimant.packages])], named: true, message: `executable ${bin} is claimed by tool ${first.tool} (${packagesNamed(first.packages)}) and tool ${claimant.tool} (${packagesNamed(claimant.packages)})` });
    }
  }

  return { demands, managed, holds, problems };
}

/** The keys of the owner's machine.toml entries that hold shared tools the packages require. */
export function heldKeys(office: Office, packages: readonly GatheredPackage[]): Set<string> {
  return new Set([...admitTools(office, packages).holds.values()].map(hold => hold.key));
}

/**
 * Every problem across the packages' `@office/tools` claims, each naming everyone involved; none in
 * a container-mode office, whose container keeps them in machine.packages.toml as it does every
 * package tool (standard/tooling/requirements.ts).
 */
export function toolProblems(office: Office, packages: readonly GatheredPackage[], registry: () => ToolRegistry = () => officeRegistry(office)): GatherProblem[] {
  if (office.opencode.mode !== "host") return [];

  return admitTools(office, packages, registry).problems;
}
