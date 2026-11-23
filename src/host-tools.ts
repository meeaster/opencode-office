// The programs the office CLI runs on the host. A tool the CLI itself calls belongs to the CLI:
//
// - mise, which installs everything else, is the one program it keeps privately, in host-tools, off
//   PATH, at the newest stable release three days old: it is needed before any office exists.
// - SOPS, age (with age-keygen), gh and pre-commit are the required `office` package's tools, in
//   every office's `machine.packages.toml` like any package's, at versions the office owns
//   (`office upgrade-tools` bumps them). The CLI runs the version that file pins, as mise installed
//   it, found through `mise which --tool`: no shims, PATH, link or consent needed, so it works from
//   cron, systemd timers and CI, in either mode, before office sync has linked anything. Until that
//   version is installed, the newest copy found serves: one mise installed, or one on PATH.
//
// `office setup` installs the pinned versions with mise into mise's own install folder (through
// Socket Firewall where it applies), the same installs a host-mode office's links then select, so
// the machine holds one copy of each. It keeps one more thing in host-tools: `bin/gh`, a link to
// that gh, the stable path git's credential helper names, since the install's own path changes
// with every version.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import * as v from "valibot";

import { fetchBytes } from "./download.ts";
import { toolPins } from "./mise-toml.ts";
import { type Office, OfficeError } from "./office.ts";
import { floors } from "../packages/office/floors.ts";
import { packagesFile, packagesPath } from "./package-tools.ts";
import { newestRelease, type Candidate } from "./releases.ts";
import { check } from "./schema.ts";
import { compareVersions } from "./versions.ts";
import { currentReporter, progress, say, stream, warn } from "./report/index.ts";
import { displayLines } from "./report/reporter.ts";

/** A command the office CLI runs that comes from the office package's tools. */
export type OfficeCommand = "sops" | "age" | "age-keygen" | "gh" | "pre-commit";

type Tool = "mise" | OfficeCommand;

export type InstalledTool = { path: string; version: string };

/** The office package's tool each command comes from, by its key in `machine.packages.toml`. */
const packageTool = { sops: "sops", age: "age", "age-keygen": "age", gh: "gh", "pre-commit": "pre-commit" } satisfies Record<OfficeCommand, string>;

/** The commands of each of the office package's tools. */
function commandsOf(tool: string): OfficeCommand[] {
  return tool === "age" ? ["age", "age-keygen"] : tool === "sops" || tool === "gh" || tool === "pre-commit" ? [tool] : [];
}

/** What the office's secrets need before anything else; gh and pre-commit only serve what uses them. */
export const required: OfficeCommand[] = ["sops", "age", "age-keygen"];

/** Every command the CLI runs from the office package's tools. */
export const officeCommands: OfficeCommand[] = ["sops", "age", "age-keygen", "gh", "pre-commit"];

/** The repository each of the office package's tools is built from, which other mise backends name it by. */
const repositories = { sops: "getsops/sops", age: "filosottile/age", gh: "cli/cli", "pre-commit": "pre-commit/pre-commit" } satisfies Record<string, string>;

/**
 * Which of the office package's tools a mise.toml key names, or undefined: its registry name, or a
 * backend for the same repository (`aqua:cli/cli`, `github:getsops/sops[bin=sops]`, `pypi:pre-commit`).
 */
export function officeToolNamed(key: string): string | undefined {
  const name = key.replace(/\[.*\]$/, "").toLowerCase();

  return Object.entries(repositories).find(([tool, repository]) => name === tool || name === `pypi:${tool}` || name === repository || name.endsWith(`:${repository}`))?.[0];
}

export function hostToolsRoot(): string {
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "office/host-tools");
}

/** The stable link to the office's gh that git's credential helper names. */
export function ghLink(): string {
  return join(hostToolsRoot(), "bin/gh");
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

/** The newest of the mise on PATH and the private one in host-tools; PATH wins ties. */
export function installedTool(tool: "mise"): InstalledTool | undefined {
  const external = reported(tool, tool);
  const managed = reported(tool, join(hostToolsRoot(), "bin", tool));

  if (external === undefined) return managed;

  if (managed === undefined) return external;

  return compareVersions(managed.version, external.version) > 0 ? managed : external;
}

/** mise, on PATH or the private copy: the one program office installs for itself. */
export function hostTool(tool: "mise"): string {
  const installed = installedTool(tool);

  if (installed === undefined) throw new OfficeError(`${tool} is missing or cannot report its version; run office setup --install-deps, or install it on the host PATH`);

  return installed.path;
}

/**
 * Runs mise outside any office and without its config files: `which --tool` and `ls` read only its
 * installs, which no config selects, and `install` of exact versions selects nothing.
 */
/** mise without any config, answering yes and never updating itself. */
function miseEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, MISE_NO_CONFIG: "1", MISE_YES: "1", MISE_NO_AUTO_UPDATE: "1" };
}

function runMise(mise: string, args: string[]): string {
  return execFileSync(mise, args, { cwd: "/", encoding: "utf8", timeout: 600_000, stdio: ["ignore", "pipe", "pipe"], env: miseEnvironment() }).trim();
}

/** Where mise installed `command` of `tool` at `version`, or undefined when that version isn't installed. */
function misePath(mise: string, command: OfficeCommand, version: string): string | undefined {
  try {
    return runMise(mise, ["which", command, `--tool=${packageTool[command]}@${version}`]);
  } catch {
    return undefined;
  }
}

/** `command` from mise's install of `tool` at `version`, or undefined when that version isn't installed or doesn't run. */
function miseCopy(mise: string, command: OfficeCommand, version: string): InstalledTool | undefined {
  const path = misePath(mise, command, version);
  const found = path === undefined ? undefined : reported(command, path);

  return found?.version === version ? found : undefined;
}

const installsSchema = v.array(v.object({ version: v.string(), installed: v.optional(v.boolean()) }));

/** The newest version of `tool` mise has installed, whichever config selects it or none. */
function newestMiseInstall(mise: string, command: OfficeCommand): InstalledTool | undefined {
  let versions;

  try {
    versions = check(v.safeParse(installsSchema, JSON.parse(runMise(mise, ["ls", "--installed", "--json", packageTool[command]]))));
  } catch {
    return undefined;
  }

  if (!versions.ok) return undefined;

  const newest = versions.value.filter((entry) => entry.installed !== false && /^\d+\.\d+\.\d+$/.test(entry.version)).map((entry) => entry.version).sort(compareVersions).at(-1);

  return newest === undefined ? undefined : miseCopy(mise, command, newest);
}

/** The versions `machine.packages.toml` pins for the office package's tools: the office's own choice. */
export function officePins(office: Office): Record<string, string> {
  const path = packagesPath(office);
  const tools = Object.keys(startingVersions());

  return !existsSync(path) ? {} : Object.fromEntries(toolPins(readFileSync(path, "utf8")).filter((pin) => tools.includes(pin.tool)).map((pin) => [pin.tool, pin.version]));
}

/** Embedded floors work even when installed packages cannot load. */
export function startingVersions() {
  return { ...floors };
}

/** What the office wants installed: its versions in machine.packages.toml, and the package's starting ones until sync writes them. */
function wantedVersions(office: Office) {
  return { ...startingVersions(), ...officePins(office) };
}

/** Where the CLI found an office command, the version the office pins, and whether this is mise's install of that version. */
export type OfficeTool = InstalledTool & { pinned: string | undefined; managed: boolean };

/**
 * A command of the office package's tools: the version `machine.packages.toml` pins, as mise
 * installed it, else the newest copy mise installed or on PATH.
 */
export function officeTool(office: Office, command: OfficeCommand): OfficeTool | undefined {
  const pinned = officePins(office)[packageTool[command]];
  const mise = installedTool("mise")?.path;
  const exact = mise === undefined || pinned === undefined ? undefined : miseCopy(mise, command, pinned);

  if (exact !== undefined) return { ...exact, pinned, managed: true };

  const found = [mise === undefined ? undefined : newestMiseInstall(mise, command), reported(command, command)]
    .filter((candidate) => candidate !== undefined)
    .sort((left, right) => compareVersions(left.version, right.version))
    .at(-1);

  return found === undefined ? undefined : { ...found, pinned, managed: false };
}

/** The path of an office command, or an error saying how to install it. */
export function requireOfficeTool(office: Office, command: OfficeCommand): string {
  const found = officeTool(office, command);

  if (found === undefined) throw new OfficeError(`${command} isn't installed on this host: office setup --install-deps installs the version the office pins in ${packagesFile}${office.opencode.mode === "host" ? " (as does office up once office sync has linked it)" : ""}, or install it on PATH`);

  return found.path;
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

/** Points `link` at `target`, replacing what was there in one rename. */
function relink(link: string, target: string): void {
  const temporary = `${link}.${process.pid}.new`;

  mkdirSync(join(link, ".."), { recursive: true });

  try {
    symlinkSync(target, temporary);
    renameSync(temporary, link);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Where `path` leads, or undefined for a dangling link or nothing. */
function resolved(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** Points `bin/gh` in host-tools at the office's gh, so git's credential helper keeps one path across versions. */
function linkGh(installed: Map<OfficeCommand, InstalledTool>): string[] {
  const gh = installed.get("gh");

  if (gh === undefined || resolved(ghLink()) === resolved(gh.path)) return [];

  relink(ghLink(), gh.path);

  return [`gh: ${ghLink()} now links to gh ${gh.version}, the office's, so git's credential helper keeps one path across versions`];
}

function describe(tool: string, installed: InstalledTool | undefined, version: string): void {
  say(`${tool}: ${installed?.version ?? "missing"} -> ${version}${installed === undefined ? "" : ` (current: ${installed.path})`}`);
}

type OnboardOptions = {
  /** The mise that installs the office's tools: the Socket Firewall wrapper where it applies, else mise itself. */
  installer?: () => string;
  lookupMise?: () => Promise<Candidate | undefined>;
};

/** A tool of the office package that isn't installed at the office's version. */
type Proposal = { tool: string; version: string; current: InstalledTool | undefined };

/**
 * `office setup`'s dependencies: mise, privately, then the office package's tools at the versions
 * the office pins, installed by mise into its own install folder. Permission is scoped to this
 * setup invocation, never a persistent auto-update preference: `--install-deps` or one yes covers
 * all of it. SOPS and age are required; gh and pre-commit serve only what uses them.
 */
export async function onboardHostTools(
  office: Office,
  installDeps: boolean,
  confirm: ((text: string) => Promise<string>) | undefined,
  { installer = () => hostTool("mise"), lookupMise = async () => (await newestRelease("mise", "3d")).chosen }: OnboardOptions = {},
): Promise<void> {
  const wanted = wantedVersions(office);
  const names = Object.entries(wanted).map(([tool, version]) => `${tool} ${version}`).join(", ");
  const candidate = await lookupMise();

  if (candidate === undefined) throw new OfficeError("no stable mise release at least three days old was found");

  let mise = installedTool("mise");
  const miseNeeded = needsInstall(mise, candidate.version);
  let authorized = installDeps;

  // Bootstrap/update mise first: the office's tools install through it. One consent covers both.
  if (miseNeeded) {
    describe("mise", mise, candidate.version);
    say(`Office can install verified mise ${candidate.version} (published ${candidate.published}) in ${hostToolsRoot()}, then the tools this office pins in ${packagesFile} (${names}) with it, into mise's own install folder. No mise config, global selection or shell profile changes.`);

    if (!authorized && confirm !== undefined) authorized = (await confirm("Install these host dependencies? [yes/no]")) === "yes";

    if (authorized) {
      progress(`installing mise ${candidate.version}`);
      await installMise(candidate);
      mise = installedTool("mise");
    }
  }

  const proposals: Proposal[] = [];

  for (const [tool, version] of Object.entries(wanted)) {
    const commands = commandsOf(tool);
    const present = mise !== undefined && commands.every((command) => miseCopy(mise.path, command, version) !== undefined);

    if (present) continue;

    const current = commands[0] === undefined ? undefined : officeTool(office, commands[0]);

    proposals.push({ tool, version, current });
  }

  if (proposals.length > 0 && !miseNeeded) {
    for (const proposal of proposals) describe(proposal.tool, proposal.current, proposal.version);

    if (!authorized) {
      say(`mise (${mise?.path ?? "missing"}) installs them into its own install folder; no mise config, global selection or shell profile changes.`);

      if (confirm !== undefined) authorized = (await confirm("Install the office's tools? [yes/no]")) === "yes";
    }
  }

  if (mise === undefined || (proposals.length > 0 && !authorized)) {
    const missing = required.filter((command) => officeTool(office, command) === undefined);

    if (missing.length > 0) throw new OfficeError(`required host dependencies (${missing.join(", ")}) are missing; rerun office setup --install-deps, or install them manually on PATH`);

    say("Installation not authorized; continuing with the installed tools. Nothing was changed.");

    return;
  }

  if (miseNeeded && !authorized) say(`Keeping mise ${mise.version}; its update wasn't authorized.`);

  // mise's last lines when it failed, for a reporter to show with the warning.
  let said: string[] = [];

  if (proposals.length > 0) {
    requireHostPlatform(process.platform, process.arch);

    progress(`installing ${proposals.map((proposal) => `${proposal.tool} ${proposal.version}`).join(", ")} with mise`);

    // Checked command by command below; a required one missing fails setup.
    const result = await stream(installer(), ["install", ...proposals.map((proposal) => `${proposal.tool}@${proposal.version}`)], { cwd: "/", timeout: 600_000, env: miseEnvironment() });

    if (result.status !== 0) said = displayLines(`${result.stdout}\n${result.stderr}`).slice(-5);
  }

  const installed = new Map<OfficeCommand, InstalledTool>();
  const failed: string[] = [];
  // Installed by mise, but `--version` doesn't run, such as pre-commit without Python 3.
  const broken: string[] = [];

  for (const [tool, version] of Object.entries(wanted)) {
    for (const command of commandsOf(tool)) {
      const found = miseCopy(mise.path, command, version);

      if (found !== undefined) installed.set(command, found);
      else if (misePath(mise.path, command, version) !== undefined) broken.push(command === "pre-commit" ? `${command} ${version} (it needs Python 3)` : `${command} ${version}`);
      else failed.push(`${command} ${version}`);
    }
  }

  for (const line of linkGh(installed)) say(line);

  if (failed.length === 0 && broken.length === 0) {
    say(`The office's tools: ${names}, installed by mise`);

    return;
  }

  const missing = required.filter((command) => !installed.has(command) && officeTool(office, command) === undefined);

  const message = [
    failed.length > 0 ? `mise didn't install ${failed.join(", ")}; check network access and rerun office setup --install-deps` : "",
    broken.length > 0 ? `mise installed ${broken.join(", ")}, but it doesn't run on this host (\`--version\` fails); install what it needs and rerun office setup` : "",
  ].filter(Boolean).join(". ");

  // A reporter keeps mise's output with the stage, shown if it fails; the console gets none of it.
  const withheld = failed.length > 0 ? `${message} (mise's output withheld)` : message;

  if (missing.length > 0) throw new OfficeError(currentReporter() === undefined ? withheld : message);

  warn(said.length > 0 && currentReporter() !== undefined ? `${message}. mise said:\n${said.join("\n")}` : message, `Warning: ${withheld}`);
}
