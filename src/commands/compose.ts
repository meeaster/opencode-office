// Runs an office's containers: the tool's compose.yaml (executor, opencode) plus the office's own
// compose.yaml when it has one, as the compose project office-<name>. In host mode the opencode
// container stays off (its compose profile isn't enabled), and `office up` prepares what the
// container would otherwise do itself: the office's tools and its cron jobs.
//
// `office up` runs the versions it last applied (the state folder's applied.json) and says what
// office.yaml has moved to since; `office up --upgrade` applies those, after backing up what the
// upgrade migrates. Neither ever runs an older OpenCode or Executor than the office has run.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { installTimers, removeTimers } from "../cron/host.ts";
import { type Office, OfficeError, readEnvFile } from "../office.ts";
import type { Lock } from "../schema.ts";
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

function environment(office: Office, profiles: string, pins: Lock): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // The opencode service is in the "container" profile.
    COMPOSE_PROFILES: profiles,
    OFFICE_NAME: office.name,
    OFFICE_DIR: office.dir,
    OFFICE_STATE: office.state,
    OFFICE_DESKS: office.desks.map((desk) => desk.name).join(","),
    OFFICE_OPENCODE_IMAGE: officeImage(office, pins),
    OFFICE_EXECUTOR_IMAGE: executorImage(pins.executor),
    // OpenCode as the office's containers reach it, such as a dashboard's API.
    OFFICE_OPENCODE_URL: office.opencode.containerUrl,
  };
}

type ComposeOptions = { capture?: boolean; profiles?: string; pins?: Lock };

/**
 * Runs `docker compose` for the office; with `capture`, returns its output instead of printing it.
 * `profiles` defaults to the office's mode: the opencode container only in container mode.
 */
export function compose(office: Office, args: string[], { capture = false, profiles = office.opencode.mode, pins = runningPins(office) }: ComposeOptions = {}): string {
  const files = ["-f", join(unpackedImage(), "compose.yaml")];

  if (existsSync(join(office.dir, "compose.yaml"))) files.push("-f", join(office.dir, "compose.yaml"));

  return (
    execFileSync("docker", ["compose", "-p", `office-${office.name}`, ...files, ...args], {
      env: environment(office, profiles, pins),
      encoding: "utf8",
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    }) ?? ""
  ).trim();
}

/**
 * Creates the office's state on first run: the OpenCode server password and the container's
 * home. Docker would create a missing bind-mount source as root, so the folders are made here.
 * In host mode the password is the host server's, which only the user can put there.
 */
function prepareState(office: Office): void {
  const secrets = join(office.state, "secrets.env");

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
    console.log(`created ${secrets}`);
  }
}

// The host server reads the office's .opencode/opencode.jsonc but not the container's environment,
// so the office-executor MCP server's address and token come from these files, which the config
// substitutes with {file:...}. They are gitignored and exist only in host mode.
const executorFiles = { url: ".opencode/office-executor.url", token: ".opencode/office-executor.token" };

function writeExecutorFiles(office: Office): void {
  let executor;

  try {
    executor = connection(office);
  } catch {
    console.log("office: no Executor token yet, so sessions can't reach the office-executor MCP server; see README.md");

    return;
  }

  writeFileSync(join(office.dir, executorFiles.url), `${executor.url}\n`);
  writeFileSync(join(office.dir, executorFiles.token), `${executor.token}\n`, { mode: 0o600 });
}

function removeExecutorFiles(office: Office): void {
  for (const file of Object.values(executorFiles)) rmSync(join(office.dir, file), { force: true });
}

/** Trusts and installs every office mise.toml with the host's mise, as the container does at start. */
function installTools(office: Office): void {
  for (const dir of [office.dir, ...office.desks.map((desk) => join(office.dir, desk.name))]) {
    if (!existsSync(join(dir, "mise.toml"))) continue;

    try {
      execFileSync("mise", ["trust", "--quiet", join(dir, "mise.toml")], { stdio: "inherit" });
      execFileSync("mise", ["install", "--quiet"], { cwd: dir, stdio: "inherit" });
    } catch {
      // As in the container, a failed install must not keep the office from starting.
      console.error(`office: mise install failed in ${dir}`);
    }
  }
}

function docker(args: string[]): void {
  execFileSync("docker", args, { stdio: "inherit" });
}

/** Builds the base image for `pins` with the running `office` inside, and the office's own image on top. */
async function buildImages(office: Office, pins: Lock): Promise<void> {
  const context = unpackedImage();
  const hex = (digest: string) => digest.replace(/^sha256:/, "");

  const args = {
    OPENCODE_VERSION: pins.opencode.version,
    OPENCODE_SHA256: hex(pins.opencode.digest),
    CLAUDE_VERSION: pins.claude.version,
    CLAUDE_SHA256: hex(pins.claude.digest),
    MISE_VERSION: pins.mise.version,
    MISE_SHA256: hex(pins.mise.digest),
  };

  await placeExecutable(context);
  docker(["build", "-t", baseImage(pins), ...Object.entries(args).flatMap(([key, value]) => ["--build-arg", `${key}=${value}`]), context]);

  if (existsSync(join(office.dir, "Dockerfile"))) {
    docker(["build", "-t", officeImage(office, pins), "--build-arg", `BASE_IMAGE=${baseImage(pins)}`, office.dir]);
  }
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

/**
 * Backs up what an upgrade migrates, with the containers stopped so the files are consistent:
 * Executor's data volume as a tarball, and OpenCode's database files. Returns where each went.
 */
function backUp(office: Office, tools: Set<string>, from: Lock): string[] {
  const dir = join(office.state, "backups");
  const written: string[] = [];

  mkdirSync(dir, { recursive: true });

  if (tools.has("executor")) {
    const volume = `office-${office.name}_executor-data`;
    const file = `${stamp()}-executor-${from.executor.version}.tar.gz`;

    compose(office, ["stop", "executor"], { pins: from });
    docker(["run", "--rm", "-v", `${volume}:/data:ro`, "-v", `${dir}:/backup`, debianImage(), "sh", "-c", `tar -czf /backup/${file} -C /data . && chown ${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0} /backup/${file}`]);
    written.push(join(dir, file));
  }

  const database = join(office.state, "opencode-home/.local/share/opencode");

  if (tools.has("opencode") && existsSync(database)) {
    const target = join(dir, `${stamp()}-opencode-${from.opencode.version}`);

    compose(office, ["stop", "opencode"], { pins: from });
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

      if (pending.length > 0) console.log(`office: running the applied versions; office up --upgrade applies ${pending.map((move) => describeMove(office, move)).join(", ")}`);
    } catch (error) {
      console.log(`office: running the applied versions; ${error instanceof Error ? error.message : String(error)}`);
    }

    return { pins: applied.pins, moved: [] };
  }

  const pins = wantedPins(office);

  return { pins, moved: changes(office, applied.pins, pins) };
}

export async function up(office: Office, { upgrade = false } = {}): Promise<void> {
  prepareState(office);

  const { pins, moved } = choosePins(office, upgrade);
  const from = readApplied(office)?.pins;

  guardDowngrade(office, pins);

  if (upgrade) {
    console.log(moved.length === 0 ? "office: nothing to upgrade" : `office: upgrading ${moved.map((move) => `${move.tool} ${move.from} → ${move.to}`).join(", ")}`);

    if (moved.length > 0 && from !== undefined) {
      for (const path of backUp(office, new Set(moved.map((move) => move.tool)), from)) console.log(`office: backed up to ${path}`);
    }
  }

  if (office.opencode.mode === "host") {
    // An opencode container left from container mode would answer on the old port.
    compose(office, ["rm", "--stop", "--force", "opencode"], { profiles: "container", pins });
    compose(office, ["up", "-d", "--build", "--remove-orphans"], { pins });
    writeExecutorFiles(office);
    installTools(office);
    installTimers(office);
  } else {
    await buildImages(office, pins);

    // Timers and files left from host mode would run the jobs twice and expose a stale token.
    removeTimers(office);
    removeExecutorFiles(office);
    compose(office, ["up", "-d", "--build", "--remove-orphans"], { pins });
  }

  writeApplied(office, pins);

  // A new Executor serves a new apps framework; every app must match it.
  if (moved.some((move) => move.tool === "executor")) {
    if (!(await waitForExecutor())) throw new OfficeError("Executor didn't become ready; run office apps deploy once it is");

    try {
      connection(office);
    } catch {
      console.log("office: Executor was upgraded; run office apps deploy once it has a token, so the apps match its framework");

      return;
    }

    await deploy(office);
  }
}

/** Stops the office's containers, whichever mode started them, and in host mode its timers. */
export function down(office: Office): void {
  compose(office, ["down"], { profiles: "container" });
  removeTimers(office);
  removeExecutorFiles(office);
}
