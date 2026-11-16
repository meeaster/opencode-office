// Host-only dependencies. Office's mise state is separate from the user's tool selections.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import * as v from "valibot";

import { fetchBytes } from "./download.ts";
import { OfficeError } from "./office.ts";
import { newestRelease, type Candidate } from "./releases.ts";
import { check } from "./schema.ts";
import { compareVersions } from "./versions.ts";

type Tool = "mise" | "sops" | "age" | "age-keygen" | "gh";

/** The host tools office installs through its own mise. gh is wanted only by offices that use GitHub. */
type MiseTool = "sops" | "age" | "gh";

export type InstalledTool = { path: string; version: string };

type Proposal = { tool: MiseTool; version: string; installed: InstalledTool | undefined };

const backends: Record<MiseTool, string> = { sops: "github:getsops/sops[bin=sops]", age: "github:FiloSottile/age", gh: "github:cli/cli" };

export function hostToolsRoot(): string {
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "office/host-tools");
}

function reported(tool: Tool, path: string): InstalledTool | undefined {
  try {
    const text = execFileSync(path, ["--version"], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
    const version = (tool === "mise" ? /^(\d+\.\d+\.\d+(?:-[\w.-]+)?)/ : /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[\w.-]+)?)/).exec(text)?.[1];

    if (version !== undefined) return { path, version };
  } catch {
    // Missing, non-executable and broken installations are not usable candidates.
  }

  return undefined;
}

/** PATH wins ties; a managed copy wins only if newer (even when PATH is too recent to install). */
export function installedTool(tool: Tool): InstalledTool | undefined {
  const external = reported(tool, tool);
  const managed = reported(tool, join(hostToolsRoot(), "bin", tool));

  if (external === undefined) return managed;

  if (managed === undefined) return external;

  return compareVersions(managed.version, external.version) > 0 ? managed : external;
}

export function hostTool(tool: Tool): string {
  const installed = installedTool(tool);

  if (installed === undefined) throw new OfficeError(`${tool} is missing or cannot report its version; run office setup --install-deps, or install it on the host PATH`);

  return installed.path;
}

export function needsInstall(installed: InstalledTool | undefined, candidate: string): boolean {
  return installed === undefined || compareVersions(installed.version, candidate) < 0;
}

/** Only these four Unix targets are published by office. */
function requireHostPlatform(platform: string, arch: string): void {
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

  if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== digest) {
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

function miseCommand(mise: string, args: string[]): string {
  const root = hostToolsRoot();

  // Running outside the office avoids trusting/loading its mise.toml during host onboarding.
  mkdirSync(root, { recursive: true });

  try {
    return execFileSync(mise, args, {
      cwd: root, encoding: "utf8", timeout: 600_000, stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        MISE_DATA_DIR: join(root, "mise/data"),
        MISE_CONFIG_DIR: join(root, "mise/config"),
        MISE_CACHE_DIR: join(root, "mise/cache"),
        MISE_STATE_DIR: join(root, "mise/state"),
        MISE_GLOBAL_CONFIG_FILE: join(root, "mise/config/config.toml"),
        MISE_NO_AUTO_UPDATE: "1",
        MISE_USE_VERSIONS_HOST: "0",
        MISE_PRERELEASES: "0",
        MISE_YES: "1",
        MISE_NO_CONFIG: "1",
      },
    }).trim();
  } catch {
    throw new OfficeError(`mise ${args[0]} failed for host dependencies. It must support "latest <github:owner/repo> --minimum-release-age 3d" and exact-version install/which. Check network access and rerun office setup --install-deps, or install the tool manually on PATH (command output withheld)`);
  }
}

export function latestHostVersion(mise: string, tool: MiseTool): string {
  const result = check(v.safeParse(
    v.pipe(v.string(), v.regex(/^\d+\.\d+\.\d+$/)),
    miseCommand(mise, ["latest", backends[tool], "--minimum-release-age", "3d"]),
  ));

  if (!result.ok) throw new OfficeError(`mise returned no exact stable version for ${tool} at least three days old`);

  return result.value;
}

export function installHostVersion(mise: string, tool: MiseTool, version: string): void {
  requireHostPlatform(process.platform, process.arch);

  const exact = `${backends[tool]}@${version}`;

  miseCommand(mise, ["install", exact]);

  const commands: Tool[] = tool === "age" ? ["age", "age-keygen"] : [tool];
  const bin = join(hostToolsRoot(), "bin");

  mkdirSync(bin, { recursive: true });

  for (const command of commands) {
    const current = installedTool(command);

    // Repairing a missing age-keygen must not move an existing newer age backwards.
    if (current !== undefined && compareVersions(current.version, version) > 0) continue;

    const path = miseCommand(mise, ["which", command, `--tool=${exact}`]);

    if (reported(command, path)?.version !== version) throw new OfficeError(`installed ${command} does not report ${version}; previous selection preserved`);

    const temporary = join(bin, `.${command}-${process.pid}.new`);

    try {
      symlinkSync(path, temporary);
      renameSync(temporary, join(bin, command));
    } finally {
      rmSync(temporary, { force: true });
    }
  }
}

function describe(tool: string, installed: InstalledTool | undefined, version: string): void {
  console.log(`${tool}: ${installed?.version ?? "missing"} -> ${version}${installed === undefined ? "" : ` (current: ${installed.path})`}`);
}

type OnboardOptions = {
  /** Also install or update gh, for an office whose sources or credentials use GitHub. gh stays optional. */
  gh?: boolean;
  lookupMise?: () => Promise<Candidate | undefined>;
};

/**
 * Permission is scoped to this setup invocation, never a persistent auto-update preference. SOPS
 * and age are required; gh is optional here, and the GitHub step says when an office needs it.
 */
export async function onboardHostTools(
  installDeps: boolean,
  confirm: ((text: string) => Promise<string>) | undefined,
  { gh = false, lookupMise = async () => (await newestRelease("mise", "3d")).chosen }: OnboardOptions = {},
): Promise<void> {
  const tools: MiseTool[] = gh ? ["sops", "age", "gh"] : ["sops", "age"];
  const names = gh ? "SOPS, age and gh" : "SOPS and age";
  const candidate = await lookupMise();

  if (candidate === undefined) throw new OfficeError("no stable mise release at least three days old was found");

  let mise = installedTool("mise");
  const miseNeeded = needsInstall(mise, candidate.version);
  let authorized = installDeps;

  if (miseNeeded) describe("mise", mise, candidate.version);

  // Bootstrap/update mise first: an old copy may not support release-age lookup.
  // This single consent covers the staged SOPS/age (and gh) lookup and installation too.
  if (miseNeeded) {
    console.log(`Office can install verified mise ${candidate.version} (published ${candidate.published}), then resolve and install/update ${names} to exact stable releases at least three days old in ${hostToolsRoot()}. No global selections or shell profiles change.`);

    if (!authorized && confirm !== undefined) authorized = (await confirm("Install these host dependencies? [yes/no]")) === "yes";

    if (!authorized && mise === undefined) {
      if (installedTool("sops") === undefined || installedTool("age") === undefined || installedTool("age-keygen") === undefined) {
        throw new OfficeError("host dependencies are missing; rerun office setup --install-deps to authorize installation, or install mise, SOPS and age manually on PATH");
      }

      console.log(`Keeping installed ${names}; mise installation declined, so update lookup was skipped.`);

      return;
    }

    if (authorized) {
      await installMise(candidate);
      mise = installedTool("mise");
    }
  }

  if (mise === undefined) throw new OfficeError("installed mise is not executable");

  const proposals: Proposal[] = [];

  for (const tool of tools) {
    const version = latestHostVersion(mise.path, tool);
    const installed = installedTool(tool);

    if (needsInstall(installed, version) || (tool === "age" && needsInstall(installedTool("age-keygen"), version))) {
      proposals.push({ tool, version, installed });
    } else {
      console.log(`${tool}: keeping ${installed?.version} (eligible stable: ${version})`);
    }
  }

  for (const proposal of proposals) {
    if (proposal.tool === "age" && !needsInstall(proposal.installed, proposal.version)) {
      describe("age-keygen", installedTool("age-keygen"), proposal.version);
    } else {
      describe(proposal.tool, proposal.installed, proposal.version);
    }
  }

  if (!authorized && !miseNeeded && proposals.length > 0) {
    console.log(`Installs use ${hostToolsRoot()}; system executables, global mise selections and shell profiles are not changed.`);

    if (confirm !== undefined) authorized = (await confirm("Install/update these host dependencies? [yes/no]")) === "yes";
  }

  if (!authorized) {
    if (proposals.some((proposal) => proposal.tool !== "gh" && proposal.installed === undefined) || installedTool("age-keygen") === undefined) {
      throw new OfficeError("required host dependencies are missing; rerun office setup --install-deps or install them manually on PATH");
    }

    if (miseNeeded || proposals.length > 0) console.log("Updates not authorized; continuing with installed tools. No dependency was changed.");

    return;
  }

  for (const proposal of proposals) installHostVersion(mise.path, proposal.tool, proposal.version);
}
