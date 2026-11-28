import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { machineDir, opencodeBin } from "../features/machine/paths.ts";
import { applyAgentServerVersion, inManagedServer, updatePeer } from "../features/opencode/host-server.ts";
import { recordedAgentUpdate } from "../features/opencode/server-units.ts";
import { type Office, OfficeError } from "../office.ts";
import { managedAgentEnvironment } from "../schema.ts";
import { behindSfwVariable } from "../features/tools/sfw.ts";
import { compareVersions } from "../versions.ts";

export const agentUpdateJob = "package.office.update-agent-clis";

// Hold an OS lease across both upgrades and verification. The kernel releases it even if the
// timer is stopped, and it is machine-wide because the two installs belong to the host profile.
async function withUpdateLock(run: () => Promise<number>): Promise<number> {
  const lock = join(machineDir(), "update-agent-clis.lock");

  const lease = Bun.spawn(["/usr/bin/flock", "--nonblock", "--conflict-exit-code", "75", lock, "/bin/sh", "-c", "printf .; /usr/bin/cat >/dev/null"], {
    stdin: "pipe", stdout: "pipe", stderr: "inherit",
  });

  const reader = lease.stdout.getReader();

  try {
    if ((await reader.read()).done) {
      const code = await lease.exited;

      if (code === 75) {
        console.log("office: agent CLI update is already running");

        return 0;
      }

      throw new OfficeError("could not acquire the agent CLI update lock");
    }

    return await run();
  } finally {
    lease.stdin.end();
    reader.releaseLock();
    await lease.exited;
  }
}

function nativeClaude(): string {
  const path = join(homedir(), ".local/bin/claude");
  const versions = join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "claude/versions");

  try {
    if (dirname(realpathSync(path)) === realpathSync(versions)) return path;
  } catch {
    // Missing launcher or versions directory.
  }

  throw new OfficeError("Claude Code needs its native ~/.local/bin/claude launcher for unattended updates");
}

function nativeCodex(): string {
  const launcher = join(homedir(), ".local/bin/codex");
  const current = join(process.env.CODEX_HOME || join(homedir(), ".codex"), "packages/standalone/current");

  for (const entry of ["bin/codex", "codex"]) {
    try {
      if (realpathSync(launcher) === realpathSync(join(current, entry))) return launcher;
    } catch {
      // Standalone releases use one of these two layouts.
    }
  }

  throw new OfficeError("Codex needs its standalone ~/.local/bin/codex launcher for unattended updates");
}

function updateEnvironment(): NodeJS.ProcessEnv {
  const inherit = ["HOME", "PATH", "LANG", "LC_ALL", "USER", "LOGNAME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_RUNTIME_DIR",
    "MISE_CONFIG_DIR", "MISE_DATA_DIR", "MISE_STATE_DIR", "MISE_CACHE_DIR", "CODEX_HOME"];

  const env: NodeJS.ProcessEnv = { ...managedAgentEnvironment, CI: "1" };

  // Updaters don't need provider secrets or caller proxy settings (notably NO_PROXY).
  for (const key of inherit) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }

  return env;
}

async function executeUpdate(envFile: string, programDir: string, command: string[], screened = false): Promise<void> {
  const env = updateEnvironment();

  if (screened) env[behindSfwVariable] = "1";

  const script = '. "$1"; unset HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy; PATH=$2:$PATH; export PATH; shift 2; exec "$@"';

  const child = Bun.spawn(["/bin/sh", "-ec", script, "sh", envFile, programDir, ...command], {
    cwd: "/", env, stdin: "ignore", stdout: "inherit", stderr: "inherit",
  });

  const code = await child.exited;

  if (code !== 0) throw new OfficeError(`native updater exited ${code}`);
}

function openCodeVersion(program: string): string {
  const out = execFileSync(program, ["--version"], { cwd: "/", env: updateEnvironment(), encoding: "utf8", timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] });
  const version = /^(?:opencode )?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)$/i.exec(out.trim())?.[1];

  if (version === undefined) throw new OfficeError("the installed OpenCode did not report a release version");

  return version;
}

/** Manual and timer invocations enter the same locked narrow operation. */
export async function updateAgentClis(office: Office): Promise<number> {
  if (office.opencode.managed === undefined || process.platform !== "linux") throw new OfficeError("agent CLI updates require a managed Linux host");

  if (inManagedServer(office)) throw new OfficeError(`run office cron run ${agentUpdateJob} from a separate terminal, not one owned by the managed server`);

  return withUpdateLock(async () => {
    const launch = recordedAgentUpdate(office);
    const before = await updatePeer(office);

    if (before === undefined) {
      console.log("office: managed OpenCode is stopped; no agent CLI updates");

      return 0;
    }

    let failed = false;

    try {
      const claude = nativeClaude();

      console.log("office: running claude update");
      await executeUpdate(launch.env, dirname(claude), [claude, "update"]);
    } catch (error) {
      console.error(`office: Claude Code update failed: ${error instanceof Error ? error.message : "unknown error"}`);
      failed = true;
    }

    try {
      const codex = nativeCodex();

      console.log("office: running codex update");
      await executeUpdate(launch.env, dirname(codex), [codex, "update"]);
    } catch (error) {
      console.error(`office: Codex update failed: ${error instanceof Error ? error.message : "unknown error"}`);
      failed = true;
    }

    try {
      if (launch.sfw === undefined) throw new OfficeError("recorded Socket Firewall is unavailable; OpenCode is not upgraded without screening");

      if (launch.program !== join(opencodeBin(), "opencode")) throw new OfficeError("OpenCode needs its native ~/.opencode/bin/opencode launcher for unattended updates");

      if (!(await updatePeer(office))) return failed ? 1 : 0;

      console.log("office: running sfw opencode upgrade");
      await executeUpdate(launch.env, dirname(launch.program), [launch.sfw, "opencode", "upgrade"], true);

      const installed = openCodeVersion(launch.program);
      const peer = await updatePeer(office);

      if (peer === undefined) return failed ? 1 : 0;

      if (compareVersions(installed, peer.version) < 0) throw new OfficeError(`installed OpenCode ${installed} is older than the running ${peer.version}; leaving the server alone`);

      if (!peer.owned || peer.version !== installed) await applyAgentServerVersion(office, launch.program, installed, peer);
      else console.log(`office: managed OpenCode ${installed} is already current at PID ${peer.pid}`);
    } catch (error) {
      console.error(`office: OpenCode update failed: ${error instanceof Error ? error.message : "unknown error"}`);
      failed = true;
    }

    return failed ? 1 : 0;
  });
}
