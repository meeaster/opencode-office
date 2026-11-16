// Runs an office's containers: the tool's compose.yaml (executor, opencode) plus the office's own
// compose.yaml when it has one, as the compose project office-<name>. In host mode the opencode
// container stays off (its compose profile isn't enabled), and `office up` prepares what the
// container would otherwise do itself: the office's tools and its cron jobs.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { installTimers, removeTimers } from "../cron/host.ts";
import { type Office, OfficeError, readEnvFile } from "../office.ts";
import { placeExecutable, toolPath, unpackedImage } from "../tool.ts";
import { connection } from "./apps.ts";

const opencodeVersion = /^ARG OPENCODE_VERSION=(\S+)$/m.exec(readFileSync(toolPath("image/Dockerfile"), "utf8"))?.[1];

/** The base image every office's opencode container starts from, tagged with its OpenCode version. */
export const baseImage = `office-opencode:${opencodeVersion}`;

export function ports() {
  return {
    executor: process.env.EXECUTOR_PORT ?? "41440",
    opencode: process.env.OPENCODE_PORT ?? "41497",
  };
}

function officeImage(office: Office): string {
  return existsSync(join(office.dir, "Dockerfile")) ? `office-${office.name}-opencode:latest` : baseImage;
}

function environment(office: Office, profiles: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // The opencode service is in the "container" profile.
    COMPOSE_PROFILES: profiles,
    OFFICE_NAME: office.name,
    OFFICE_DIR: office.dir,
    OFFICE_STATE: office.state,
    OFFICE_DESKS: office.desks.map((desk) => desk.name).join(","),
    OFFICE_OPENCODE_IMAGE: officeImage(office),
    // OpenCode as the office's containers reach it, such as a dashboard's API.
    OFFICE_OPENCODE_URL: office.opencode.containerUrl,
  };
}

/**
 * Runs `docker compose` for the office; with `capture`, returns its output instead of printing it.
 * `profiles` defaults to the office's mode: the opencode container only in container mode.
 */
export function compose(office: Office, args: string[], { capture = false, profiles = office.opencode.mode }: { capture?: boolean; profiles?: string } = {}): string {
  const files = ["-f", join(unpackedImage(), "compose.yaml")];

  if (existsSync(join(office.dir, "compose.yaml"))) files.push("-f", join(office.dir, "compose.yaml"));

  return (
    execFileSync("docker", ["compose", "-p", `office-${office.name}`, ...files, ...args], {
      env: environment(office, profiles),
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

function build(args: string[]): void {
  execFileSync("docker", ["build", ...args], { stdio: "inherit" });
}

export async function up(office: Office): Promise<void> {
  prepareState(office);

  if (office.opencode.mode === "host") {
    // An opencode container left from container mode would answer on the old port.
    compose(office, ["rm", "--stop", "--force", "opencode"], { profiles: "container" });
    compose(office, ["up", "-d", "--build", "--remove-orphans"]);
    writeExecutorFiles(office);
    installTools(office);
    installTimers(office);

    return;
  }

  // The image runs the same `office` as the host: this executable, copied into the build context.
  const context = unpackedImage();

  await placeExecutable(context);
  build(["-t", baseImage, context]);

  if (existsSync(join(office.dir, "Dockerfile"))) {
    build(["-t", officeImage(office), "--build-arg", `BASE_IMAGE=${baseImage}`, office.dir]);
  }

  // Timers and files left from host mode would run the jobs twice and expose a stale token.
  removeTimers(office);
  removeExecutorFiles(office);
  compose(office, ["up", "-d", "--build", "--remove-orphans"]);
}

/** Stops the office's containers, whichever mode started them, and in host mode its timers. */
export function down(office: Office): void {
  compose(office, ["down"], { profiles: "container" });
  removeTimers(office);
  removeExecutorFiles(office);
}
