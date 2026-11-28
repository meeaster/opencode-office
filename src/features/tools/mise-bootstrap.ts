import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { fetchBytes } from "../../lib/download.ts";
import { sha256 } from "../../lib/hash.ts";
import { OfficeError } from "../../office.ts";
import type { Candidate } from "./releases.ts";

export type InstalledTool = { path: string; version: string };

export function hostToolsRoot(): string {
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "office/host-tools");
}

export function reported(tool: string, path: string): InstalledTool | undefined {
  try {
    const text = execFileSync(path, ["--version"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
    const version = (tool === "mise" ? /^(\d+\.\d+\.\d+(?:-[\w.-]+)?)/ : /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)/).exec(text)?.[1];

    if (version !== undefined) return { path, version };
  } catch {
    // Missing, non-executable and broken installations are not usable candidates.
  }

  return undefined;
}

/** Only these four Unix targets are published by office. */
export function requireHostPlatform(platform: string, arch: string): void {
  if (!["linux", "darwin"].includes(platform) || !["x64", "arm64"].includes(arch)) {
    throw new OfficeError(`host dependency installation is unsupported on ${platform}-${arch}; install mise, SOPS and age manually on PATH (on Windows, run office in WSL)`);
  }
}

export function miseAsset(version: string, platform = process.platform, arch = process.arch): string {
  requireHostPlatform(platform, arch);

  return `mise-v${version}-${platform === "darwin" ? "macos" : platform}-${arch}`;
}

export function verifyDigest(bytes: Uint8Array, digest: string | null | undefined, name: string): void {
  if (digest === undefined || digest === null || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
    throw new OfficeError(`${name} has no authoritative SHA-256 digest; nothing was installed`);
  }

  if (`sha256:${sha256(bytes)}` !== digest) {
    throw new OfficeError(`${name} failed SHA-256 verification; nothing was installed`);
  }
}

export async function installMise(candidate: Candidate): Promise<void> {
  const name = miseAsset(candidate.version);
  const asset = candidate.release.assets.find((entry) => entry.name === name && entry.state === "uploaded");

  if (asset === undefined) throw new OfficeError(`mise ${candidate.version} publishes no ${name}; install mise manually on PATH`);

  if (!asset.digest) throw new OfficeError(`${name} has no authoritative digest; nothing was installed`);

  const bytes = await fetchBytes(asset.browser_download_url, name);

  verifyDigest(bytes, asset.digest, name);

  const bin = join(hostToolsRoot(), "bin");

  mkdirSync(bin, { recursive: true });

  // mise is a multicall binary: a different basename is interpreted as a tool shim.
  const staging = mkdtempSync(join(bin, ".mise-"));
  const temporary = join(staging, "mise");

  try {
    writeFileSync(temporary, bytes, { mode: 0o755, flag: "wx" });

    if (reported("mise", temporary)?.version !== candidate.version) throw new OfficeError(`downloaded mise does not report ${candidate.version}; existing mise preserved`);

    renameSync(temporary, join(bin, "mise"));
  } finally {
    rmSync(temporary, { force: true });
    rmdirSync(staging);
  }
}
