// What the kernel gives a package's lifecycle functions and commands besides its settings and
// registries: the office as the SDK describes it, and the host helpers scoped to the package; and
// how it reads what `sync`, `up` and `down` return.
import * as v from "valibot";

import type { Host, OfficeInfo, SyncInputs } from "../sdk/index.ts";
import { executorAccess } from "./executor.ts";
import { updateExcludedOrThrow } from "./exclude-plumbing.ts";
import type { Gathered } from "./gather.ts";
import { type Office, OfficeError } from "./office.ts";
import { hostTimers } from "./timers.ts";
import { containerRuntimeFolders, pinnedRuntimeFolders } from "../standard/tools/host.ts";
import { officeMise } from "../standard/tools/registry.ts";
import { officeCommand } from "./tool.ts";

/** The office's mode as packages see it: managed host is host mode with office managing the server. */
export function officeMode(office: Pick<Office, "opencode">): OfficeInfo["mode"] {
  if (office.opencode.mode === "container") return "container";

  return office.opencode.managed === undefined ? "host" : "managed-host";
}

/** The office a package's function gets: a fresh object each call, so one package can't change another's. */
export function officeInfo(office: Pick<Office, "dir" | "name" | "opencode">): OfficeInfo {
  return { dir: office.dir, name: office.name, mode: officeMode(office), launcher: officeCommand() };
}

/** The host helpers of package `name`; for `check`, which only reports, `set` and `clear` throw. */
export function packageHost(office: Office, name: string, { readOnly = false } = {}): Host {
  const timers = hostTimers(office, name);

  if (!readOnly) return { timers };
  const refuse = () => { throw new OfficeError(`package ${name}: check only reports; it can't change host timers`); };

  return { timers: { set: refuse, clear: refuse, status: timers.status } };
}

/** What `sync`, `up` and `down` may return: lines, or nothing. */
const returnedLines = v.optional(v.array(v.string()));

/**
 * Calls package `name`'s `phase` function: its lines, each under the package's name, or the
 * problem naming the package when it threw or returned something other than lines.
 */
export async function packageLines(name: string, phase: "sync" | "up" | "down", call: () => readonly string[] | void | Promise<readonly string[] | void>): Promise<{ ok: true; lines: string[] } | { ok: false; problem: string }> {
  let returned: unknown;

  try {
    returned = await call();
  } catch (error) {
    return { ok: false, problem: `package ${name}: its ${phase} failed: ${error instanceof Error ? error.message : String(error)}` };
  }

  const lines = v.safeParse(returnedLines, returned);

  if (!lines.success) return { ok: false, problem: `package ${name}: its ${phase} returned something other than a list of lines` };

  return { ok: true, lines: (lines.output ?? []).map(line => `package ${name}: ${line}`) };
}

/**
 * The runtimes a package's up gets: in a host-mode office only those the office's pinned mise
 * resolves, never PATH's; in a container-mode office those on PATH, which only the container's own
 * process may use, so a caller decides first that it runs there (the skills package's runner does).
 */
export function upRuntimes(office: Pick<Office, "dir" | "opencode" | "tools">, env: Readonly<Record<string, string | undefined>> = process.env, mise = () => officeMise(office).path): readonly string[] {
  return office.opencode.mode === "container" ? containerRuntimeFolders(env) : pinnedRuntimeFolders(office, mise(), env);
}

type HookRun = ({ phase: "sync" } & Pick<SyncInputs, "exclude" | "updateExcluded">) | { phase: "up"; starting: (name: string) => void };

export async function* runPackageHooks(office: Office, gathered: Pick<Gathered, "entries" | "packages">, run: HookRun) {
  for (const { entry: { name }, manifest, settings } of gathered.packages) {
    if (!manifest[run.phase]) continue;
    if (run.phase === "up") run.starting(name);

    yield await packageLines(name, run.phase, () => {
      const inputs = { office: officeInfo(office), entries: gathered.entries, settings: structuredClone(settings) };

      return run.phase === "sync" ? manifest.sync?.({ ...inputs, exclude: run.exclude, updateExcluded: run.updateExcluded }) : manifest.up?.({ ...inputs, host: packageHost(office, name), executor: executorAccess(office), runtimes: () => upRuntimes(office), updateExcluded: change => updateExcludedOrThrow(office, change) });
    });
  }
}
