// `office env`: prints the office's environment file, the PATH entries and plain variables agents
// and the user's terminal share (src/features/tools/sfw.ts). With --container it is the container's, which the
// entrypoint writes at start (and the image at build, for an office it can't read yet).
import { type Office } from "../office.ts";
import { defaultReleaseAge } from "../schema.ts";
import { containerEnvFile, containerEnvironment } from "../features/tools/sfw.ts";
import { envScript } from "../features/machine/host-env.ts";

/** The container's environment file for `office` (undefined: the defaults, the firewall on and a three-day age). */
export function containerEnvText(office: Office | undefined): string {
  const what = office === undefined ? "the environment of an office's opencode container" : `the environment of office ${office.name}'s opencode container`;

  return envScript(what, containerEnvFile, containerEnvironment(office?.socketFirewall ?? true, office?.tools.minimumReleaseAge ?? defaultReleaseAge));
}
