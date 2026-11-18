// `office shell` and `office exec`: a shell, or one command, in the running opencode container as
// its user, in the container folder matching the one they were run from, with the container's
// persistent home, mise's tools and the office's environment (the Socket Firewall wrappers first on
// PATH). They never start or rebuild anything.
import { isAbsolute, relative, resolve } from "node:path";

import { containerOfficeDir, type Office, OfficeError } from "../office.ts";
import { containerEnvFile } from "../sfw.ts";
import { compose, composeAttached } from "./compose.ts";

/** The container folder for a host folder: the same place in the office, else the office root. */
export function containerFolder(office: Office, folder: string): string {
  const inside = relative(office.dir, resolve(folder));

  return inside === "" || inside.startsWith("..") || isAbsolute(inside) ? containerOfficeDir : `${containerOfficeDir}/${inside}`;
}

/** Runs `command` (default: an interactive bash) in the opencode container; returns its exit status. */
export function runInContainer(office: Office, command: string[] | undefined, folder = process.cwd()): number {
  if (office.opencode.mode === "host") {
    throw new OfficeError(`in host mode OpenCode runs on this machine (${office.opencode.url}), so there is no opencode container: run commands here directly, in ${office.dir}`);
  }

  const running = compose(office, ["ps", "--status", "running", "--format", "{{.Service}}"], { capture: true }).split("\n");

  if (!running.includes("opencode")) throw new OfficeError(`the ${office.name} office's opencode container isn't running; start it with office up`);

  // A terminal only when both ends are one, so piped output carries no terminal codes.
  const terminal = process.stdin.isTTY && process.stdout.isTTY;

  // bash, not a login shell: Debian's /etc/profile would replace the PATH that puts mise's shims
  // first. docker exec skips the entrypoint, so the command sources the environment file it wrote.
  const run = ["sh", "-c", `. ${containerEnvFile} 2>/dev/null; exec "$@"`, "sh", ...(command ?? ["bash"])];

  return composeAttached(office, ["exec", ...(terminal ? [] : ["-T"]), "--user", "office", "--workdir", containerFolder(office, folder), "opencode", ...run]);
}
