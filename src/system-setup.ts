// What `office setup` does about the machine beyond the office's folder, in a host-mode office that
// manages its machine: the system setup the office's own files declare, and the managed OpenCode
// server running with older settings.
//
// System setup. The packages' system blocks (src/package-system.ts) and the office's machine.toml
// declare mise `[bootstrap]` packages and files, such as Chrome from apt or the headers a tool
// builds against. Setup asks mise what they would change, with mise reading only the office's own
// files: a scratch MISE_CONFIG_DIR whose conf.d links the office's fragments and machine.toml, an
// empty system config folder, from `/`. So bootstrap resources of the user's own mise config, of
// another tool or of a project are never planned or applied here. Each applying block's prepare
// script answers `--check` without sudo or network. With nothing to do it asks nothing. Otherwise
// it lists what is pending and, only when the user answers yes in a terminal, runs
// `mise bootstrap --only packages,files` in the same scope, where mise and the prepare scripts ask
// for sudo themselves; then it checks again, and fails setup unless nothing is left. Without a
// terminal it applies nothing, whatever consent the machine record holds. Setup runs this before
// `office up` installs tools, so tools that build against system headers find them.
//
// Verification. Once the tools are installed, each applying block's verify script runs in a fresh
// shell holding only the office's environment file, so it proves what agents and terminals get.
//
// The server. After `office up`, a managed server whose running process predates the current
// settings (its environment file, unit or secrets) is offered a restart of the office's unit alone:
// never `office up --upgrade`, never another process, never a pin. Declining keeps it serving as it
// was. A terminal inside the server can't restart it synchronously, so the restart is queued as
// setup's last act.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

import * as v from "valibot";

import type { StaleServer } from "./host-server.ts";
import { envFilePath } from "./host-env.ts";
import { claim } from "./machine.ts";
import { type Office, OfficeError } from "./office.ts";
import { systemApplies } from "./package-system.ts";
import { machineFiles } from "./package-tools.ts";
import type { InstalledPackage } from "./packages.ts";
import { check } from "./schema.ts";
import { inherit, progress, say, warn } from "./report/index.ts";

/** A command's outcome: its exit status and what it printed, when it didn't print to the terminal. */
export type RunResult = { status: number; stdout: string; stderr: string };

/** Runs a command; `terminal` gives it this terminal, for sudo's password prompt. */
export type Run = (command: string[], options: { env?: NodeJS.ProcessEnv; cwd?: string; terminal?: boolean }) => RunResult;

export const runCommand: Run = (command, { env, cwd, terminal = false }) => {
  const result = spawnSync(command[0], command.slice(1), { env, cwd, encoding: "utf8", stdio: terminal ? "inherit" : ["ignore", "pipe", "pipe"] });

  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.error?.message ?? result.stderr ?? "" };
};

export type Ask = (text: string) => Promise<string>;

/** What a prepare script's --check exits with when a run would change something. */
const prepareWouldChange = 100;

/** Variables that would point mise at other config than the scope's. */
const foreignConfig = ["MISE_GLOBAL_CONFIG_FILE", "MISE_CONFIG_FILE", "MISE_ENV", "MISE_OVERRIDE_CONFIG_FILENAMES", "MISE_OVERRIDE_TOOL_VERSIONS_FILENAMES"];

/** Whether a mise file declares any `[bootstrap…]` table. */
function declaresBootstrap(path: string): boolean {
  return /^\s*\[\s*bootstrap[.\]\s]/m.test(readFileSync(path, "utf8"));
}

/**
 * Runs `body` with an environment in which mise reads only the office's machine-wide files, in
 * the order mise's global conf.d holds their links. The scratch folder goes when it returns.
 */
function inScope<Result>(office: Office, body: (env: NodeJS.ProcessEnv) => Result): Result {
  const dir = mkdtempSync(join(tmpdir(), "office-system-"));

  try {
    const conf = join(dir, "conf.d");

    mkdirSync(conf);
    mkdirSync(join(dir, "system"));

    for (const [index, file] of machineFiles(office).entries()) symlinkSync(file, join(conf, `${String(index).padStart(2, "0")}-${basename(file)}`));

    const env: NodeJS.ProcessEnv = { ...process.env, MISE_CONFIG_DIR: dir, MISE_SYSTEM_CONFIG_DIR: join(dir, "system") };

    for (const name of foreignConfig) delete env[name];

    return body(env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const planSchema = v.object({
  resources: v.array(v.object({ id: v.object({ kind: v.string(), name: v.string() }), action: v.string(), current: v.nullish(v.string()) })),
  summary: v.object({ unchanged: v.optional(v.number(), 0) }),
});

/** Where the office's system setup stands on this machine. */
export type SystemStatus =
  | { kind: "skipped"; reason: string }
  | { kind: "ready"; unchanged: number }
  | { kind: "pending"; pending: string[] }
  | { kind: "failed"; problems: string[] };

/** The packages whose system block applies here. */
function applying(office: Office, installed: InstalledPackage[]): InstalledPackage[] {
  return installed.filter((item) => systemApplies(office, item));
}

/** Why setup leaves the machine's system setup alone, or undefined when it is this office's to offer. */
function notOurs(office: Office): string | undefined {
  if (office.opencode.mode !== "host") return "the office runs OpenCode in its container";

  if (process.platform !== "linux") return "only Linux machines have it";

  if (claim(office).kind !== "ours") return "this office doesn't manage this machine";

  return machineFiles(office).some(declaresBootstrap) ? undefined : "the office declares none";
}

/** What the office's system setup would change here, asked without sudo, network or changes. */
export function systemStatus(office: Office, installed: InstalledPackage[], mise: string, run: Run = runCommand): SystemStatus {
  const reason = notOurs(office);

  if (reason !== undefined) return { kind: "skipped", reason };

  const pending: string[] = [];
  const problems: string[] = [];
  const missing: string[] = [];

  for (const item of applying(office, installed)) {
    const system = item.manifest.system;

    if (system?.prepare !== undefined) {
      const result = run(["bash", join(item.dir, system.prepare), "--check"], {});

      if (result.status === prepareWouldChange) pending.push(...result.stdout.split("\n").filter((line) => line.trim() !== "").map((line) => `package ${item.entry.name}: ${line.trim()}`));
      else if (result.status !== 0) problems.push(`package ${item.entry.name}'s ${system.prepare} --check failed: ${(result.stderr || result.stdout).trim()}`);
    }

    for (const path of system?.ready ?? []) if (!existsSync(path)) missing.push(`package ${item.entry.name}: ${path} is missing, though mise has nothing left to install`);
  }

  const planned = inScope(office, (env) => run([mise, "bootstrap", "plan", "--json"], { env, cwd: "/" }));
  let unchanged = 0;

  if (planned.status !== 0) problems.push(`mise bootstrap plan failed: ${planned.stderr.trim()}`);
  else {
    let document: unknown;

    try {
      document = JSON.parse(planned.stdout);
    } catch {
      document = undefined;
    }

    const plan = check(v.safeParse(planSchema, document));

    if (!plan.ok) problems.push(`mise bootstrap plan printed no plan office reads: ${plan.errors.join("; ")}`);
    else {
      unchanged = plan.value.summary.unchanged;

      for (const resource of plan.value.resources) {
        // A hook runs on every apply, so mise lists it as `run`, which isn't a change.
        if (resource.action !== "noop" && resource.action !== "run") pending.push(`${resource.id.kind} ${resource.id.name}: ${resource.action}${resource.current ? ` (now ${resource.current})` : ""}`);
      }
    }
  }

  if (problems.length > 0) return { kind: "failed", problems };

  // A ready path mise and the prepare scripts don't account for shows the declarations drifted.
  if (pending.length === 0 && missing.length > 0) return { kind: "pending", pending: missing };

  return pending.length > 0 ? { kind: "pending", pending } : { kind: "ready", unchanged };
}

/** What the system step did: nothing to do, applied, left for later, or not this office's to do. */
export type SystemOutcome = "ready" | "applied" | "deferred" | "skipped";

/** A warning that the system setup waits, under its old name when no reporter runs. */
const deferred = (text: string) => warn(text, `System setup: ${text}`);

const list = (lines: string[]) => lines.map((line) => `  - ${line}`).join("\n");

/**
 * Setup's system step: says where the office's system setup stands and, when something is
 * pending and the user agrees in a terminal, applies it through mise in the office's scope, then
 * checks that nothing is left. Throws when a check fails or the apply leaves something undone.
 */
export async function systemStep(office: Office, installed: InstalledPackage[], { mise, ask, run = runCommand }: { mise: string; ask: Ask | undefined; run?: Run }): Promise<SystemOutcome> {
  progress("asking mise what would change (no sudo, no network)");

  const status = systemStatus(office, installed, mise, run);

  if (status.kind === "skipped") {
    say(`none here (${status.reason})`, "System setup: ");

    return "skipped";
  }

  if (status.kind === "failed") throw new OfficeError(`System setup: couldn't tell what is pending:\n${list(status.problems)}`);

  if (status.kind === "ready") {
    say(`nothing to do; the ${status.unchanged} packages and files this office declares are in place`, "System setup: ");

    return "ready";
  }

  say(`the office's packages and machine.toml declare system packages and files this machine lacks:\n${list(status.pending)}`, "System setup: ");

  if (ask === undefined) {
    deferred("not applied without a terminal, as it needs sudo; rerun office setup in a terminal to apply it. Tools that build against these packages can fail to install until then");

    return "deferred";
  }

  const answer = await ask("Apply it now? mise installs them from this terminal, reading only this office's files, and asks for your sudo password itself. [yes/no]");

  if (answer !== "yes") {
    deferred("left as it is; rerun office setup to apply it. Tools that build against these packages can fail to install until then");

    return "deferred";
  }

  // mise and the prepare scripts ask for sudo's password on this terminal, and mise refuses sudo
  // when its output isn't one; so mise gets the terminal itself, with the live display paused.
  const applied = await inherit("mise bootstrap --only packages,files: mise asks for your sudo password itself; its output follows", () =>
    inScope(office, (env) => run([mise, "bootstrap", "--only", "packages,files", "--yes"], { env, cwd: "/", terminal: true })),
  );

  if (applied.status !== 0) throw new OfficeError("System setup: mise bootstrap failed (above); fix it and rerun office setup");

  const after = systemStatus(office, installed, mise, run);

  if (after.kind === "failed") throw new OfficeError(`System setup: applied, but couldn't check it:\n${list(after.problems)}`);

  if (after.kind === "pending") throw new OfficeError(`System setup: applied, but these are still pending:\n${list(after.pending)}`);

  say("applied, and nothing is left to do", "System setup: ");

  return "applied";
}

/** A line per package's verification, and whether every package that is set up verified. */
export type Verification = { ok: boolean; lines: string[] };

/** Runs each applying block's verify script in a fresh shell that has sourced only the office's environment file. */
export function verifySystems(office: Office, installed: InstalledPackage[], run: Run = runCommand): Verification {
  if (notOurs(office) !== undefined) return { ok: true, lines: [] };

  const lines: string[] = [];
  let ok = true;
  const home = process.env.HOME || homedir();
  const keep = ["USER", "LOGNAME", "LANG"].flatMap((name) => (process.env[name] === undefined ? [] : [`${name}=${process.env[name]}`]));

  for (const item of applying(office, installed)) {
    const system = item.manifest.system;

    if (system?.verify === undefined) continue;

    if (system.ready.some((path) => !existsSync(path)) || !existsSync(envFilePath())) {
      lines.push(`package ${item.entry.name}: not verified, as its system setup isn't applied`);

      continue;
    }

    const result = run(["env", "-i", `HOME=${home}`, ...keep, "PATH=/usr/bin:/bin", "/bin/sh", "-c", '. "$1" && exec bash "$2"', "sh", envFilePath(), join(item.dir, system.verify)], {});
    const said = (result.status === 0 ? result.stdout : result.stderr || result.stdout).trim().split("\n").at(-1) ?? "";

    if (result.status !== 0) ok = false;

    lines.push(`package ${item.entry.name}: ${result.status === 0 ? "verified" : "FAILED"}: ${said}`);
  }

  return { ok, lines };
}

/** The managed server's lifecycle, as the restart offer needs it. */
export type RestartOps = { stale(): Promise<StaleServer | undefined>; restart(stale: StaleServer): Promise<number> };

/**
 * Offers to restart the office's managed server when it runs with older settings. Returns
 * "queue" when the user agreed from a terminal inside the server, so setup queues the restart last.
 */
export async function offerRestart(ask: Ask | undefined, ops: RestartOps): Promise<"queue" | undefined> {
  const stale = await ops.stale();

  if (stale === undefined) return;

  const what = `OpenCode (${stale.unit}, PID ${stale.pid}) serves with its previous settings, so changes to its environment, such as which browser agent-browser launches, reach sessions once it restarts`;
  const later = "rerun office setup to restart it; until then it keeps serving as before (office check shows the restart as pending, not as a failure)";

  if (ask === undefined) {
    say(`OpenCode: ${what}. Not restarted without a terminal: ${later}`);

    return;
  }

  const inside = stale.inside ? " This terminal runs inside it, so the restart is queued as setup's last step and this terminal closes." : "";
  const answer = await ask(`${what}. Restart it now? Its sessions disconnect and reconnect.${inside} [yes/no]`);

  if (answer !== "yes") {
    say(`OpenCode: restart deferred; ${later}`);

    return;
  }

  if (stale.inside) return "queue";

  progress("restarting OpenCode");

  const pid = await ops.restart(stale);

  say(`OpenCode: restarted; PID ${pid} serves with the current settings`);

  return;
}
