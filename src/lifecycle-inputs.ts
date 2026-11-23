// What the kernel gives a package's lifecycle functions and commands besides its settings and
// registries: the office as the SDK describes it, and the host helpers scoped to the package; and
// how it reads what `sync`, `up` and `down` return.
import * as v from "valibot";

import type { Host, OfficeInfo } from "../sdk/index.ts";
import { type Office, OfficeError } from "./office.ts";
import { hostTimers } from "./timers.ts";
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
