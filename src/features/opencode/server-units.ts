import { basename, dirname } from "node:path";

import { changeText } from "../../lib/change.ts";
import { sha256 } from "../../lib/hash.ts";
import { type Office, OfficeError } from "../../office.ts";
import { say } from "../../report/index.ts";
import { fileState, removeFile } from "../machine/owned-files.ts";
import { envFilePath } from "../machine/paths.ts";
import { claim, consentCommand, type MachineFile, type MachineRecord, ownedElsewhere, type RealFile, removeReceipt, replaceReceipt } from "../machine/record.ts";
import { ownershipProblem, removeUnit, running, type UnitManager, userManager, writeUnit } from "../systemd/user-units.ts";
import { hostLayout } from "../machine/host-env.ts";
import { type ServerPlan, serverUnitPath, userSystemd } from "./host-server.ts";

function managedFile(file: MachineFile): file is RealFile & { service: "opencode" } {
  return file.kind === "file" && file.service === "opencode";
}

/** `down`'s stop of the recorded server unit, which keeps its file and enablement. */
function stopServerFile(file: RealFile): void {
  const unit = basename(file.path);
  const fragment = userSystemd(["show", "--property=FragmentPath", "--value", unit]);

  if (fileState(file) === "changed") throw new OfficeError(`${file.path} changed since office wrote it; office leaves it alone`);

  if (fragment !== "" && fragment !== file.path) throw new OfficeError(`${unit} is loaded from ${fragment}, not the office's file`);

  if (fragment === file.path) userSystemd(["stop", unit]);
}

export function requireServerConsent(office: Office): MachineRecord {
  const current = claim(office);

  if (current.kind === "other") throw new OfficeError(ownedElsewhere(current.record));

  if (current.kind === "free") throw new OfficeError(`managed OpenCode requires consent to manage the machine; run ${consentCommand}`);

  return current.record;
}

/** How the recorded unit compares with `plan`: the same, still the recorded bytes but different (held while it runs), or missing or changed on disk. */
export type ServerUnitMatch = "current" | "pending" | "different";

export function matchesServerUnit(office: Office, plan: ServerPlan): ServerUnitMatch {
  const current = claim(office);
  const file = current.kind === "ours" ? current.record.files.find((entry) => managedFile(entry) && entry.path === plan.path) : undefined;

  if (file?.kind !== "file" || fileState(file) !== "present") return "different";

  return file.sha256 === sha256(plan.text) ? "current" : "pending";
}

/** The recorded launch paths, unchanged on disk. The updater does not plan or rewrite the unit. */
export function recordedAgentUpdate(office: Office) {
  const { files } = requireServerConsent(office);
  const server = files.find((file) => managedFile(file) && file.path === serverUnitPath(office));
  const env = files.find((file) => file.path === envFilePath() && file.kind === "file");
  const sfw = files.find((file) => file.path === hostLayout("").sfw && file.kind === "file");

  if (server?.kind !== "file" || server.program === undefined || fileState(server) !== "present") throw new OfficeError("the managed OpenCode unit needs to match the machine record; run office up first");

  if (env === undefined || fileState(env) !== "present") throw new OfficeError("the host environment needs to match the machine record; run office sync first");

  let screened: string | undefined;

  try {
    if (office.socketFirewall && sfw !== undefined && fileState(sfw) === "present") screened = sfw.path;
  } catch {
    // Clause applies to OpenCode only; an unreadable firewall must not prevent Claude's update.
  }

  return { program: server.program, env: env.path, sfw: screened };
}

/** What `writeServerUnit` did: nothing to write, wrote and reloaded, or held a changed definition while the unit runs. */
export type ServerUnitWrite = "unchanged" | "written" | "held";

/**
 * Brings the managed server's unit file to `plan` through the one unit writer, its hash recorded in
 * the machine record. A running unit keeps its definition until `upgrade`; a written one is reloaded.
 */
export function writeServerUnit(office: Office, plan: ServerPlan, { upgrade, manager = userManager }: { upgrade: boolean; manager?: UnitManager }): ServerUnitWrite {
  const record = requireServerConsent(office);
  const env = record.files.find((file) => file.path === envFilePath());

  if (env === undefined || fileState(env) !== "present") throw new OfficeError(`managed OpenCode needs the recorded environment file at ${envFilePath()}; run office sync`);
  const previous = record.files.find((entry) => entry.path === plan.path);

  if (previous !== undefined && !managedFile(previous)) throw new OfficeError(`${plan.path} isn't recorded as the managed OpenCode service`);
  const state = manager.state(plan.unit);
  const problem = ownershipProblem(dirname(plan.path), basename(plan.path), previous?.sha256, state);

  if (problem !== undefined) throw new OfficeError(problem);
  const present = previous !== undefined && fileState(previous) === "present";
  const file: RealFile = { kind: "file", path: plan.path, package: null, service: "opencode", program: plan.program, sha256: sha256(plan.text) };
  const recordFile = () => replaceReceipt(record, file, previous);

  if (present && previous.sha256 === file.sha256) {
    if (previous.program !== file.program) recordFile();

    return "unchanged";
  }

  if (present && running(state) && !upgrade) return "held";
  writeUnit(manager, dirname(plan.path), basename(plan.path), plan.text, { record: recordFile });
  say(`${previous === undefined ? "wrote" : "updated"} ${file.path}`, "office: ");

  return "written";
}

/** Removes the recorded server unit through the writer: stopped, disabled and deleted while it is the recorded bytes. */
export function removeServerFile(file: MachineFile, missing: boolean): boolean {
  if (!managedFile(file)) return false;

  const name = basename(file.path);
  const state = userManager.state(name);
  const problem = ownershipProblem(dirname(file.path), name, file.sha256, state);

  if (problem !== undefined) throw new OfficeError(problem);

  if (!missing) {
    removeUnit(userManager, dirname(file.path), name);

    return true;
  }

  if (state.fragment === file.path) userManager.run(["stop", name]);
  userManager.run(["daemon-reload"]);

  return true;
}

export function stopRecordedServer(office: Office): void {
  const current = claim(office);

  if (current.kind !== "ours") return;

  for (const file of current.record.files) {
    if (managedFile(file)) stopServerFile(file);
  }
}

/** `up` reconciles an installed server even when the option has just been removed. */
export function removeUnwantedServer(office: Office): void {
  const current = claim(office);

  if (current.kind !== "ours") return;

  let record = current.record;

  for (const file of current.record.files) {
    if (!managedFile(file) || isCurrentServerUnit(office, file)) continue;

    const result = removeFile(file, obsoleteServerReason, removeServerFile);

    if (!result.removed) throw new OfficeError(result.line === undefined ? undefined : changeText(result.line));

    record = removeReceipt(record, file);

    if (result.line !== undefined) say(changeText(result.line));
  }
}

const obsoleteServerReason = "as office no longer manages this OpenCode unit";

export function serverRemovalReason(file: MachineFile): string | undefined {
  return managedFile(file) ? obsoleteServerReason : undefined;
}

export function isCurrentServerUnit(office: Office, file: MachineFile): boolean {
  return managedFile(file) && office.opencode.managed !== undefined && file.path === serverUnitPath(office);
}
