import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { type Change, isFailure } from "../../lib/change.ts";
import { fetchBytes } from "../../lib/download.ts";
import { sha256 } from "../../lib/hash.ts";
import { type Office, OfficeError } from "../../office.ts";
import type { Lock } from "../../schema.ts";
import { defaultPins, hostPlatform, readApplied, wantedPins } from "../../versions.ts";
import { fileState, type MachineLine, occupied, type WantedFile, type WantedFiles } from "../machine/owned-files.ts";
import { machineRecordPath, miseShims } from "../machine/paths.ts";
import { claim, consentCommand, type MachineFile, replaceReceipt } from "../machine/record.ts";
import { hostToolsRoot } from "./mise-bootstrap.ts";
import { platformAsset } from "./releases.ts";
import { hostLayout, hostWrappers, wrapperFiles } from "./sfw.ts";

/** Whether `path` is an executable program file, not a script: a wrapper such as the office's or mise-guard starts with `#!`. */
function isProgram(path: string): boolean {
  let fd;

  try {
    const stats = statSync(path);

    if (!stats.isFile() || (stats.mode & 0o111) === 0) return false;

    fd = openSync(path, "r");

    const head = Buffer.alloc(2);

    return readSync(fd, head, 0, 2, 0) === 2 && head.toString("latin1") !== "#!";
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The real mise the mise wrapper runs: the first mise program on PATH outside the wrappers' folder
 * and mise's shims, skipping wrappers such as Mindframe-Z's mise-guard, else the office's own copy
 * in host-tools. Undefined when there is none.
 */
function realMise(): string | undefined {
  const skip = [hostWrappers(), miseShims()];

  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (dir === "" || skip.includes(dir)) continue;

    if (isProgram(join(dir, "mise"))) return join(dir, "mise");
  }

  const managed = join(hostToolsRoot(), "bin/mise");

  return isProgram(managed) ? managed : undefined;
}

/** The sfw pin `office up` runs: the one it last applied, else office.yaml's, else the tool's default. */
function appliedSfw(office: Office): Lock["sfw"] {
  const applied = readApplied(office)?.pins.sfw;

  if (applied !== undefined) return applied;

  try {
    return wantedPins(office).sfw;
  } catch {
    return defaultPins.sfw;
  }
}

/** The SHA-256 of a pin's release file for this machine, in hex, or undefined where office installs no sfw. */
function sfwDigest(pin: Lock["sfw"]): string | undefined {
  const platform = hostPlatform();

  return platform === undefined ? undefined : pin.platforms?.[platform]?.replace(/^sha256:/, "");
}

export function wantedFirewall(office: Office): WantedFiles {
  const wanted: WantedFile[] = [];
  const problems: string[] = [];

  if (!office.socketFirewall) return { wanted, problems };

  const mise = realMise();
  const files = wrapperFiles(hostLayout(mise ?? ""));
  const digest = sfwDigest(appliedSfw(office));

  wanted.push({ file: { kind: "file", path: files.script.path, package: null, sha256: sha256(files.script.text) }, what: "the Socket Firewall wrapper script", made: "", text: files.script.text });

  for (const link of files.links) wanted.push({ file: { kind: "link", path: link.path, package: null, target: link.target }, what: `the Socket Firewall wrapper for ${basename(link.path)}`, made: "" });

  if (mise !== undefined) wanted.push({ file: { kind: "file", path: files.mise.path, package: null, sha256: sha256(files.mise.text) }, what: `the mise wrapper, which runs ${mise}'s installs through Socket Firewall`, made: "", text: files.mise.text });
  else problems.push(`no mise program found on PATH or in office's host-tools, so ${files.mise.path} isn't written and mise installs don't go through Socket Firewall; install mise (office setup --install-deps) and run office sync`);

  if (digest !== undefined) wanted.push({ file: { kind: "file", path: hostLayout("").sfw, package: null, sha256: digest }, what: "Socket Firewall", made: "", text: undefined });

  return { wanted, problems };
}

/** Whether a wanted file is sfw, which `office up` installs rather than sync. */
function isSfw(file: MachineFile): boolean {
  return file.path === hostLayout("").sfw;
}

/** Removes the sfw folders when removing their files left them empty. */
export function removeEmptyFirewallFolders(): void {
  for (const folder of [hostWrappers(), hostLayout("").root]) {
    if (existsSync(folder) && readdirSync(folder).length === 0) rmdirSync(folder);
  }
}

export function firewallRemovalReason(office: Office, file: MachineFile): string | undefined {
  if (file.path.startsWith(`${hostLayout("").root}/`)) return office.socketFirewall ? "as office no longer writes it" : "as office.yaml turns Socket Firewall off";
}

export function firstFirewallInstallNotice(office: Office, lines: readonly Change[], files: readonly MachineFile[]): string | undefined {
  if (office.socketFirewall && lines.some((line) => !isFailure(line) && line.startsWith(`wrote ${hostLayout("").script}`)) && !files.some(isSfw)) {
    return `Socket Firewall itself isn't installed yet, so the wrappers refuse to run downloads: office up installs sfw ${appliedSfw(office).version}`;
  }
}

export function missingSfw(office: Office, file: MachineFile): string | undefined {
  if (isSfw(file)) return `not installed; office up installs sfw ${appliedSfw(office).version}, and until then the wrappers refuse to run downloads`;
}

/** sfw's line: the version installed against the one office up applied and the one office.yaml pins. */
export function sfwLine(office: Office, file: MachineFile, mode: "record-only" | "wanted"): MachineLine | undefined {
  if (!isSfw(file) || (mode === "record-only" && !office.socketFirewall)) return undefined;

  const state = fileState(file);
  const name = `machine ${file.path}`;
  const applied = appliedSfw(office);
  const installed = file.kind === "file" && file.sha256 === sfwDigest(applied) ? applied.version : undefined;

  if (state === "changed") return { ok: false, name, detail: "changed since office installed it; office leaves it: delete it, then office up" };

  if (state !== "present") return { ok: false, name, detail: `missing, so the wrappers refuse to run downloads; office up installs sfw ${applied.version}` };

  if (installed === undefined) return { ok: false, name, detail: `Socket Firewall, but not the sfw ${applied.version} office applies; office up installs it` };

  let pending = "";

  try {
    const wanted = wantedPins(office).sfw.version;

    if (wanted !== applied.version) pending = `; office.yaml pins ${wanted}, which office up --upgrade installs`;
  } catch (error) {
    pending = `; ${error instanceof Error ? error.message : String(error)}`;
  }

  return { ok: pending === "" ? true : "warn", name, detail: `Socket Firewall ${installed}, matching office.lock's SHA-256 for this machine${pending}` };
}

/**
 * `office up`'s part on the machine in host mode: installs sfw at `pin`, checked against office.lock's
 * SHA-256 for this machine and its own `--version`, and records it. Nothing without consent, or with
 * Socket Firewall off; an installed copy at the same digest stays. Returns one line per change.
 */
export async function installSfw(office: Office, pin: Lock["sfw"], download: (url: string, what: string) => Promise<Uint8Array> = fetchBytes): Promise<string[]> {
  if (!office.socketFirewall || office.opencode.mode !== "host") return [];

  const current = claim(office);

  if (current.kind !== "ours") return [`office: Socket Firewall isn't installed: office writes outside its folder only once you agree; run ${consentCommand}, then office sync and office up`];

  const platform = hostPlatform();
  const digest = sfwDigest(pin);

  if (platform === undefined || digest === undefined) throw new OfficeError(`office installs Socket Firewall on Linux and macOS, x64 and arm64, not ${process.platform}-${process.arch}; give sfw enabled: false under tools in office.yaml`);

  const path = hostLayout("").sfw;
  const record = current.record;
  const recorded = record.files.find((file) => file.path === path);

  if (recorded !== undefined && fileState(recorded) === "present" && recorded.kind === "file" && recorded.sha256 === digest) return [];

  if (recorded === undefined ? occupied(path) : fileState(recorded) === "changed") throw new OfficeError(`${path} ${recorded === undefined ? `exists and ${machineRecordPath()} doesn't list it` : "changed since office installed it"}, so office leaves it; move it away and run office up`);

  const bytes = await download(platformAsset("sfw", pin.version, platform), `sfw ${pin.version}`);

  if (sha256(bytes) !== digest) throw new OfficeError(`sfw ${pin.version} for ${platform} doesn't match office.lock's SHA-256; nothing was installed`);

  // Written beside the final file and renamed, so the wrappers never run half a download.
  const staging = `${path}.new`;

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(staging, bytes, { mode: 0o755 });

  let reported = "";

  try {
    reported = execFileSync(staging, ["--version"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    reported = "";
  }

  if (!reported.includes(`version ${pin.version}`)) {
    rmSync(staging, { force: true });

    throw new OfficeError(`the downloaded sfw doesn't report version ${pin.version}; nothing was installed`);
  }

  renameSync(staging, path);

  const file: MachineFile = { kind: "file", path, package: null, sha256: digest };

  replaceReceipt(record, file);

  return [`office: installed Socket Firewall ${pin.version} in ${path}, checked against office.lock`];
}
