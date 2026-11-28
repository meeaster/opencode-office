import { homedir } from "node:os";
import { join } from "node:path";

/** Replace the machine record's path for tests and scratch offices. */
export const machineRecordVariable = "OFFICE_MACHINE_RECORD";

/** The machine record: `$OFFICE_MACHINE_RECORD`, else `$XDG_DATA_HOME/office/machine.json`. */
export function machineRecordPath(): string {
  return process.env[machineRecordVariable] || join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "office/machine.json");
}

export const machineDirVariable = "OFFICE_MACHINE_DIR";

/** The home folder: `$HOME` first, as the shells that source the environment file read it. */
export function home(): string {
  return process.env.HOME || homedir();
}

/** The office tool's data folder on this machine: `$OFFICE_MACHINE_DIR`, else `$XDG_DATA_HOME/office`. */
export function machineDir(): string {
  return process.env[machineDirVariable] || join(process.env.XDG_DATA_HOME || join(home(), ".local/share"), "office");
}

/** The environment file the user's shell (and, later, the server's unit) sources. */
export function envFilePath(): string {
  return join(machineDir(), "env.sh");
}

/** mise's shims on this machine, as mise finds its data folder. */
export function miseShims(): string {
  return join(process.env.MISE_DATA_DIR || join(process.env.XDG_DATA_HOME || join(home(), ".local/share"), "mise"), "shims");
}

/** Where OpenCode's installer puts the `opencode` command. */
export function opencodeBin(): string {
  return join(home(), ".opencode/bin");
}
