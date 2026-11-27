// The one writer of systemd user unit files that office owns by hash. Each destination has one
// record of the bytes office wrote there, kept by its owner: managed OpenCode's in the machine
// record, packages' native units in the office's state (src/features/systemd/units.ts). Whoever keeps
// the record decides when a unit starts or restarts; this module only says whether office may
// write or remove a destination, writes whole files and reloads the user manager after a change.
//
// A destination is office's only while its file is the recorded bytes and systemd loads it from
// that file alone: a file nobody recorded (the user's, another office's or a former owner's), an
// edited one, a unit loaded from another file that shadows it, or a drop-in all refuse.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";

import { OfficeError } from "../../office.ts";
import { atomicWrite } from "../../lib/atomic-write.ts";

/** What systemd reports of a unit, as office reads it before touching the unit; `stale` is NeedDaemonReload. */
export type UnitState = { fragment: string; dropIns: string; active: string; enabled: string; pid: number; invocation: string; stale: boolean };

/** The user manager, as the writer and its callers reach it; tests give a fake. */
export type UnitManager = { run(args: readonly string[]): string; state(name: string): UnitState };

const properties = ["FragmentPath", "DropInPaths", "ActiveState", "UnitFileState", "MainPID", "InvocationID", "NeedDaemonReload"];

function systemctl(args: readonly string[]): string {
  const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  if (result.status !== 0) throw new OfficeError(`systemctl --user ${args.join(" ")} failed: ${result.stderr?.trim() || result.error?.message || "see systemd's user journal"}`);

  return result.stdout.trim();
}

/** This machine's systemd user manager. */
export const userManager: UnitManager = {
  run: systemctl,
  state(name) {
    const lines = systemctl(["show", `--property=${properties.join(",")}`, name]).split("\n");
    const read = (key: string) => lines.find(line => line.startsWith(`${key}=`))?.slice(key.length + 1) ?? "";

    return { fragment: read("FragmentPath"), dropIns: read("DropInPaths"), active: read("ActiveState"), enabled: read("UnitFileState"), pid: Number(read("MainPID")) || 0, invocation: read("InvocationID"), stale: read("NeedDaemonReload") === "yes" };
  },
};

export function unitSha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Whether a unit's process is up or on its way up; a unit in this state is held, not started. */
export function running(state: UnitState): boolean {
  return ["active", "activating", "reloading"].includes(state.active);
}

/**
 * Why office may not write or remove `name` in `dir`, or undefined when it may. `recorded` is the
 * SHA-256 its owner recorded, undefined when office never wrote it.
 */
export function ownershipProblem(dir: string, name: string, recorded: string | undefined, state: UnitState): string | undefined {
  const path = join(dir, name);
  const info = lstatSync(path, { throwIfNoEntry: false });

  if (info !== undefined && recorded === undefined) return `${path} exists and office didn't write it; office leaves it alone`;

  if (info !== undefined && (!info.isFile() || unitSha256(readFileSync(path)) !== recorded)) return `${path} changed since office wrote it; office leaves it alone`;

  if (state.fragment !== "" && state.fragment !== path) return `${name} is loaded from ${state.fragment}, not ${path}; office leaves it alone`;

  if (state.dropIns !== "" && !dropInsGone(state)) return `${name} has drop-ins (${state.dropIns}); remove them before office manages it`;
}

/**
 * Whether the drop-ins systemd lists are only its stale view: it needs a reload and none of them
 * is on disk any more, so the reload that comes before any activation drops them.
 */
function dropInsGone(state: UnitState): boolean {
  const paths = state.dropIns.split(" ");

  return state.stale && paths.every(path => isAbsolute(path) && lstatSync(path, { throwIfNoEntry: false }) === undefined);
}

/**
 * Why office may not start or restart `name` now, after any reload: `ownershipProblem`, or systemd
 * not loading it from exactly the recorded file. A shadowing file or drop-in that only a reload
 * brought in shows here.
 */
export function activationProblem(dir: string, name: string, recorded: string, state: UnitState): string | undefined {
  const path = join(dir, name);

  return ownershipProblem(dir, name, recorded, state) ?? (state.fragment === path ? undefined : `${name} isn't loaded from ${path}; office leaves it alone`);
}

/**
 * Why office may not install `text` as one named unit: `Also=` enables and disables other units
 * with it, and `Alias=` links it under other names, so either reaches past the destination office owns.
 * Found on any line, whatever its section, as systemd reads a key only at a line's start.
 */
export function installProblem(text: string): string | undefined {
  const found = /^[ \t]*(Also|Alias)[ \t]*=/m.exec(text)?.[1];

  if (found !== undefined) return `its [Install] ${found}= would enable or link units beyond its own; office installs only the one unit`;
}

/** Whether the recorded file is on disk; `ownershipProblem` has already said it is the recorded bytes when it is. */
export function unitPresent(dir: string, name: string): boolean {
  return lstatSync(join(dir, name), { throwIfNoEntry: false }) !== undefined;
}

/**
 * Writes a destination's whole file, has its owner `record` the SHA-256 at once (so a failure after
 * the write leaves a file office still owns), enables it when asked, and then reloads the manager
 * once. `systemctl enable --no-reload` alone leaves the unit needing a reload, so the reload comes
 * after the enablement. Check `ownershipProblem` first.
 */
export function writeUnit(manager: UnitManager, dir: string, name: string, text: string, { enable = false, record }: { enable?: boolean; record: (sha256: string) => void }): void {
  atomicWrite(join(dir, name), text, 0o644);
  record(unitSha256(text));

  if (enable) enableUnit(manager, name);
  else manager.run(["daemon-reload"]);
}

/** Enables a unit, then reloads the manager once, so it isn't left needing a reload. */
export function enableUnit(manager: UnitManager, name: string): void {
  manager.run(["enable", "--no-reload", name]);
  manager.run(["daemon-reload"]);
}

/**
 * Removes the links `systemctl enable` left for `name` in the folder's `.wants`, `.requires` and
 * `.upholds` folders once its file is gone, which `systemctl disable` no longer can; whether it
 * removed any. A link there of that name pointing anywhere but the recorded file is refused, before any goes.
 */
function removeEnablementLinks(dir: string, name: string): boolean {
  const path = join(dir, name);
  const links: string[] = [];

  if (!lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()) return false;

  for (const folder of readdirSync(dir, { withFileTypes: true })) {
    if (!folder.isDirectory() || !/\.(wants|requires|upholds)$/.test(folder.name)) continue;
    const link = join(dir, folder.name, name);
    const info = lstatSync(link, { throwIfNoEntry: false });

    if (info === undefined) continue;

    if (!info.isSymbolicLink() || readlinkSync(link) !== path) throw new OfficeError(`${path} is gone, but ${link} isn't the link systemctl enable made for it; office keeps its record. Remove the link yourself, then retry`);
    links.push(link);
  }

  for (const link of links) rmSync(link);

  return links.length > 0;
}

/**
 * Stops, disables and deletes a destination office wrote, then reloads the manager. Check
 * `ownershipProblem` first. A file already gone while systemd still has the unit loaded or running
 * is refused, so its owner keeps the record; otherwise only its enablement links are left to remove.
 */
export function removeUnit(manager: UnitManager, dir: string, name: string): void {
  if (!unitPresent(dir, name)) {
    const state = manager.state(name);

    if (running(state) || state.fragment === join(dir, name)) throw new OfficeError(`${join(dir, name)} is gone, but systemd still has ${name} ${running(state) ? `running as PID ${state.pid}` : "loaded"}; office keeps its record. Stop it and run systemctl --user daemon-reload, then retry`);

    if (removeEnablementLinks(dir, name)) manager.run(["daemon-reload"]);

    return;
  }

  manager.run(["disable", "--now", name]);
  rmSync(join(dir, name));
  manager.run(["daemon-reload"]);
}
