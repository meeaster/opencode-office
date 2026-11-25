// `office bump`: selects the desired release of each mise tool the packages require
// (standard/tools/selection.ts) and records it in office.lock. It installs nothing and changes no
// active mise file; it runs the office's pinned mise only behind the office's Socket Firewall.
import { attestation, firewalledMise, spawnRun, type ToolsRun } from "../../standard/tools/host.ts";
import { selectTools, type Run } from "../../standard/tools/selection.ts";
import { gatherPackages, problemLines } from "../gather.ts";
import { type Office, OfficeError } from "../office.ts";

/** The office's pinned mise behind its Socket Firewall; throws, asking mise nothing, when that can't run. */
function protectedMise(office: Office): ToolsRun {
  const firewalled = firewalledMise(office);

  if (!firewalled.ok) throw new OfficeError(`office bump asked mise nothing: ${firewalled.reason}`);

  return firewalled.tools;
}

/** Runs the selection for the office's packages, with `mise` as the whole mise command when given; returns its lines, and whether office.lock was written. */
export async function bump(office: Office, { mise, run = spawnRun() }: { mise?: readonly string[]; run?: Run } = {}): Promise<{ ok: boolean; lines: string[] }> {
  if (office.opencode.mode !== "host") throw new OfficeError("office bump selects the host tools packages require; this office runs OpenCode in its container (opencode: container)");
  const gathered = await gatherPackages(office, { machine: true });

  if (!gathered.complete) throw new OfficeError(`packages didn't load, so no release was selected: ${problemLines(gathered.problems).join("; ") || `not loaded: ${[...gathered.unread].join(", ")}`}; fix them and run office sync, then office bump`);

  if (mise !== undefined) return selectTools(office, gathered.packages, { mise, run, env: process.env });
  const tools = protectedMise(office);
  const selection = selectTools(office, gathered.packages, { ...tools.inputs, run, env: process.env });

  return { ok: selection.ok, lines: [attestation(tools), ...selection.lines] };
}
