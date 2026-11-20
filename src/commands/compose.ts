// Runs an office's containers: the tool's compose.yaml (executor, opencode), the services packages
// contribute (src/package-services.ts), and the office's own compose.yaml when it has one, as the
// compose project office-<name>. In host mode the opencode
// container stays off (its compose profile isn't enabled), and `office up` prepares what the
// container would otherwise do itself: the office's tools and its cron jobs.
//
// `office up` runs the versions it last applied (the state folder's applied.json) and says what
// office.yaml has moved to since; `office up --upgrade` applies those, after backing up what the
// upgrade migrates. Neither ever runs an older OpenCode or Executor than the office has run.
// `office up --refresh` rebuilds the opencode image with current Debian packages, which a weekly
// systemd timer runs in container mode; every other build reuses the last refresh's packages.
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { cronRevision } from "../../standard/cron/container.ts";
import { requireJobs } from "../../standard/cron/discovery.ts";
import { cronTimers, installTimers, refreshTimer, removeTimers } from "../../standard/cron/host.ts";
import { hasSystemd } from "../systemd.ts";
import { ghConfigDir, ghHosts } from "../github.ts";
import { hostTool } from "../host-tools.ts";
import { notify } from "../notify.ts";
import { CommandFailed, progress, say, streamChecked, warn } from "../report/index.ts";
import { displayLines } from "../report/reporter.ts";
import { executorEnvFile, type Office, OfficeError, readEnvFile } from "../office.ts";
import { hostLayout, hostWrappers } from "../host-env.ts";
import { markServerStopped, planServer, serverIncumbent, startServer } from "../host-server.ts";
import { claim, globalConfD, installSfw, removeUnwantedServer, requireServerConsent, stopRecordedServer, writeServerUnit } from "../machine.ts";
import { machineFiles } from "../package-tools.ts";
import { appliedSpawns, packageComposeFile, preparePackageServices, serviceFiles, serviceSettings, type UpgradedServices } from "../package-services.ts";
import { sweepSpawned } from "../package-spawns.ts";
import { reconcileHostServices } from "../package-host-services.ts";
import type { Lock } from "../schema.ts";
import { prepareSecrets } from "../secrets.ts";
import { placeExecutable, toolPath, unpackedImage } from "../tool.ts";
import { baseImage, changes, compareVersions, defaultPins, describeMove, executorImage, readApplied, wantedPins, writeApplied } from "../versions.ts";
import { connection, deploy } from "./apps.ts";

export function ports() {
  return {
    executor: process.env.EXECUTOR_PORT ?? "41440",
    opencode: process.env.OPENCODE_PORT ?? "41497",
  };
}

/** The opencode container's image: the base image, or the office's own on top of it, named for the versions. */
export function officeImage(office: Office, pins: Lock): string {
  const base = baseImage(pins);

  return existsSync(join(office.dir, "Dockerfile")) ? `office-${office.name}-opencode:${base.slice(base.indexOf(":") + 1)}` : base;
}

/** The pins the containers run: the last applied, else what office.yaml asks for, else the tool's defaults. */
export function runningPins(office: Office): Lock {
  const applied = readApplied(office);

  if (applied !== undefined) return applied.pins;

  try {
    return wantedPins(office);
  } catch {
    return defaultPins;
  }
}

function environment(office: Office, profiles: string, pins: Lock, cronRevision = ""): NodeJS.ProcessEnv {
  return {
    ...process.env,
    ...serviceSettings(office),
    // Default provenance changes cached builds' image IDs, making Compose recreate unchanged services.
    BUILDX_NO_DEFAULT_ATTESTATIONS: process.env.BUILDX_NO_DEFAULT_ATTESTATIONS ?? "1",
    // The opencode service is in the "container" profile.
    COMPOSE_PROFILES: profiles,
    OFFICE_NAME: office.name,
    OFFICE_DIR: office.dir,
    OFFICE_STATE: office.state,
    OFFICE_DESKS: office.desks.map((desk) => desk.name).join(","),
    OFFICE_CRON_REVISION: cronRevision,
    OFFICE_OPENCODE_IMAGE: officeImage(office, pins),
    OFFICE_EXECUTOR_IMAGE: executorImage(pins.executor),
    // OpenCode as the office's containers reach it, such as a dashboard's API.
    OFFICE_OPENCODE_URL: office.opencode.containerUrl,
    // The container's git defaults; empty leaves git's own config.
    OFFICE_GIT_NAME: office.git?.name ?? "",
    OFFICE_GIT_EMAIL: office.git?.email ?? "",
    OFFICE_GH_CONFIG: ghConfigDir(),
    OFFICE_GH_HOSTS: sharesGithubLogin(office) ? ghHosts().join(",") : "",
  };
}

/**
 * Whether the opencode container gets the host's gh login: office.yaml asks for it, and the host
 * has one in a file. Docker would create a missing bind-mount source as root, so none is mounted.
 */
function sharesGithubLogin(office: Office): boolean {
  return office.opencode.mode === "container" && office.git?.credentials === "gh" && existsSync(join(ghConfigDir(), "hosts.yml"));
}

type ComposeOptions = { capture?: boolean; profiles?: string; pins?: Lock; cronRevision?: string };

/**
 * Runs `docker compose` for the office; with `capture`, returns its output instead of printing it.
 * `profiles` defaults to the office's mode: the opencode container only in container mode.
 */
export function compose(office: Office, args: string[], { capture = false, profiles = office.opencode.mode, pins = runningPins(office), cronRevision }: ComposeOptions = {}): string {
  return (
    execFileSync("docker", composeArguments(office, args), {
      env: environment(office, profiles, pins, cronRevision),
      encoding: "utf8",
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    }) ?? ""
  ).trim();
}

/**
 * `docker compose` for the office without blocking, its output to the running stage (Compose's
 * progress goes to a taskLog on a terminal, and is kept back without one unless it fails).
 */
async function composeStreamed(office: Office, args: string[], { profiles = office.opencode.mode, pins = runningPins(office), cronRevision }: Omit<ComposeOptions, "capture"> = {}): Promise<void> {
  await streamChecked("docker", composeArguments(office, args), { env: environment(office, profiles, pins, cronRevision) });
}

/** `docker compose` for the office with the terminal attached; returns the command's exit status. */
export function composeAttached(office: Office, args: string[]): number {
  const result = spawnSync("docker", composeArguments(office, args), { env: environment(office, office.opencode.mode, runningPins(office)), stdio: "inherit" });

  return result.status ?? 1;
}

/** The `docker compose` arguments for the office: its project and files, in the order Compose merges them, then `args`. */
export function composeArguments(office: Office, args: string[]): string[] {
  const files = ["-f", join(unpackedImage(), "compose.yaml")];

  if (sharesGithubLogin(office)) files.push("-f", join(unpackedImage(), "gh-compose.yaml"));

  // After the tool's files, so they can't change executor or opencode, and before the office's
  // own, which can override a package's service.
  for (const file of serviceFiles(office)) files.push("-f", file);

  if (existsSync(join(office.dir, "compose.yaml"))) files.push("-f", join(office.dir, "compose.yaml"));

  return ["compose", "-p", `office-${office.name}`, ...files, ...args];
}

/**
 * Creates the office's state on first run: the OpenCode server password and the container's
 * home. Docker would create a missing bind-mount source as root, so the folders are made here.
 * In host mode the password is the host server's, which only the user can put there.
 */
function prepareState(office: Office): void {
  const secrets = join(office.state, "secrets.env");

  // Compose reads the office's key under its current name; this moves one saved under the old name.
  executorEnvFile(office);

  if (office.opencode.mode === "host") {
    if (readEnvFile(secrets).OPENCODE_PASSWORD === undefined) {
      throw new OfficeError(`host mode needs the password of the OpenCode server at ${office.opencode.url} as OPENCODE_PASSWORD in ${secrets}. For the OpenCode background service:
  mkdir -p ${office.state} && (umask 077; echo "OPENCODE_PASSWORD=$(opencode service get password)" >> ${secrets})`);
    }

    return;
  }

  mkdirSync(join(office.state, "opencode-home/workspace"), { recursive: true });

  if (!existsSync(secrets)) {
    writeFileSync(secrets, `OPENCODE_PASSWORD=${randomBytes(18).toString("base64url")}\n`, { mode: 0o600 });
    say(`created ${secrets}`);
  }
}

// A host OpenCode server doesn't have the container's environment, so the office package's plugin
// reads the office-executor MCP server's address and token from these files. They are written in
// both modes: a host session opened in a container-mode office reaches Executor on its published
// loopback port, while the container's own variables still win there. They are gitignored.
const executorFiles = { url: ".opencode/office-executor.url", token: ".opencode/office-executor.token" };

function writeExecutorFiles(office: Office): void {
  let executor;

  try {
    executor = connection(office);
  } catch {
    say("no Executor token yet, so sessions can't reach the office-executor MCP server; see README.md", "office: ");

    return;
  }

  writeFileSync(join(office.dir, executorFiles.url), `${executor.url}\n`);
  writeFileSync(join(office.dir, executorFiles.token), `${executor.token}\n`, { mode: 0o600 });
}

function removeExecutorFiles(office: Office): void {
  for (const file of Object.values(executorFiles)) rmSync(join(office.dir, file), { force: true });
}

/**
 * The mise that installs the office's tools: the wrapper that runs installs through Socket Firewall
 * when the office wrote it and sfw is installed, else the host's mise.
 */
export function installingMise(office: Office): string {
  const wrapper = join(hostWrappers(), "mise");

  return office.socketFirewall && claim(office).kind === "ours" && existsSync(wrapper) && existsSync(hostLayout("").sfw) ? wrapper : hostTool("mise");
}

/**
 * Runs `mise install` in `dir`, through sfw where it applies, its output to the running stage; as
 * in the container, a failure must not keep the office from starting, so it is a warning with
 * mise's last lines.
 */
async function miseInstall(office: Office, dir: string, trust: string[] = []): Promise<void> {
  progress(`installing tools with mise in ${dir}`);

  try {
    for (const config of trust) await streamChecked(hostTool("mise"), ["trust", "--quiet", config]);

    await streamChecked(installingMise(office), ["install", "--quiet"], { cwd: dir });
  } catch (error) {
    const lines = error instanceof CommandFailed ? displayLines(`${error.result.stdout}\n${error.result.stderr}`).slice(-5) : [String(error)];

    warn(`mise install failed in ${dir}${lines.length > 0 ? `:\n${lines.join("\n")}` : ""}`, `office: mise install failed in ${dir}`);
  }
}

/**
 * Trusts and installs every office mise.toml with the host's mise, then the office's machine-wide
 * tools (machine.packages.toml, the packages' fragments in .office/mise/ and machine.toml), as the container does at
 * start. Those load only through their links in mise's global conf.d, which need no trust, and a
 * mise.toml in the office may pin the same tool at another version, so they install from the
 * filesystem root, where only global config applies; their postinstall hooks run there.
 */
async function installTools(office: Office): Promise<void> {
  for (const dir of [office.dir, ...office.desks.map((desk) => join(office.dir, desk.name))]) {
    const config = join(dir, "mise.toml");

    if (existsSync(config)) await miseInstall(office, dir, [config]);
  }

  if (machineFiles(office).length === 0) return;

  if (claim(office).kind !== "ours") {
    say(`machine.toml and the packages' tools in machine.packages.toml aren't linked into ${globalConfD()}, so they apply nowhere and nothing installs them; run office setup (unattended: office setup --manage-machine), then office sync and office up`, "office: ");

    return;
  }

  await miseInstall(office, "/");
}

/** Runs docker without blocking, its output (such as BuildKit's plain progress) to the running stage. */
async function docker(args: string[]): Promise<void> {
  await streamChecked("docker", args);
}

/**
 * Builds the base image for `pins` with the running `office` inside, and the office's own image on
 * top. `refreshed` keys the base image's apt layer: a new value installs current Debian packages.
 */
async function buildImages(office: Office, pins: Lock, refreshed: string): Promise<void> {
  const context = unpackedImage();
  const hex = (digest: string) => digest.replace(/^sha256:/, "");

  const args = {
    OPENCODE_VERSION: pins.opencode.version,
    OPENCODE_SHA256: hex(pins.opencode.digest),
    CLAUDE_VERSION: pins.claude.version,
    CLAUDE_SHA256: hex(pins.claude.digest),
    CODEX_VERSION: pins.codex.version,
    CODEX_SHA256: hex(pins.codex.digest),
    MISE_VERSION: pins.mise.version,
    MISE_SHA256: hex(pins.mise.digest),
    SFW_VERSION: pins.sfw.version,
    SFW_SHA256: hex(pins.sfw.digest),
    APT_REFRESH: refreshed,
  };

  await placeExecutable(context);
  progress(`building the opencode image ${baseImage(pins)}`);
  await docker(["build", "-t", baseImage(pins), ...Object.entries(args).flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]), context]);

  if (existsSync(join(office.dir, "Dockerfile"))) {
    progress(`building the office's image ${officeImage(office, pins)} from its Dockerfile`);
    await docker(["build", "-t", officeImage(office, pins), "--build-arg", `BASE_IMAGE=${baseImage(pins)}`, office.dir]);
  }
}

/** The Chromium version an image carries, or undefined when the image doesn't exist or has none. */
function chromiumVersion(image: string): string | undefined {
  try {
    // "Chromium 156.0.8078.79 built on Debian GNU/Linux 13 (trixie)"
    return /^Chromium \S+/.exec(execFileSync("docker", ["run", "--rm", "--entrypoint", "chromium", image, "--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))?.[0];
  } catch {
    return undefined;
  }
}

/** Rebuilds the images with current Debian packages and tells the user what Chromium moved to, or why it failed. */
async function refreshImages(office: Office, pins: Lock, refreshed: string): Promise<void> {
  const before = chromiumVersion(officeImage(office, pins));

  try {
    await buildImages(office, pins, refreshed);
  } catch (error) {
    await notify(office, { title: "Image refresh failed", body: `office up --refresh couldn't rebuild the opencode image: ${error instanceof Error ? error.message : String(error)}` });

    throw error;
  }

  const after = chromiumVersion(officeImage(office, pins)) ?? "no Chromium";

  await notify(office, { title: "Image refreshed", body: `The opencode image has current Debian packages and restarts now. ${before === undefined || before === after ? after : `${before} → ${after}`}` });
}

/** Installs the weekly refresh timer, which needs a systemd user manager the machine may lack. */
function installRefreshTimer(office: Office): void {
  if (hasSystemd()) {
    installTimers(office, [refreshTimer(office)]);

    return;
  }

  say("no systemd user manager, so nothing refreshes the opencode image's Debian packages weekly; run office up --refresh yourself", "office: ");
}

/** The Debian image the base image starts from, which also runs the backup of Executor's volume. */
function debianImage(): string {
  const image = /^FROM (debian:\S+)$/m.exec(readFileSync(toolPath("image/Dockerfile"), "utf8"))?.[1];

  if (image === undefined) throw new OfficeError("image/Dockerfile has no FROM debian line");

  return image;
}

function stamp(): string {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** Writes a Docker volume as the tarball `file` in the backups folder `dir`, owned by the user; returns its path. */
async function backUpVolume(dir: string, volume: string, file: string): Promise<string> {
  progress(`backing up the volume ${volume}`);
  await docker(["run", "--rm", "-v", `${volume}:/data:ro`, "-v", `${dir}:/backup`, debianImage(), "sh", "-c", `tar -czf /backup/${file} -C /data . && chown ${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0} /backup/${file}`]);

  return join(dir, file);
}

/** The Docker CLI doesn't distinguish a missing volume from denied access by exit code.
 * Require its exact name before mounting it for backup; never turn lookup failure into a skip. */
function requireBackupVolume(volume: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(volume)) throw new OfficeError("package volume backup requires a resolved Docker volume name");

  const result = spawnSync("docker", ["volume", "inspect", "--format", "{{.Name}}", volume], {
    encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000,
  });

  if (result.status === 0 && !result.error && result.stdout.replace(/\r?\n$/, "") === volume) return;

  const status = result.status === 0 ? "unexpected name" : result.status === null ? "did not complete" : `exit ${result.status}`;

  throw new OfficeError(`docker volume inspect ${volume}: ${status}; upgrade stopped. Verify the old volume and access in the current Docker context before retrying.`);
}

/**
 * Stops the services of each package whose compose file an upgrade replaces and backs up the named
 * volumes its applied file declares. If any cannot be verified, keep the applied definition.
 * Returns where each went.
 */
async function backUpPackages(office: Office, upgraded: UpgradedServices[]): Promise<string[]> {
  const dir = join(office.state, "backups");
  const written: string[] = [];

  for (const item of upgraded) {
    if (item.services.length > 0) await composeStreamed(office, ["stop", ...item.services]);

    for (const volume of item.volumes) {
      requireBackupVolume(volume);

      mkdirSync(dir, { recursive: true });
      written.push(await backUpVolume(dir, volume, `${stamp()}-package-${item.name}-${volume}.tar.gz`));
    }
  }

  return written;
}

/**
 * Backs up what an upgrade migrates, with the containers stopped so the files are consistent:
 * Executor's data volume as a tarball, and OpenCode's database files. Returns where each went.
 */
async function backUp(office: Office, tools: Set<string>, from: Lock): Promise<string[]> {
  const dir = join(office.state, "backups");
  const written: string[] = [];

  mkdirSync(dir, { recursive: true });

  if (tools.has("executor")) {
    await composeStreamed(office, ["stop", "executor"], { pins: from });
    written.push(await backUpVolume(dir, `office-${office.name}_executor-data`, `${stamp()}-executor-${from.executor.version}.tar.gz`));
  }

  const database = join(office.state, "opencode-home/.local/share/opencode");

  if (tools.has("opencode") && existsSync(database)) {
    const target = join(dir, `${stamp()}-opencode-${from.opencode.version}`);

    await composeStreamed(office, ["stop", "opencode"], { pins: from });
    mkdirSync(target);

    for (const file of readdirSync(database).filter((name) => name.startsWith("opencode.db"))) copyFileSync(join(database, file), join(target, file));

    written.push(target);
  }

  return written;
}

/** Refuses an older OpenCode or Executor than the office has run: their data migrates forward only. */
function guardDowngrade(office: Office, pins: Lock): void {
  const highest = readApplied(office)?.highest;

  if (highest === undefined) return;

  for (const tool of ["opencode", "executor"] as const) {
    if (tool === "opencode" && office.opencode.mode === "host") continue;

    if (compareVersions(pins[tool].version, highest[tool]) < 0) {
      throw new OfficeError(`refusing ${tool} ${pins[tool].version}: this office has run ${highest[tool]}, and its data can't go back to an older version. Set ${highest[tool]} or newer in office.yaml and run office pin`);
    }
  }
}

async function waitForExecutor(): Promise<boolean> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const status = await fetch(`http://127.0.0.1:${ports().executor}/health`, { signal: AbortSignal.timeout(5_000) }).then(
      (response) => response.status,
      () => 0,
    );

    if (status === 200) return true;

    await Bun.sleep(2_000);
  }

  return false;
}

/**
 * Chooses the versions to run. Without `upgrade`: the last applied, saying what is pending. With
 * it, or on an office's first run: what office.yaml asks for.
 */
function choosePins(office: Office, upgrade: boolean) {
  const applied = readApplied(office);

  if (applied === undefined) return { pins: wantedPins(office), moved: [] };

  if (!upgrade) {
    try {
      const pending = changes(office, applied.pins, wantedPins(office));

      if (pending.length > 0) say(`running the applied versions; office up --upgrade applies ${pending.map((move) => describeMove(office, move)).join(", ")}`, "office: ");
    } catch (error) {
      say(`running the applied versions; ${error instanceof Error ? error.message : String(error)}`, "office: ");
    }

    return { pins: applied.pins, moved: [] };
  }

  const pins = wantedPins(office);

  return { pins, moved: changes(office, applied.pins, pins) };
}

/** Starts the office's services; returns a one-line summary of what runs. */
export async function up(office: Office, { upgrade = false, refresh = false } = {}): Promise<string> {
  const managed = office.opencode.managed !== undefined;
  const jobs = requireJobs(office);
  const timers = office.opencode.mode === "host" ? cronTimers(office, jobs) : [];

  if (managed) requireServerConsent(office);

  progress("checking secrets, state and versions");
  prepareSecrets(office);
  prepareState(office);

  if (managed) {
    planServer(office);
    await serverIncumbent(office, upgrade);
  }

  removeUnwantedServer(office);

  const { pins, moved } = choosePins(office, upgrade);
  const applied = readApplied(office);
  const from = applied?.pins;
  // A build with no refresh recorded yet takes current packages and records them as of now.
  const refreshed = refresh || applied?.refreshed === undefined ? new Date().toISOString() : applied.refreshed;

  guardDowngrade(office, pins);

  const services = preparePackageServices(office, upgrade);

  if (upgrade) {
    const what = [...moved.map((move) => `${move.tool} ${move.from} → ${move.to}`), ...services.upgraded.map((item) => `package ${item.name}'s ${packageComposeFile}`)];

    say(what.length === 0 ? "nothing to upgrade" : `upgrading ${what.join(", ")}`, "office: ");

    if (moved.length > 0 && from !== undefined) {
      for (const path of await backUp(office, new Set(moved.map((move) => move.tool)), from)) say(`backed up to ${path}`, "office: ");
    }

    for (const path of await backUpPackages(office, services.upgraded)) say(`backed up to ${path}`, "office: ");
  }

  // What the services of a package that stops created themselves goes with them, as on office down.
  const finishSweep = sweepSpawned(services.apply(), "removing what stopped packages' services created");

  if (office.opencode.mode === "host") {
    // An opencode container left from container mode would answer on the old port.
    progress("starting the containers");
    await composeStreamed(office, ["rm", "--stop", "--force", "opencode"], { profiles: "container", pins });
    await composeStreamed(office, ["up", "-d", "--build", "--remove-orphans"], { pins });
    finishSweep();
    writeExecutorFiles(office);

    // Before the tools, so their installs go through it.
    progress("installing Socket Firewall");

    for (const line of await installSfw(office, pins.sfw)) say(line);

    await installTools(office);

    if (refresh) say("host mode has no opencode image to refresh", "office: ");
  } else {
    if (office.git?.credentials === "gh" && !sharesGithubLogin(office)) {
      say(`office.yaml shares the host's gh login, but ${join(ghConfigDir(), "hosts.yml")} doesn't exist, so the container gets none. Log in with office setup, or gh auth login --git-protocol https --web --insecure-storage`, "office: ");
    }

    if (refresh) await refreshImages(office, pins, refreshed);
    else await buildImages(office, pins, refreshed);

    // Installing only the refresh timer removes cron timers left from host mode, which would run
    // the jobs twice.
    installRefreshTimer(office);
    // A changed schedule or enabled set needs a new container even when its image is unchanged.
    progress("starting the containers");
    await composeStreamed(office, ["up", "-d", "--build", "--remove-orphans"], { pins, cronRevision: cronRevision(jobs) });
    finishSweep();
    writeExecutorFiles(office);
  }

  reconcileHostServices(office, upgrade ? "upgrade" : "up");
  writeApplied(office, pins, office.opencode.mode === "container" ? refreshed : applied?.refreshed);

  // A new Executor serves a new apps framework; every app must match it.
  if (moved.some((move) => move.tool === "executor")) {
    progress("waiting for the upgraded Executor, to deploy the apps");

    if (!(await waitForExecutor())) throw new OfficeError("Executor didn't become ready; run office apps deploy once it is");

    let ready = false;

    try {
      connection(office);
      ready = true;
    } catch {
      say("Executor was upgraded; run office apps deploy once it has a token, so the apps match its framework", "office: ");
    }

    if (ready) await deploy(office);
  }

  if (managed) {
    progress("starting the managed OpenCode server");

    // Tools installed above can change the resolved path of the office's gh or SOPS.
    const plan = planServer(office);

    const changed = writeServerUnit(office, plan);

    await startServer(office, plan, upgrade, changed);
  }

  if (office.opencode.mode === "host") installTimers(office, timers);

  const packaged = serviceFiles(office).length;
  const executor = `Executor${packaged > 0 ? ` and the services of ${packaged} ${packaged === 1 ? "package" : "packages"}` : ""}`;

  if (office.opencode.mode === "container") return `${executor} and OpenCode running in containers`;

  return `${executor} running; OpenCode ${managed ? "served by this machine's managed service" : `at ${office.opencode.url}, which office doesn't manage`}`;
}

/** Setup starts only Executor until its local token exists; OpenCode then starts once. */
export async function startExecutor(office: Office): Promise<void> {
  prepareSecrets(office, { allowMissingOwner: true });
  prepareState(office);

  const { pins } = choosePins(office, false);

  guardDowngrade(office, pins);
  progress("starting Executor");
  await composeStreamed(office, ["up", "-d", "executor"], { pins });
  progress("waiting for Executor to answer");

  if (!(await waitForExecutor())) throw new OfficeError("Executor didn't become ready; fix its startup and rerun office setup");
}

/**
 * Stops the office's containers, whichever mode started them, and its timers. What packages'
 * services created themselves (their spawns labels) goes too: its containers first, since one
 * attached to the office's network keeps Compose from removing it, then its networks.
 */
export function down(office: Office): void {
  reconcileHostServices(office, "down");
  markServerStopped(office);
  removeTimers(office);
  stopRecordedServer(office);

  const finishSweep = sweepSpawned([...appliedSpawns(office).values()], "removing what packages' services created");

  try {
    compose(office, ["down"], { profiles: "container" });
  } finally {
    finishSweep();
  }

  removeExecutorFiles(office);
}
