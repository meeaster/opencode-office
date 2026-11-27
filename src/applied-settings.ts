// The office's applied settings snapshot: written by a complete package application, read by
// runtimes through `@office/sdk/applied-settings` and `office settings get`, compared by check.
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { type AppliedSettings, AppliedSettingsError, appliedSettingsFile, appliedSettingsPath, canonicalJson, readAppliedSnapshot } from "../sdk/applied-settings.ts";
import { type Office, OfficeError } from "./office.ts";
import { atomicWrite } from "./features/secrets/secrets.ts";

/** A selected package's settings, as package application and check hold them. */
type PackageSettings = { entry: { name: string }; settings: AppliedSettings };

/** The snapshot's path, refused when it would be reached through a link. */
function ownFile(officeRoot: string): string {
  try {
    return appliedSettingsFile(officeRoot);
  } catch (error) {
    if (error instanceof AppliedSettingsError) throw new OfficeError(error.message);
    throw error;
  }
}

/**
 * Makes the snapshot's folder, `.office/runtime/`, so a plugin linked by this sync can watch it
 * before any settings are published there. Refuses a redirected `.office` or folder.
 */
export function prepareAppliedSettings(office: Pick<Office, "dir">): void {
  mkdirSync(dirname(ownFile(office.dir)), { recursive: true });
}

/**
 * Makes the snapshot of the office in `officeRoot` hold `packages`, with every object's keys
 * sorted so the same packages and settings always give the same bytes, replacing it by rename
 * and only when those bytes change. Returns whether it wrote.
 */
export function writeAppliedSnapshot(officeRoot: string, packages: Record<string, AppliedSettings>): boolean {
  const path = ownFile(officeRoot);
  const text = `${canonicalJson({ packages }, 2)}\n`;
  let current: string | undefined;

  try {
    current = readFileSync(path, "utf8");
  } catch {
    current = undefined;
  }

  if (current === text) return false;
  atomicWrite(path, text, 0o644);

  return true;
}

/** Publishes every selected package's settings. Only a complete application calls it: `installed` must be the whole selection. */
export function publishAppliedSettings(office: Pick<Office, "dir">, installed: readonly PackageSettings[]): string[] {
  return writeAppliedSnapshot(office.dir, Object.fromEntries(installed.map(item => [item.entry.name, item.settings] as const))) ? [`wrote ${appliedSettingsPath}`] : [];
}

export type AppliedState = { ok: true; packages: Map<string, AppliedSettings> } | { ok: false; problem: string };

/** The published snapshot, or why it can't be read, for check. Never writes. */
export function appliedState(office: Pick<Office, "dir">): AppliedState {
  try {
    return { ok: true, packages: readAppliedSnapshot(office.dir) };
  } catch (error) {
    const reason = error instanceof AppliedSettingsError ? error.message : `${appliedSettingsPath} can't be read: ${error instanceof Error ? error.message : String(error)}`;

    return { ok: false, problem: reason };
  }
}

/** What check says about one package's applied settings: undefined when the snapshot holds them. */
export function appliedDifference(state: AppliedState, item: PackageSettings): string | undefined {
  if (!state.ok) return state.problem;
  const applied = state.packages.get(item.entry.name);

  if (applied === undefined) return `${appliedSettingsPath} has no entry for it; office sync publishes it`;

  if (canonicalJson(applied) !== canonicalJson(item.settings)) return `${appliedSettingsPath} holds other settings for it; office sync publishes them`;
}

/** Each snapshot entry for a package office.yaml no longer selects. */
export function staleApplied(state: AppliedState, selected: ReadonlySet<string>): string[] {
  if (!state.ok) return [];

  return [...state.packages.keys()].filter(name => !selected.has(name)).sort().map(name => `${appliedSettingsPath} holds settings for package ${name}, which office.yaml no longer selects (office sync removes them)`);
}
