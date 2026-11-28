import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as v from "valibot";

import { type HostPlatform, type Lock, lockSchema } from "../../lock-schema.ts";
import { type Office, OfficeError } from "../../office.ts";
import { check } from "../../parse.ts";
import { type PinnedTool, pinnedTools, version } from "../../schema.ts";
import { compareVersions, defaultPins, lockFile, type Pin, readLock } from "../../versions.ts";

/**
 * The tools `office up` applies in each OpenCode mode: everything in the container; in host mode
 * Executor, and sfw while Socket Firewall is on, which `office up` installs on the machine.
 */
export function toolsFor(office: Office): PinnedTool[] {
  if (office.opencode.mode !== "host") return [...pinnedTools];

  return office.socketFirewall ? ["executor", "sfw"] : ["executor"];
}

/** The version office.yaml asks for: its pin, else the tool's default. */
export function wantedVersion(office: Office, tool: PinnedTool): string {
  return office.tools.runtimes[tool].version ?? defaultPins[tool].version;
}

/** This machine's platform as office.lock names it, or undefined where the office installs nothing. */
export function hostPlatform(platform = process.platform, arch = process.arch): HostPlatform | undefined {
  const name = `${platform}-${arch}`;

  return name === "linux-x64" || name === "linux-arm64" || name === "darwin-x64" || name === "darwin-arm64" ? name : undefined;
}

/**
 * The pins office.yaml asks for, verified by office.lock. An office.yaml that pins no versions runs
 * the tool's defaults. Throws, naming `office pin`, when the lock is missing or doesn't match.
 */
export function wantedPins(office: Office): Lock {
  if (!office.tools.pinsVersions) return defaultPins;

  const lock = readLock(office.dir);

  if (lock === undefined) throw new OfficeError(`office.yaml pins versions but ${existsSync(join(office.dir, lockFile)) ? `${lockFile} holds no runtime pins` : `there is no ${lockFile}`}: run office pin`);

  const stale = pinnedTools.filter((tool) => lock[tool].version !== wantedVersion(office, tool));

  if (stale.length > 0) {
    throw new OfficeError(`${lockFile} doesn't match office.yaml for ${stale.map((tool) => `${tool} (${lock[tool].version}, office.yaml ${wantedVersion(office, tool)})`).join(", ")}: run office pin`);
  }

  return lock;
}

/**
 * What `office up` last applied, the highest OpenCode and Executor this office has run, and when
 * the opencode image last took current Debian packages (container mode; `office up --refresh`).
 */
const appliedSchema = v.strictObject({
  pins: lockSchema,
  highest: v.strictObject({ opencode: version, executor: version }),
  refreshed: v.optional(v.pipe(v.string(), v.isoTimestamp())),
});

export type Applied = Omit<v.InferOutput<typeof appliedSchema>, "pins"> & { pins: Lock };

function appliedPath(office: Office): string {
  return join(office.state, "applied.json");
}

export function readApplied(office: Office): Applied | undefined {
  const path = appliedPath(office);

  if (!existsSync(path)) return undefined;

  const result = check(v.safeParse(appliedSchema, JSON.parse(readFileSync(path, "utf8"))));

  if (!result.ok) throw new OfficeError(`${path} is not valid: ${result.errors.join("; ")}`);

  return result.value;
}

export function writeApplied(office: Office, pins: Lock, refreshed: string | undefined): void {
  const before = readApplied(office);

  const higher = (tool: "opencode" | "executor") => {
    const previous = before?.highest[tool];

    return previous !== undefined && compareVersions(previous, pins[tool].version) > 0 ? previous : pins[tool].version;
  };

  mkdirSync(office.state, { recursive: true });
  writeFileSync(appliedPath(office), `${JSON.stringify({ pins, highest: { opencode: higher("opencode"), executor: higher("executor") }, refreshed }, null, 2)}\n`);
}

/** The tools whose applied pin differs from the wanted one, among those the mode runs. */
export function changes(office: Office, from: Lock, to: Lock): { tool: PinnedTool; from: string; to: string }[] {
  return toolsFor(office).flatMap((tool) => (from[tool].version === to[tool].version && from[tool].digest === to[tool].digest ? [] : [{ tool, from: from[tool].version, to: to[tool].version }]));
}

/** The base image for a set of pins: its name carries the versions, so offices on different ones never share it. */
export function baseImage(pins: Lock): string {
  return `office-opencode:${pins.opencode.version}-claude${pins.claude.version}-codex${pins.codex.version}-mise${pins.mise.version}-sfw${pins.sfw.version}`;
}

export function executorImage(pin: Pin): string {
  return `ghcr.io/usefulsoftwareco/executor-selfhost:${pin.version}@${pin.digest}`;
}

/** A move as `office up` and `office check` show it, naming a downgrade `office up --upgrade` refuses. */
export function describeMove(office: Office, move: { tool: PinnedTool; from: string; to: string }): string {
  const highest = readApplied(office)?.highest;
  const ceiling = move.tool === "opencode" || move.tool === "executor" ? highest?.[move.tool] : undefined;
  const refused = ceiling !== undefined && compareVersions(move.to, ceiling) < 0;

  return `${move.tool} ${move.from} → ${move.to}${refused ? ` (refused: older than the ${ceiling} this office has run)` : ""}`;
}
