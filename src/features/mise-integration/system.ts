// A system recipe (or a definition's `system` declaration): what it sets up in a host-mode office's
// machine with the operating system's package manager, such as the browser package's Google Chrome.
// It applies only while the package's own setting for it is on (it defaults to off: the office opts
// in), the office runs OpenCode on the host, and the machine is one of the platforms the block names.
//
// Sync writes it to the package's mise fragment as mise `[bootstrap]` tables, with the package's
// `prepare` script as their `pre-packages` hook, and its variables to the office's environment file
// (src/features/host/host-env.ts). Only `office setup` applies it, when the user says yes in their terminal
// (src/features/host/system-setup.ts), through mise, which asks for sudo itself; `office up`, `office sync` and
// the cron jobs never do, and office never runs sudo. `office check` looks for the paths the block
// lists as `ready`. Turning it off removes it from the fragment
// and the environment file; what it installed stays on the machine, as mise removes no packages.
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { packageDeliveryDir } from "../../bound-paths.ts";
import type { Office, PackageEntry } from "../../office.ts";
import type { InstalledPackage } from "../../loader/packages.ts";
import type { Parsed, SettingValue, SystemBlock } from "../../schema.ts";

/** A package with its effective system block: its own, or a recipe it contributed in this run (src/gather.ts). */
export type WithSystem = InstalledPackage & { readonly system: SystemBlock | undefined };

/** Overrides the machine's platform, for tests and scratch offices; empty for a machine no block supports. */
export const systemPlatformVariable = "OFFICE_SYSTEM_PLATFORM";

/** What applies a system setup, as messages name it. */
export const systemApplyCommand = "office setup";

/** The office root as a fragment's hook finds it from the fragment's real folder, `.office/mise/`. */
export const fragmentOfficeRoot = "{{ config_source | canonicalize | dirname }}/../..";

/** The value of `key` in an os-release file, unquoted. */
function osRelease(text: string, key: string): string | undefined {
  const line = text.split("\n").find((entry) => entry.startsWith(`${key}=`));

  return line?.slice(key.length + 1).trim().replace(/^(["'])(.*)\1$/, "$2");
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * This machine as a system block names platforms: `<ID>-<VERSION_ID>-<dpkg architecture>` from
 * /etc/os-release, with `-wsl` under WSL (its kernel names Microsoft), such as
 * `ubuntu-24.04-amd64-wsl`. Undefined where it can't tell.
 */
export function machinePlatform(): string | undefined {
  const override = process.env[systemPlatformVariable];

  if (override !== undefined) return override === "" ? undefined : override;

  if (process.platform !== "linux") return undefined;

  const release = readText("/etc/os-release");
  const id = osRelease(release, "ID");
  const version = osRelease(release, "VERSION_ID");
  const arch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : undefined;

  if (id === undefined || version === undefined || arch === undefined) return undefined;

  const wsl = /microsoft/i.test(readText("/proc/sys/kernel/osrelease")) || process.env.WSL_DISTRO_NAME !== undefined;

  return `${id}-${version}-${arch}${wsl ? "-wsl" : ""}`;
}

/** Whether a block's platform covers the machine: the same, or without `-wsl` for the same machine under WSL. */
function covers(platform: string, machine: string): boolean {
  return platform === machine || `${platform}-wsl` === machine;
}

/** Whether a package's system block applies here, and why not when it doesn't. */
export type SystemState = { applies: true } | { applies: false; reason: string; opted: boolean };

/**
 * The problem with a system setup's gate that a schema resolves to true while office.yaml doesn't
 * set it (a default in a condition or a composition): such a gate doesn't default to off.
 */
export function gateDefaultProblem(entry: Pick<PackageEntry, "name" | "settings">, settings: Record<string, SettingValue>, setting: string): string | undefined {
  if (Object.hasOwn(entry.settings ?? {}, setting) || settings[setting] !== true) return undefined;

  return `packages.${entry.name}.settings.${setting}: resolves to true though office.yaml doesn't set it; the setting of a system setup must default to off, so an office opts in`;
}

export function systemState(office: Office, item: WithSystem): SystemState | undefined {
  const system = item.system;

  if (system === undefined) return undefined;

  // Only the office's own `true` opts in, whatever the schema resolved.
  const opted = item.entry.settings?.[system.setting] === true;

  if (!opted) return { applies: false, reason: `its ${system.setting} setting is off`, opted };

  if (office.opencode.mode !== "host") return { applies: false, reason: "the office runs OpenCode in its container (opencode: container)", opted };

  const machine = machinePlatform();

  if (machine === undefined || !system.platforms.some((platform) => covers(platform, machine))) {
    return { applies: false, reason: `this machine is ${machine ?? "a platform office can't identify"}, not ${system.platforms.join(" or ")}`, opted };
  }

  return { applies: true };
}

export function systemApplies(office: Office, item: WithSystem): boolean {
  return systemState(office, item)?.applies === true;
}

/** The first line of a system section in a fragment, which tells sync's messages it is there. */
export function systemMarker(item: InstalledPackage): string {
  return `# The system setup of package ${item.entry.name}`;
}

/**
 * The package's bootstrap file: only `[bootstrap.…]` tables, and no hooks, which are sync's to
 * write. Read as text, as office reads every mise file, so its comments reach the fragment.
 */
function bootstrapText(item: InstalledPackage, file: string): Parsed<string> {
  const path = join(item.dir, file);

  if (!existsSync(path)) return { ok: false, errors: [`${file}, the system block's bootstrap file, is missing from the package`] };

  const lines = readFileSync(path, "utf8").replace(/\s+$/, "").split("\n");
  const first = lines.findIndex((line) => /^\s*\[/.test(line));
  const before = first === -1 ? lines : lines.slice(0, first);
  const errors: string[] = [];

  if (before.some((line) => line.trim() !== "" && !line.trim().startsWith("#"))) errors.push(`${file}: a key comes before the first table; it may hold only [bootstrap.…] tables`);

  for (const line of lines) {
    const table = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?/.exec(line)?.[1];

    if (table === undefined) continue;

    if (!table.startsWith("bootstrap.")) errors.push(`${file}: [${table}] isn't a [bootstrap.…] table`);
    else if (/^bootstrap\.hooks(?:\.|$)/.test(table)) errors.push(`${file}: [${table}]: hooks are sync's, from the system block's prepare script`);
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: lines.join("\n") };
}

/**
 * The part of the package's fragment that sets it up, when it applies: the `pre-packages` hook that
 * runs its prepare script, found from the fragment's own path as the host install's hook is, then
 * its bootstrap file's tables.
 */
export function systemSection(office: Office, item: WithSystem): Parsed<string | undefined> {
  const system = item.system;

  if (system === undefined || !systemApplies(office, item)) return { ok: true, value: undefined };

  const tables = bootstrapText(item, system.bootstrap);

  if (!tables.ok) return tables;

  // mise renders a bootstrap hook without the declaring file's config_source, but renders [vars]
  // with it, so a var carries the package's folder to the hook.
  const variable = `office_package_${item.entry.name.replaceAll("-", "_")}`;

  const hook =
    system.prepare === undefined
      ? []
      : [
          "[vars]",
          `${variable} = ${JSON.stringify(`${fragmentOfficeRoot}/${relative(office.dir, packageDeliveryDir(office.dir, item))}`)}`,
          "",
          "[bootstrap.hooks.pre-packages]",
          `description = ${JSON.stringify(`Prepare ${system.description}`)}`,
          `run = ${JSON.stringify(`bash "{{ vars.${variable} }}/${system.prepare}"`)}`,
          "",
        ];

  return {
    ok: true,
    value: [
      `${systemMarker(item)}: ${system.description}. ${systemApplyCommand} offers to apply it on this machine, from your terminal (mise asks for sudo); nothing else does, and what it installs stays when it is turned off.`,
      ...hook,
      tables.value,
      "",
    ].join("\n"),
  };
}

/** The variables the block adds to the office's environment file while it applies. */
export function systemVariables(office: Office, item: WithSystem): [string, string][] {
  const system = item.system;

  return system === undefined || !systemApplies(office, item) ? [] : Object.entries(system.env);
}

/** What `office check` says of a package's system block, and whether it is set up where it applies. */
export type SystemReport = { ok: boolean; notes: string[] };

export function systemNotes(office: Office, item: WithSystem): SystemReport {
  const system = item.system;
  const state = systemState(office, item);

  if (system === undefined || state === undefined) return { ok: true, notes: [] };

  if (!state.applies) return { ok: true, notes: state.opted ? [`${system.description} isn't set up: ${state.reason}`] : [] };

  const missing = system.ready.filter((path) => !existsSync(path));

  if (missing.length === 0) return { ok: true, notes: [`${system.description} is set up on this machine`] };

  return { ok: false, notes: [`${system.description} isn't set up on this machine yet (missing ${missing.join(", ")}): run ${systemApplyCommand} in a terminal, which offers to apply it (mise asks for sudo)`] };
}
