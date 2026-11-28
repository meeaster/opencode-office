import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Office } from "../../office.ts";
import { officeCommand } from "../../tool.ts";
import { machineDir, machineRecordPath, miseShims } from "../machine/paths.ts";
import { argument, quoted } from "./systemd.ts";

/** The unit lines for running a package script with the verified machine environment. */
export function packageLaunch(office: Office, dir: string, script: string): string {
  const command = officeCommand();
  const home = homedir();
  const path = [...new Set([dirname(command), join(home, ".local/bin"), resolve(miseShims()), resolve(process.env.BUN_INSTALL || join(home, ".bun"), "bin")])].join(":");
  // Capture profile directories; the user manager supplies the fallback PATH.
  const profile = [`HOME=${home}`, `OFFICE_MACHINE_RECORD=${resolve(machineRecordPath())}`, `OFFICE_MACHINE_DIR=${resolve(machineDir())}`, "MISE_AUTO_INSTALL=0", "MISE_NOT_FOUND_AUTO_INSTALL=0"];

  for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "MISE_CONFIG_DIR", "MISE_DATA_DIR", "MISE_STATE_DIR", "MISE_CACHE_DIR", "CODEX_HOME"]) {
    const value = process.env[key];

    if (value) profile.push(`${key}=${resolve(value)}`);
  }

  const setup = [
    'export PATH="$1:$PATH"',
    '[[ -x "$2" ]] || { echo "Office launcher missing: $2; restore it or run office up --upgrade from its new location" >&2; exit 127; }',
    'env_script=$("$2" --office "$3" env host-service "$4") || { echo "Cannot load host service environment; check the machine record and run office up --upgrade with a compatible launcher" >&2; exit 1; }',
    'source /dev/stdin <<< "$env_script"',
    'export MISE_AUTO_INSTALL=0 MISE_NOT_FOUND_AUTO_INSTALL=0',
    'cd -- "$5"',
    'exec /bin/bash "$6"',
  ].join("; ");

  const args = ["/bin/bash", "-ec", setup, "office", path, command, office.dir, office.name, dir, script];

  return [...profile.map(value => `Environment=${quoted(value)}`), `ExecStart=${args.map(argument).join(" ")}`].join("\n");
}
