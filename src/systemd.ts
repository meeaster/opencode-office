import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { OfficeError } from "./office.ts";

export const unitDirVariable = "OFFICE_SYSTEMD_USER_DIR";

export function unitDir(): string {
  return process.env[unitDirVariable] ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd/user");
}

export function systemctl(args: string[], { capture = false } = {}): string {
  return execFileSync("systemctl", ["--user", ...args], { encoding: "utf8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" }) ?? "";
}

/** Whether this machine has a systemd user manager; macOS and some WSL setups don't. */
export function hasSystemd(): boolean {
  try {
    execFileSync("systemctl", ["--user", "show", "--property=Version"], { stdio: "ignore" });

    return true;
  } catch {
    return false;
  }
}

export function requireLocalUnit(file: string): void {
  const fragment = systemctl(["show", "--property=FragmentPath", "--value", file], { capture: true }).trim();

  if (fragment !== "" && fragment !== join(unitDir(), file)) throw new OfficeError(`${file} is loaded from ${fragment}; office leaves it alone`);
}

// systemd splits these lines on spaces and expands % specifiers, and ExecStart also $ variables.
export function quoted(text: string): string {
  return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\r", "\\r").replaceAll("\n", "\\n").replaceAll("%", "%%")}"`;
}

export function argument(text: string): string {
  // "$$$$" is the replacement pattern for a literal "$$", systemd's escape for "$".
  return quoted(text).replaceAll("$", "$$$$");
}
