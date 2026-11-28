import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";

import type { GatheredPackage } from "../../gather.ts";
import { sha256 } from "../../lib/hash.ts";
import type { Office } from "../../office.ts";
import { type PlanContext, stillRecorded, type WantedFile } from "../machine/owned-files.ts";
import type { LinkFile, MachineFile } from "../machine/record.ts";
import { heldKeys } from "../tools/admission.ts";
import { fragmentOwner, machineFile, machineFiles, ownerProjection, packagesFile } from "./delivery.ts";

export const miseConfigVariable = "OFFICE_MISE_CONFIG_DIR";

/** mise's global config folder: `$OFFICE_MISE_CONFIG_DIR`, else as mise finds it, `$MISE_CONFIG_DIR`, else `$XDG_CONFIG_HOME/mise`, else `~/.config/mise`. */
function miseConfigDir(): string {
  return process.env[miseConfigVariable] || process.env.MISE_CONFIG_DIR || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "mise");
}

/** Where the office's machine-wide files are linked: the global conf.d, which mise loads in every folder. */
export function globalConfD(): string {
  return join(miseConfigDir(), "conf.d");
}

/**
 * A link's name in the global conf.d, where mise loads files by name and the last wins:
 * machine.packages.toml first (the packages' tools), then each package's fragment (its setup), then
 * machine.toml, so the owner's choices win over the packages' versions. The container's entrypoint
 * names them the same way.
 */
export function linkName(office: Office, file: string): string {
  if (file === join(office.dir, machineFile)) return `office-${office.name}-2-machine.toml`;

  if (file === join(office.dir, packagesFile)) return `office-${office.name}-0-packages.toml`;

  return `office-${office.name}-1-${basename(file, ".toml")}.toml`;
}

function owner(file: MachineFile): string {
  return file.package === null ? "the office's own" : `package ${file.package}`;
}

/** The links the office wants in the global conf.d: one per machine-wide file, machine.packages.toml, each package's fragment and machine.toml. */
function wantedLinks(office: Office): WantedFile[] {
  return machineFiles(office).map((target) => {
    const file: LinkFile = { kind: "link", path: join(globalConfD(), linkName(office, target)), package: fragmentOwner(target) ?? null, target };
    const packages = target === join(office.dir, packagesFile);

    return { file, what: `${relative(office.dir, target)} (${packages ? "the packages' tools" : owner(file)})`, made: packages || file.package === null ? ", so its tools apply in every folder on this machine" : ", so its setup applies in every folder on this machine" };
  });
}

/**
 * machine.toml's entry: its link, or, while it holds shared tools the packages require, a file
 * of it without them (ownerProjection), so mise's global config activates none of their desired
 * versions; only office's applied tools run them.
 */
function ownerFile(office: Office, entry: WantedFile, packages: readonly GatheredPackage[]): WantedFile {
  if (entry.file.kind !== "link" || entry.file.target !== join(office.dir, machineFile)) return entry;
  const held = heldKeys(office, packages);

  if (held.size === 0) return entry;
  const text = ownerProjection(readFileSync(entry.file.target, "utf8"), held);

  return { file: { kind: "file", path: entry.file.path, package: null, sha256: sha256(text) }, what: `${machineFile} without the shared tools office installs (${[...held].join(", ")})`, made: ", so its other tools apply in every folder on this machine", text };
}

export function wantedMiseFiles({ office, record, packages, unread }: PlanContext): WantedFile[] {
  return wantedLinks(office).flatMap(entry => {
    const { file } = entry;

    if (file.package !== null && unread.has(file.package) && !stillRecorded(record, file)) return [];

    return [ownerFile(office, entry, packages)];
  });
}

export function prepareConfD(): void {
  mkdirSync(globalConfD(), { recursive: true });
}

export function miseRemovalReason(office: Office, file: MachineFile): string | undefined {
  if (file.package !== null) return `as ${owner(file)} no longer has a fragment`;

  if (file.kind === "link" && file.target === join(office.dir, packagesFile)) return `as ${packagesFile} is gone`;
}
