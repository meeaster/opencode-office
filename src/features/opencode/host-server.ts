// The opt-in local OpenCode background service. OpenCode still owns service.json and its password.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import * as v from "valibot";

import { hasSystemd, unitDirVariable } from "../systemd/systemd.ts";
import { envFilePath, miseShims, opencodeBin } from "../host/host-env.ts";
import { officeTool, requireOfficeTool } from "../host/host-tools.ts";
import { type Office, OfficeError, readEnvFile } from "../../office.ts";
import { check, type Parsed, version as releaseVersion } from "../../schema.ts";
import { requireHostIdentity, source, validateServerSecrets } from "../secrets/secrets.ts";
import { shellQuote } from "../host/sfw.ts";
import { compareVersions } from "../../versions.ts";
import { say } from "../../report/index.ts";

const legacyUnit = "opencode-serve.service";
const revisionVariable = "OFFICE_SERVER_REVISION";

export function serverUnit(office: Office): string {
  return `office-${office.name}-opencode.service`;
}

export function serverUnitPath(office: Office): string {
  return resolve(process.env[unitDirVariable] ?? join(xdg("CONFIG", ".config"), "systemd/user"), serverUnit(office));
}

function serverWantedFile(office: Office): string {
  return join(office.state, "managed-opencode.wanted");
}

export function markServerStopped(office: Office): void {
  rmSync(serverWantedFile(office), { force: true });
}

function xdg(kind: "CONFIG" | "DATA" | "STATE" | "CACHE", fallback: string): string {
  return resolve(process.env[`XDG_${kind}_HOME`] || join(homedir(), fallback));
}

export function userSystemd(args: string[]): string {
  const result = spawnSync("systemctl", ["--user", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  if (result.status !== 0) throw new OfficeError(`systemctl --user ${args.join(" ")} failed: ${result.stderr?.trim() || result.error?.message || "see systemd's user journal"}`);

  return result.stdout.trim();
}

function activeUnit(name: string): boolean {
  return spawnSync("systemctl", ["--user", "is-active", "--quiet", name], { stdio: "ignore" }).status === 0;
}

function property(unit: string, name: string): string {
  return userSystemd(["show", `--property=${name}`, "--value", unit]);
}

function systemdQuote(text: string): string {
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\n", "\\n").replaceAll("\r", "\\r").replaceAll("%", "%%")}"`;
}

function absoluteProgram(path: string): string {
  const found = isAbsolute(path) ? path : Bun.which(path);

  if (found === null) throw new OfficeError(`could not resolve ${path} to an executable on PATH`);

  return resolve(found);
}

function opencodePath(): string {
  const path = Bun.which("opencode", { PATH: opencodeBin() }) ?? Bun.which("opencode");

  if (path === null) throw new OfficeError("install OpenCode on this host first; office does not install it in host mode");

  // Keep an installer-managed symlink, rather than resolving it to a versioned target.
  return absoluteProgram(path);
}

const serviceConfig = v.looseObject({
  disabled: v.optional(v.boolean(), false),
  port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535)), 49374),
  hostname: v.optional(v.string(), "127.0.0.1"),
  env: v.optional(v.record(v.string(), v.string()), {}),
});

function readServiceFile<Schema extends v.GenericSchema>(path: string, schema: Schema): Parsed<v.InferOutput<Schema>> {
  try {
    return check(v.safeParse(schema, existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}));
  } catch {
    return { ok: false, errors: ["invalid OpenCode service JSON (contents withheld)"] };
  }
}

function hostKey(host: string): string {
  if (host === "localhost") return "127.0.0.1";

  return host.replace(/^\[(::1)\]$/, "$1");
}

function serverAddress(office: Office): URL {
  if (office.opencode.url === undefined) throw new OfficeError("managed OpenCode requires a host URL");

  const url = new URL(office.opencode.url);

  if (url.hostname === "localhost") url.hostname = "127.0.0.1";

  return url;
}

// Service discovery uses loopback, but OpenCode can save or register its actual bind address.
function matchesServiceHost(url: URL, host: string, listenHost?: "0.0.0.0"): boolean {
  return hostKey(host) === hostKey(url.hostname) || host === listenHost;
}

function checkAddress(url: URL, listenHost?: "0.0.0.0"): void {
  const path = join(xdg("CONFIG", ".config"), "opencode/service.json");
  const result = readServiceFile(path, serviceConfig);

  if (!result.ok) throw new OfficeError(`${path}: invalid OpenCode service configuration (contents withheld)`);

  if (result.value.disabled) throw new OfficeError(`${path}: OpenCode's background service is disabled; enable it before using managed mode`);

  const port = Number(url.port || 80);

  if (result.value.port !== port || !matchesServiceHost(url, result.value.hostname, listenHost)) {
    throw new OfficeError(`OpenCode's service address in ${path} does not match ${url.origin}; correct the address before starting the office (changing service settings can stop the server)`);
  }

  if (Object.keys(result.value.env).length > 0) {
    throw new OfficeError(`${path}: OpenCode's saved service environment takes precedence over the unit; remove it before using managed mode`);
  }
}

export type ServerPlan = { unit: string; path: string; program: string; text: string; revision: string; hasSecrets: boolean };

/** Validate startup inputs without printing command output, decrypted data or runtime credentials. */
export function planServer(office: Office): ServerPlan {
  if (process.platform !== "linux" || !hasSystemd()) throw new OfficeError("opencode.managed requires Linux with a running systemd user manager");

  if (office.opencode.managed === undefined) throw new OfficeError("office.yaml does not select a managed OpenCode server");

  const url = serverAddress(office);
  const program = opencodePath();
  const file = office.secrets?.server;
  const sops = file === undefined ? undefined : absoluteProgram(requireOfficeTool(office, "sops"));
  const identity = file === undefined ? undefined : requireHostIdentity(office);
  const encrypted = file === undefined ? undefined : source(office, file);
  const env = envFilePath();

  const listenHost = office.opencode.managed.listenHost;

  checkAddress(url, listenHost);

  if (file !== undefined && sops !== undefined && identity !== undefined) {
    if (!existsSync(identity)) throw new OfficeError("managed OpenCode server secrets require an authorized age identity file (SOPS_AGE_KEY_FILE or the standard SOPS age keys.txt)");

    validateServerSecrets(office, file, sops, identity);
  }

  const commands = Object.entries(office.opencode.managed.envCommands);
  const gh = commands.length === 0 ? undefined : officeTool(office, "gh")?.path;
  const launch = `exec ${shellQuote(program)} serve --service --hostname ${shellQuote(listenHost ?? hostKey(url.hostname))} --port ${url.port || "80"}`;

  const script = [
    "set -e",
    `cd ${shellQuote(office.dir)}`,
    `. ${shellQuote(env)}`,
    ...(gh === undefined ? [] : [`gh() { ${shellQuote(absoluteProgram(gh))} "$@"; }`]),
    ...commands.map(([key, command]) => [
      `if OFFICE_COMMAND_OUTPUT=$( ( eval ${shellQuote(command)} ) 2>/dev/null ); then`,
      '  OFFICE_COMMAND_OUTPUT=${OFFICE_COMMAND_OUTPUT#"${OFFICE_COMMAND_OUTPUT%%[![:space:]]*}"}',
      '  OFFICE_COMMAND_OUTPUT=${OFFICE_COMMAND_OUTPUT%"${OFFICE_COMMAND_OUTPUT##*[![:space:]]}"}',
      `  export ${key}="$OFFICE_COMMAND_OUTPUT"`,
      "else",
      `  unset ${key}`,
      `  printf '%s\\n' 'office: could not set ${key} from its command (output withheld)' >&2`,
      "fi",
      "unset OFFICE_COMMAND_OUTPUT",
    ].join("\n")),
    sops === undefined || encrypted === undefined
      ? launch
      : `exec ${shellQuote(sops)} exec-env --same-process ${shellQuote(encrypted)} ${shellQuote(launch)}`,
  ].join("\n");

  const variables = [
    `HOME=${homedir()}`,
    `XDG_CONFIG_HOME=${xdg("CONFIG", ".config")}`,
    `XDG_DATA_HOME=${xdg("DATA", ".local/share")}`,
    `XDG_STATE_HOME=${xdg("STATE", ".local/state")}`,
    `XDG_CACHE_HOME=${xdg("CACHE", ".cache")}`,
    `PATH=${[miseShims(), join(homedir(), ".local/bin"), opencodeBin(), "/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"].join(":")}`,
  ];

  if (identity !== undefined) variables.push(`SOPS_AGE_KEY_FILE=${identity}`);

  if (process.env.TMPDIR) variables.push(`TMPDIR=${resolve(process.env.TMPDIR)}`);

  if (process.env.GH_CONFIG_DIR) variables.push(`GH_CONFIG_DIR=${resolve(process.env.GH_CONFIG_DIR)}`);

  for (const key of ["MISE_CONFIG_DIR", "MISE_DATA_DIR", "MISE_STATE_DIR", "MISE_CACHE_DIR"]) {
    const value = process.env[key];

    if (value) variables.push(`${key}=${resolve(value)}`);
  }

  const unit = serverUnit(office);

  const text = [
    `# Generated by office for ${office.name}: managed OpenCode. Do not edit.`,
    "[Unit]",
    `Description=office ${office.name}: OpenCode background service`,
    "StartLimitIntervalSec=60",
    "StartLimitBurst=5",
    "",
    "[Service]",
    "Type=exec",
    // `down` also prevents an already-queued takeover or an enabled unit at login from starting.
    `ExecCondition=:/usr/bin/test -f ${systemdQuote(serverWantedFile(office))}`,
    ...variables.map((value) => `Environment=${systemdQuote(value)}`),
    // The colon prefix switches off systemd's $ expansion; only the inner shell expands variables.
    `ExecStart=:/bin/sh -c ${systemdQuote(script)}`,
    "UMask=0077",
    "KillMode=mixed",
    "TimeoutStopSec=10s",
    "Restart=always",
    "RestartSec=2s",
    "SuccessExitStatus=143",
    "RestartPreventExitStatus=0",
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");

  const hash = createHash("sha256").update(text);

  for (const input of [env, encrypted]) {
    if (input !== undefined && existsSync(input)) hash.update("\0").update(readFileSync(input));
  }

  const revision = hash.digest("hex");

  return {
    unit, path: serverUnitPath(office), program, revision, hasSecrets: file !== undefined,
    text: text.replace("\nExecStart=", `\nEnvironment=${revisionVariable}=${revision}\nExecStart=`),
  };
}

const pidSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(2));
const infoSchema = v.object({ pid: pidSchema, version: releaseVersion });
const registrationSchema = v.object({ pid: pidSchema, url: v.string() });

type ServerInfo = v.InferOutput<typeof infoSchema>;

async function serverInfo(office: Office): Promise<ServerInfo | undefined> {
  const { OPENCODE_PASSWORD: password } = readEnvFile(join(office.state, "secrets.env"));

  if (password === undefined) return;

  try {
    const response = await fetch(new URL("/api/info", serverAddress(office)), {
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
      signal: AbortSignal.timeout(1500), redirect: "error",
    });

    if (!response.ok) return;

    const info = check(v.safeParse(infoSchema, await response.json()));

    return info.ok ? info.value : undefined;
  } catch {
    return;
  }
}

async function serverPid(office: Office): Promise<number | undefined> {
  return (await serverInfo(office))?.pid;
}

function mainPid(unit: string): number {
  return Number(property(unit, "MainPID")) || 0;
}

function registeredHere(office: Office, pid: number): boolean {
  try {
    const file = join(xdg("STATE", ".local/state"), "opencode/service.json");
    const result = readServiceFile(file, registrationSchema);

    if (!result.ok || result.value.pid !== pid) return false;

    const expected = serverAddress(office);
    const registered = new URL(result.value.url);

    return expected.protocol === registered.protocol && expected.port === registered.port && matchesServiceHost(expected, registered.hostname, office.opencode.managed?.listenHost);
  } catch {
    return false;
  }
}

function runningRevision(pid: number): string | undefined {
  try {
    const prefix = `${revisionVariable}=`;

    return readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
  } catch {
    return;
  }
}

function occupied(office: Office): Promise<boolean> {
  const url = serverAddress(office);

  return new Promise((done) => {
    const socket = createConnection({ host: hostKey(url.hostname), port: Number(url.port || 80), timeout: 1500 });

    socket.on("connect", () => { socket.destroy(); done(true); });
    socket.on("timeout", () => { socket.destroy(); done(true); });
    socket.on("error", (error: NodeJS.ErrnoException) => done(error.code !== "ECONNREFUSED"));
  });
}

/** The old Mindframe-Z unit uses the manager's HOME/XDG roots. Do not consider it in a scratch profile. */
function legacyActive(): boolean {
  const values = readManagerEnvironment();
  const home = values.HOME ?? homedir();

  return homedir() === home &&
    xdg("STATE", ".local/state") === (values.XDG_STATE_HOME || join(home, ".local/state")) &&
    xdg("CONFIG", ".config") === (values.XDG_CONFIG_HOME || join(home, ".config")) &&
    activeUnit(legacyUnit);
}

function readManagerEnvironment() {
  const entries = userSystemd(["show-environment"]).split("\n");
  const value = (key: string) => entries.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);

  return { HOME: value("HOME"), XDG_STATE_HOME: value("XDG_STATE_HOME"), XDG_CONFIG_HOME: value("XDG_CONFIG_HOME") };
}

type Incumbent = { stray: number | undefined; legacy: boolean };

/** Refuse a plain up before it mutates services. Only replace the authenticated local registration. */
export async function serverIncumbent(office: Office, upgrade: boolean): Promise<Incumbent> {
  const unit = serverUnit(office);
  const fragment = property(unit, "FragmentPath");

  if ((fragment !== "" && fragment !== serverUnitPath(office)) || property(unit, "DropInPaths") !== "") {
    throw new OfficeError(`${unit} has a different unit file or a drop-in; remove the override before running office up`);
  }

  const own = mainPid(unit);
  const pid = await serverPid(office);
  const legacy = legacyActive();
  const stray = pid === own ? undefined : pid;

  if ((stray !== undefined || legacy) && !upgrade) {
    throw new OfficeError(`${legacy ? `${legacyUnit} is active` : `OpenCode PID ${stray} is running outside the office's unit`}; office up --upgrade explicitly takes over. ${legacy ? `Disable ${legacyUnit} and any restart timer for it yourself; office never disables them.` : "Stop any other supervisor first."}`);
  }

  if (stray !== undefined && !registeredHere(office, stray)) throw new OfficeError("the OpenCode listener is not this profile's registered service; stop it yourself before office can start");

  if (pid === undefined && own === 0 && await occupied(office)) throw new OfficeError(`cannot identify the listener at ${office.opencode.url}; check OPENCODE_PASSWORD in state/secrets.env or stop the listener yourself`);

  return { stray, legacy };
}

function processIdentity(pid: number): string {
  // /proc/PID/stat field 22 (start time); the parenthesized comm field can itself contain spaces.
  const stat = readFileSync(`/proc/${pid}/stat`, "utf8");

  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
}

function queueRestart(office: Office, plan: ServerPlan, { stray, legacy }: Incumbent): void {
  const lines = ["set -eu", `test -f ${shellQuote(serverWantedFile(office))} || exit 0`];

  if (legacy) lines.push(`systemctl --user stop ${legacyUnit}`);

  if (stray !== undefined) {
    let identity;

    try {
      identity = processIdentity(stray);
    } catch {
      throw new OfficeError("the registered OpenCode process changed during takeover; run office up --upgrade again");
    }

    if (!/^\d+$/.test(identity)) throw new OfficeError("could not identify the registered OpenCode process");

    lines.push(
      `same_process() { [ "$(sed -n 's/^.*) \\([^ZX]\\)/\\1/p' /proc/${stray}/stat 2>/dev/null | cut -d ' ' -f20)" = ${identity} ]; }`,
      `if same_process; then kill -TERM ${stray}; fi`,
      "for wait in 1 2 3 4 5 6 7 8 9 10; do if ! same_process; then break; fi; sleep 1; done",
      `if same_process; then printf '%s\\n' 'office: previous OpenCode process did not exit; stop it and retry' >&2; exit 1; fi`,
    );
  }

  lines.push(`exec systemctl --user restart ${plan.unit}`);

  const job = plan.unit.replace(/\.service$/, "-restart.service");
  const result = spawnSync("systemd-run", ["--user", "--collect", "--no-block", "--quiet", "--unit", job, "/bin/sh", "-c", lines.join("\n")], { stdio: "ignore" });

  if (result.status !== 0) throw new OfficeError(`could not queue the OpenCode restart; check the systemd user manager (${job})`);
}

/**
 * Starts, keeps or restarts the managed server after `written` brought its unit file to the plan
 * (`writeServerUnit`, which already reloaded a written file). A stopped unit starts; a running one
 * restarts only on `upgrade`, and only for a takeover or when it runs another revision than the
 * plan, in a job independent of this terminal: it is pending until an outside check verifies it.
 */
export async function startServer(office: Office, plan: ServerPlan, upgrade: boolean, written: "unchanged" | "written" | "held"): Promise<void> {
  const incumbent = await serverIncumbent(office, upgrade);
  const { unit, path, program } = plan;
  const active = activeUnit(unit);

  if (property(unit, "NeedDaemonReload") === "yes") userSystemd(["daemon-reload"]);

  if (property(unit, "FragmentPath") !== path || property(unit, "DropInPaths") !== "") {
    throw new OfficeError(`${unit} has a different unit file or a drop-in; remove the override before running office up`);
  }

  if (property(unit, "UnitFileState") !== "enabled") userSystemd(["enable", path]);

  mkdirSync(office.state, { recursive: true });
  const marker = serverWantedFile(office);
  const existing = lstatSync(marker, { throwIfNoEntry: false });

  if (existing === undefined) writeFileSync(marker, "", { flag: "wx", mode: 0o600 });
  else if (!existing.isFile()) throw new OfficeError(`${marker} is not an office state file`);

  say(`${unit} runs ${program}`, "office: ");

  const own = active ? mainPid(unit) : 0;
  const stale = written === "written" || (own !== 0 && runningRevision(own) !== plan.revision);

  if (upgrade && (incumbent.legacy || incumbent.stray !== undefined || (active && stale))) {
    if (incumbent.legacy) say(`taking over ${legacyUnit}; disable it and any restart timer for it yourself`, "office: ");

    say(`queueing OpenCode restart independently of this terminal; verify with office check or journalctl --user -u ${unit.replace(/\.service$/, "-restart.service")} -u ${unit}`, "office: ");
    queueRestart(office, plan, incumbent);

    return;
  }

  if (!active) userSystemd(["start", unit]);

  for (let attempt = 0; attempt < 30; attempt++) {
    const pid = await serverPid(office);

    if (pid !== undefined && pid === mainPid(unit)) {
      if (runningRevision(pid) !== plan.revision) {
        say(`pending: ${unit} runs PID ${pid} under its previous settings${written === "held" ? " and unit definition" : ""}; office setup offers the restart (office up --upgrade also applies it)`, "office: ");

        return;
      }

      // The process runs the current revision, but the installed file is another one, which the next start would run.
      if (written === "held") {
        say(`pending: ${unit} runs PID ${pid} with the current settings, but its installed unit definition differs; office up --upgrade installs it`, "office: ");

        return;
      }

      say(`${unit}: verified OpenCode at systemd PID ${pid} with the current settings`, "office: ");

      return;
    }

    if (pid !== undefined) break;

    await Bun.sleep(500);
  }

  throw new OfficeError(`${unit} did not become the healthy OpenCode server at ${office.opencode.url}; see journalctl --user -u ${unit} and check the service password`);
}

/** The office's own managed server, serving under an older plan (environment file, unit or secrets) than the current one. */
export type StaleServer = { unit: string; pid: number; inside: boolean };

/**
 * The office's managed server when its unit's own main process answers as the office's server
 * but started under another revision; undefined when it is current, stopped, not answering, not
 * the unit's process, or the unit file isn't the office's.
 */
export async function staleServer(office: Office, plan: ServerPlan): Promise<StaleServer | undefined> {
  const { unit } = plan;

  if (!activeUnit(unit) || property(unit, "FragmentPath") !== plan.path || property(unit, "DropInPaths") !== "") return;

  const own = mainPid(unit);

  if (own === 0 || (await serverPid(office)) !== own || runningRevision(own) === plan.revision) return;

  return { unit, pid: own, inside: inManagedServer(office) };
}

/**
 * Restarts the office's unit alone, from a terminal outside it, and waits until a new main
 * process answers with the current revision. Takes over nothing and changes no pin.
 */
export async function restartStaleServer(office: Office, plan: ServerPlan, stale: StaleServer): Promise<number> {
  if (stale.inside) throw new OfficeError("this terminal runs inside the managed OpenCode server; queue the restart instead");

  const identity = processIdentity(stale.pid);

  if (mainPid(plan.unit) !== stale.pid || !processIdentityIs(stale.pid, identity)) throw new OfficeError("the managed OpenCode PID changed before restart; leaving it alone");

  userSystemd(["restart", plan.unit]);

  for (let attempt = 0; attempt < 60; attempt++) {
    const pid = await serverPid(office);

    if (pid !== undefined && pid !== stale.pid && pid === mainPid(plan.unit)) {
      if (runningRevision(pid) === plan.revision) return pid;

      throw new OfficeError(`${plan.unit} restarted as PID ${pid}, but not with the current settings; see journalctl --user -u ${plan.unit}`);
    }

    await Bun.sleep(500);
  }

  throw new OfficeError(`${plan.unit} did not answer as the office's OpenCode after the restart; see journalctl --user -u ${plan.unit}`);
}

/** Queues the office unit's restart in a job of its own, for a terminal the restart would close. */
export function queueStaleRestart(office: Office, plan: ServerPlan): void {
  queueRestart(office, plan, { stray: undefined, legacy: false });
}

/** Don't run a synchronous restart from a terminal that would die with the server. */
export function inManagedServer(office: Office): boolean {
  return process.platform === "linux" && readFileSync("/proc/self/cgroup", "utf8").split(/[\/\n]/).includes(serverUnit(office));
}

const updateUnitProperties = "FragmentPath,DropInPaths,NeedDaemonReload,UnitFileState,ActiveState,SubState,MainPID,ExecMainPID,ExecMainCode,ExecMainStatus";

function updateUnit(office: Office) {
  const unit = serverUnit(office);
  const result = userSystemd(["show", `--property=${updateUnitProperties}`, unit]).split("\n");
  const read = (key: string) => result.find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1);

  if (read("FragmentPath") !== serverUnitPath(office) || read("DropInPaths") !== "" || read("NeedDaemonReload") !== "no") {
    throw new OfficeError(`${unit} has a different loaded file, a drop-in, or a pending reload; run office up before updating`);
  }

  const active = read("ActiveState") === "active";
  const recovering = read("ActiveState") === "activating" && read("SubState") === "auto-restart";
  // `serve --service` exits cleanly when an incumbent wins. A stopped/never-run unit does not
  // have a successful main process exit (OpenCode exits 143 when systemd stops it).
  const displaced = read("ActiveState") === "inactive" && read("ExecMainCode") === "1" && read("ExecMainStatus") === "0" && Number(read("ExecMainPID")) >= 2;

  const enabled = read("UnitFileState") === "enabled";

  return { eligible: enabled && (active || recovering || displaced), stopped: !enabled || (read("ActiveState") === "inactive" && read("ExecMainStatus") === "143"), active, displaced, main: Number(read("MainPID")) || 0 };
}

export type UpdatePeer = ServerInfo & { owned: boolean };

/** Accept only a healthy, authenticated service registered to this profile and origin. */
export async function updatePeer(office: Office): Promise<UpdatePeer | undefined> {
  if (!existsSync(serverWantedFile(office))) return;

  const state = updateUnit(office);

  if (!state.eligible) return;

  const info = await serverInfo(office);

  if (!info || !registeredHere(office, info.pid)) {
    if (!state.active && !await occupied(office)) return;

    throw new OfficeError("cannot verify the registered OpenCode listener; leaving it alone");
  }

  const owned = info.pid === state.main;

  if (!owned && activeUnit(legacyUnit)) throw new OfficeError("the legacy OpenCode unit is active; take over the listener explicitly first");

  return { ...info, owned };
}

async function takeOverAgentPeer(office: Office, program: string, peer: UpdatePeer): Promise<boolean> {
  const identity = processIdentity(peer.pid);
  const confirmed = await updatePeer(office);

  if (confirmed === undefined) return false;

  if (confirmed.owned || confirmed.pid !== peer.pid || !/^\d+$/.test(identity)) {
    throw new OfficeError("the registered OpenCode process changed during takeover; retry from a separate terminal");
  }

  // A different .service owns a supervised listener. Only a client-spawned native OpenCode
  // of this profile can be taken over here; other supervisors need explicit intervention.
  const group = readFileSync(`/proc/${peer.pid}/cgroup`, "utf8").trim();
  const binary = readlinkSync(`/proc/${peer.pid}/exe`).replace(/ \(deleted\)$/, "");

  if (group.split("\n").some((line) => line.endsWith(".service")) || binary !== realpathSync(program)) {
    throw new OfficeError("the registered server is not an unsupervised copy of this OpenCode install; leaving it alone");
  }

  if (!existsSync(serverWantedFile(office)) || !updateUnit(office).eligible) return false;

  if (!processIdentityIs(peer.pid, identity)) throw new OfficeError("the registered OpenCode PID changed before takeover");

  process.kill(peer.pid, "SIGTERM");

  const deadline = Date.now() + 10_000;

  // A connected TUI also tries to fill this gap. Wait for the exact process, not a long delay.
  while (Date.now() < deadline && processIdentityIs(peer.pid, identity)) await Bun.sleep(20);

  if (processIdentityIs(peer.pid, identity)) throw new OfficeError("the previous OpenCode listener did not exit; leaving the managed unit alone");

  if (!existsSync(serverWantedFile(office)) || !updateUnit(office).eligible) return false;

  const unit = serverUnit(office);

  if (await occupied(office) && (await serverPid(office)) !== mainPid(unit)) throw new OfficeError("another process took the OpenCode address; leaving it alone");

  userSystemd(["start", unit]);

  return true;
}

/** Reconcile the already-installed, recorded unit. Never writes its files or restarts other services. */
export async function applyAgentServerVersion(office: Office, program: string, version: string, peer: UpdatePeer): Promise<void> {
  const unit = serverUnit(office);
  let takenOver = !peer.owned;

  if (peer.owned) {
    const state = updateUnit(office);

    if (!existsSync(serverWantedFile(office)) || state.stopped) return;

    if (!state.active || state.main !== peer.pid) throw new OfficeError("the managed OpenCode PID changed before restart; leaving it alone");

    // Unlike restart, try-restart does not bring back an explicitly stopped unit.
    userSystemd(["try-restart", unit]);
  } else if (!await takeOverAgentPeer(office, program, peer)) {
    return;
  }

  let strayPid = 0;
  let currentPid = 0;

  for (let attempt = 0; attempt < 30; attempt++) {
    if (!existsSync(serverWantedFile(office))) return;

    const state = updateUnit(office);

    if (state.stopped) return;

    const info = await serverInfo(office);
    const previousPid = currentPid;

    currentPid = 0;

    if (info !== undefined && info.pid !== peer.pid && registeredHere(office, info.pid)) {
      if (state.active && info.pid === state.main && info.version === version) {
        currentPid = info.pid;

        if (currentPid === previousPid) {
          console.log(`office: managed OpenCode ${version} verified at systemd PID ${info.pid}`);

          return;
        }
      }

      if (state.eligible && info.pid !== state.main && (state.displaced || strayPid === info.pid)) {
        if (takenOver) throw new OfficeError("another OpenCode client took the address again; leaving it alone");

        if (compareVersions(version, info.version) < 0) throw new OfficeError("the new listener is newer than the installed OpenCode; leaving it alone");

        console.log("office: a client registered during restart; taking over the verified same-profile server once");

        if (!await takeOverAgentPeer(office, program, { ...info, owned: false })) return;

        takenOver = true;
      }

      strayPid = info.pid;
    }

    await Bun.sleep(500);
  }

  throw new OfficeError(`${unit} did not register a healthy OpenCode ${version} at its systemd PID; check the unit journal`);
}

function processIdentityIs(pid: number, identity: string): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");

    return fields[0] !== "Z" && fields[0] !== "X" && fields[19] === identity;
  } catch {
    return false;
  }
}

/** What `office check` says of the managed server; `matches` is how the recorded unit compares with the plan (`matchesServerUnit`). */
export async function serverReport(office: Office, plan: ServerPlan, matches: "current" | "pending" | "different"): Promise<{ ok: boolean | "warn"; detail: string }> {
  const { unit, program } = plan;
  const loaded = property(unit, "FragmentPath") === plan.path && property(unit, "DropInPaths") === "";
  const matching = matches !== "different" && loaded;
  const enabled = property(unit, "UnitFileState") === "enabled";
  const active = activeUnit(unit);
  const own = mainPid(unit);
  const pid = await serverPid(office);
  const outside = pid !== undefined && pid !== own;
  const pending = matches === "pending" || (own !== 0 && runningRevision(own) !== plan.revision);

  const detail = [
    unit, !matching ? "unit missing or different" : matches === "pending" ? "unit definition pending" : "unit matches", enabled ? "enabled" : "not enabled",
    active ? "active" : "not active", program,
    outside ? "the server is running outside the office's unit; run office up --upgrade" : pid === undefined ? "server not responding (check the unit journal and service password)" : `server and unit PID ${pid}`,
    ...(pending ? ["restart pending: office setup offers it (or office up --upgrade)"] : []),
    plan.hasSecrets ? "secrets file decrypts" : "no server secrets configured",
  ].join("; ");

  return { ok: matching && enabled && active && pid !== undefined && !outside ? pending ? "warn" : true : false, detail };
}
