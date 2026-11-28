// Where the shared tools meet the office's commands in a host-mode office.
//
// - Sync, before it publishes a package set: a tool whose recorded desired release no longer serves
//   it (none yet, below a raised minimum, or off the owner's hold) gets an eligible one recorded in
//   office.lock, with one native batch plan behind Socket Firewall. Nothing is installed or
//   activated, and a sync whose tools are all served asks mise nothing. While the office's Socket
//   Firewall can't run (office up hasn't installed it yet, office.yaml turns it off, or the file
//   isn't the one office installed), a tool with no release yet waits, and a recorded release that
//   no longer serves stops the sync: no package set is published against it.
// - Up: checks what it can before starting any service (checkTools), then records what is still
//   missing the same way, installs what is missing and, with --upgrade, stages every change before
//   switching any (src/features/tools/apply.ts).
//
// Each operation runs one mise, the exact version the office pins, by its real absolute path, for
// its registry, planning and staging (officeMise), and runs it for planning and staging only behind
// the office's own Socket Firewall: never bare, whatever office.yaml says. It hands an isolated mise run the node and pnpm the host's own toolchain resolves,
// by their folders. Container mode has none of this: its tools are the container's.
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";

import type { Gathered, GatheredPackage } from "../../gather.ts";
import { hostLayout, hostWrappers, miseShims } from "../machine/host-env.ts";
import { claim } from "../machine/record.ts";
import { fileState } from "../machine/owned-files.ts";
import type { Office } from "../../office.ts";
import { containerLayout } from "./sfw.ts";
import { lockFile } from "../../versions.ts";
import { type Application, applyTools, checkTools, liveReleases, stagingNeeded } from "./apply.ts";
import { type AttestedMise, miseRegistry, officeMise } from "./registry.ts";
import { type Run, type SelectionInputs, selectTools, unmetTools } from "./selection.ts";

/** Runs a command and returns its status and output. */
export function spawnRun(): Run {
  return (argv, { cwd, env }) => {
    const result = Bun.spawnSync([...argv], { cwd, env: { ...env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });

    return { status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  };
}

/** The runtimes an isolated mise run needs from the host, such as npm tools' node and pnpm. */
const runtimeCommands = ["node", "pnpm"];

function miseWhich(office: Pick<Office, "dir">, mise: string, env: Readonly<Record<string, string | undefined>>, command: string): string | undefined {
  try {
    const resolved = execFileSync(mise, ["which", command], { cwd: office.dir, encoding: "utf8", timeout: 60_000, stdio: ["ignore", "pipe", "ignore"], env: { ...env, MISE_AUTO_INSTALL: "0" } }).trim();

    if (resolved.startsWith("/")) return resolved;
  } catch {
    // mise doesn't resolve it here.
  }
}

function onPath(env: Readonly<Record<string, string | undefined>>, skip: readonly string[], command: string): string | undefined {
  const path = (env.PATH ?? "").split(":").filter(dir => dir !== "" && !skip.includes(dir)).join(":");

  return Bun.which(command, { PATH: path }) ?? undefined;
}

function folders(find: (command: string) => string | undefined): string[] {
  return [...new Set(runtimeCommands.flatMap(command => find(command) ?? []).map(file => dirname(file)))];
}

/**
 * The folder of each runtime as the host's own toolchain resolves it for the office: mise's choice
 * in the office's folder under the caller's config, else the first on PATH outside mise's shims and
 * the office's Socket Firewall wrappers, which aren't runtimes.
 * A runtime the host has neither way is left out; an install that needs it then fails, naming it.
 */
export function runtimeFolders(office: Pick<Office, "dir">, mise: string, env: Readonly<Record<string, string | undefined>>): string[] {
  return folders(command => miseWhich(office, mise, env, command) ?? onPath(env, [miseShims(), hostWrappers()], command));
}

/** The folder of each runtime the office's pinned `mise` resolves in the office's folder, and nothing from PATH. */
export function pinnedRuntimeFolders(office: Pick<Office, "dir">, mise: string, env: Readonly<Record<string, string | undefined>>): string[] {
  return folders(command => miseWhich(office, mise, env, command));
}

/** The folder of each runtime first on a container's PATH outside mise's shims and the image's Socket Firewall wrappers. */
export function containerRuntimeFolders(env: Readonly<Record<string, string | undefined>>): string[] {
  return folders(command => onPath(env, [miseShims(), containerLayout.bin], command));
}

/** What an operation on the shared tools runs: its one mise, attested, and the command and inputs it gives selection and staging. */
export type ToolsRun = { mise: AttestedMise; inputs: Pick<SelectionInputs, "mise" | "registry" | "runtimes">; runtimes: string[] };

/** The operation's protected mise, or why there is none: the office's Socket Firewall can't run it. */
export type Firewalled = { ok: true; tools: ToolsRun } | { ok: false; reason: string };

/**
 * The operation's one mise (officeMise) behind the office's Socket Firewall: refused while the
 * firewall is off in office.yaml, or isn't the copy office installed (missing, changed, or a file
 * the office's machine record doesn't list). Planning and staging never run mise without it.
 */
export function firewalledMise(office: Office, env: Readonly<Record<string, string | undefined>> = process.env, mise: AttestedMise = officeMise(office)): Firewalled {
  const { sfw } = hostLayout(mise.path);

  if (!office.tools.socketFirewall) return { ok: false, reason: `Socket Firewall is off for this office (sfw enabled: false in office.yaml), and office selects and installs shared tools only behind it; turn it on, then run office up` };
  const current = claim(office);
  const installed = current.kind === "ours" ? current.record.files.find(file => file.path === sfw) : undefined;

  if (installed === undefined || fileState(installed) !== "present") return { ok: false, reason: `Socket Firewall at ${sfw} isn't the copy office installed (missing, changed or not in the machine record), and office selects and installs shared tools only behind it; run office up, which installs it` };
  const runtimes = runtimeFolders(office, mise.path, env);

  return { ok: true, tools: { mise, runtimes, inputs: { registry: () => miseRegistry(mise.path), runtimes, mise: [sfw, mise.path] } } };
}

/** The line naming what an operation ran mise with, for its output. */
export function attestation({ mise, runtimes }: Pick<ToolsRun, "mise" | "runtimes">): string {
  return `shared tools: mise ${mise.version} at ${mise.path}; runtimes from ${runtimes.length ? runtimes.join(", ") : "nowhere on this host"}`;
}

/** A run, and whether it was called. */
type Counted = { run: Run; used: () => boolean };

/** `run`, and whether it was called. */
function counted(run: Run): Counted {
  let calls = 0;

  return { run: (argv, options) => (calls++, run(argv, options)), used: () => calls > 0 };
}

/** What recording desired releases at sync said; `ok` false stops the publication. */
export type Recorded = { ok: boolean; lines: string[] };

/** Records a desired release for each tool whose recorded one no longer serves it; see the module comment. */
export function recordUnmet(office: Office, packages: readonly GatheredPackage[], { run = spawnRun(), env = process.env }: { run?: Run; env?: Readonly<Record<string, string | undefined>> } = {}): Recorded {
  if (office.opencode.mode !== "host") return { ok: true, lines: [] };
  let attested: AttestedMise | undefined;
  const mise = () => (attested ??= officeMise(office));
  const unmet = unmetTools(office, packages, () => miseRegistry(mise().path));

  if (unmet.length === 0) return { ok: true, lines: [] };
  const firewalled = firewalledMise(office, env, mise());

  if (!firewalled.ok) {
    const recorded = unmet.filter(tool => tool.recorded !== undefined);

    if (recorded.length > 0) return { ok: false, lines: recorded.map(tool => `FAILED ${lockFile} records tool ${tool.name} ${tool.recorded}, which no longer serves its packages, and no other is selected: ${firewalled.reason}, then office sync`) };

    return { ok: true, lines: [`not selecting releases of tool ${unmet.map(tool => tool.name).join(", ")} yet: ${firewalled.reason}`] };
  }

  const selection = selectTools(office, packages, { ...firewalled.tools.inputs, run, env, unmet: true });

  return { ok: selection.ok, lines: [attestation(firewalled.tools), ...selection.lines] };
}

/** Up's checks before any service starts: what applying would refuse from this machine's files alone (checkTools). */
export async function precheckTools(office: Office, gathered: Pick<Gathered, "packages" | "registries">, { upgrade }: { upgrade: boolean }): Promise<Application> {
  if (office.opencode.mode !== "host") return { ok: true, lines: [] };

  return checkTools(office, gathered.packages, { upgrade, releases: liveReleases(gathered) });
}

/** Up's part: records what is still missing, then installs, and with `upgrade` switches, the shared tools. */
export async function reconcileTools(office: Office, gathered: Pick<Gathered, "packages" | "registries">, { upgrade, run = spawnRun(), env = process.env }: { upgrade: boolean; run?: Run; env?: Readonly<Record<string, string | undefined>> }): Promise<Application> {
  if (office.opencode.mode !== "host") return { ok: true, lines: [] };
  const firewalled = firewalledMise(office, env);

  if (!firewalled.ok) {
    const releases = liveReleases(gathered);
    const idle = unmetTools(office, gathered.packages).length === 0 && !(await stagingNeeded(office, gathered.packages, { upgrade, releases }));

    return idle ? { ok: true, lines: [] } : { ok: false, lines: [`FAILED ${firewalled.reason}; no shared tool was selected, installed or switched`] };
  }

  const { tools } = firewalled;
  const calls = counted(run);
  const recorded = selectTools(office, gathered.packages, { ...tools.inputs, run: calls.run, env, unmet: true });
  const applied = recorded.ok ? await applyTools(office, gathered.packages, { ...tools.inputs, run: calls.run, env, upgrade, releases: liveReleases(gathered) }) : recorded;
  const lines = recorded.ok ? [...recorded.lines, ...applied.lines] : recorded.lines;

  return { ok: applied.ok, lines: calls.used() ? [attestation(tools), ...lines] : lines };
}
