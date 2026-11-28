// Packages' native systemd user units (`systemd.userUnits.add` from `@office/systemd`) in a
// host-mode office. Each unit is `office-<office>-pkg-<package>.<id>.service`; its text is the
// package's own, shipped or rendered here from the office's and machine's facts.
//
// One receipt per destination in the office's state (`<state>/systemd/<unit>.json`) records its
// owner, the SHA-256 of the bytes office wrote (the writer's hash: src/features/systemd/user-units.ts), and the
// revision last verified ready with the systemd invocation that served it: those bytes with the
// identities of the tools and files the unit names in `restartWhenChanged`. So:
//
// - Plain `up` installs and starts a missing or stopped unit, leaves a running current one alone
//   (no reload, no restart), and reports a running unit whose definition or launch inputs changed,
//   or whose invocation isn't the verified one (systemd or someone else restarted it), or whose
//   unchanged file systemd needs to reload; `--upgrade` reloads that one and checks it again, no restart.
// - `up --upgrade` writes a changed definition and reloads before restarting; a change to launch
//   inputs alone restarts without rewriting the unit or reloading, unless systemd still needs one.
// - The receipt drops its verified revision before office starts or restarts a unit. A unit is
//   ready once systemd runs a new main process from exactly the recorded file, with no drop-in or
//   pending reload, and the package's probe, if any, answers that same process; only then does
//   its receipt take the new revision and invocation.
// - A unit whose tool isn't the verified applied release is held when running and refused otherwise.
// - A unit no package wants any more, every unit on `office down`, and every unit outside host mode
//   is stopped, disabled and removed.
//
// Ownership is checked for every destination before anything changes; one problem stops the run.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import * as v from "valibot";

import { type UnitFacts, type UnitToolClaim, type UserUnit, userUnits } from "../../../packages/systemd/handles.ts";
import { activeBin, readRecord, resolveIn, type AppliedRecord } from "../../../packages/tools/applied.ts";
import type { Entries } from "../../../sdk/index.ts";
import type { MachineClaims } from "../mise-integration/projection.ts";
import { officeInfo } from "../../lifecycle-inputs.ts";
import { type Office, OfficeError } from "../../office.ts";
import { packageLaunch } from "./package-host-services.ts";
import { check } from "../../parse.ts";
import { atomicWrite } from "../../lib/atomic-write.ts";
import { unitDir } from "./systemd.ts";
import { activationProblem, enableUnit, installProblem, ownershipProblem, removeUnit, running, type UnitManager, unitPresent, unitSha256, type UnitState, userManager, writeUnit } from "./user-units.ts";
import { toolsState } from "../tools/applied.ts";

/** A destination's receipt: who owns it, the bytes office wrote, and the revision last verified ready, with the invocation that served it. */
export type Receipt = { owner: string; sha256: string; applied?: string; invocation?: string };

const sha256Text = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));
const receiptSchema = v.strictObject({ owner: v.string(), sha256: sha256Text, applied: v.optional(sha256Text), invocation: v.optional(v.pipe(v.string(), v.nonEmpty())) });

/** How long a started unit gets to serve. */
type Patience = { attempts: number; interval: number };

const patience: Patience = { attempts: 60, interval: 500 };

/** What the lifecycle runs against; tests give a fake manager and short patience. */
export type UnitsRun = { manager?: UnitManager; patience?: Patience };

/** What the units read of a gathered package: its name, folder, legacy host services and tool claims. */
export type UnitPackage = {
  readonly entry: { readonly name: string };
  readonly dir: string;
  readonly manifest: { readonly host?: { readonly services?: Readonly<Record<string, { readonly script: string }>> } };
  readonly claims: Pick<MachineClaims, "required" | "provided">;
};

/** What the units read of a gathering: the registries' entries and the packages whose setup ran. */
export type UnitInputs = { readonly entries: Entries; readonly packages: readonly UnitPackage[] };

/** A unit a selected package declares, before rendering. */
type Declared = { owner: string; name: string; dir: string; unit: UserUnit };

/** A declared unit rendered: its text, the identity of its launch inputs, and the revision both make. */
type Desired = Declared & { text: string; sha256: string; revision: string; facts: UnitFacts };

function unitName(office: Pick<Office, "name">, owner: string, id: string): string {
  return `office-${office.name}-pkg-${owner}.${id}.service`;
}

function receiptsDir(office: Pick<Office, "state">): string {
  return join(office.state, "systemd");
}

function receiptFolder(office: Pick<Office, "state">): string | undefined {
  const dir = receiptsDir(office);
  const info = lstatSync(dir, { throwIfNoEntry: false });

  if (info === undefined) return undefined;

  if (!info.isDirectory()) throw new OfficeError(`${dir} is a link or not a folder, so office doesn't read unit receipts through it; move it aside`);

  return dir;
}

/** The package a receipt file names, when it is a unit receipt of this office's namespace. */
function receiptOwner(office: Pick<Office, "name">, file: string): string | undefined {
  const prefix = `office-${office.name}-pkg-`;

  if (!file.startsWith(prefix)) return undefined;

  return /^([a-z0-9][a-z0-9-]*)\.[a-z0-9][a-z0-9-]{0,47}\.service\.json$/.exec(file.slice(prefix.length))?.[1];
}

/**
 * Every receipt in the office's state, by unit name. Anything else in the folder, a receipt outside
 * this office's package namespace, one that isn't a regular file, or one naming another owner than
 * its name, stops the caller before it reaches any unit.
 */
export function readReceipts(office: Pick<Office, "name" | "state">): Map<string, Receipt> {
  const dir = receiptFolder(office);
  const receipts = new Map<string, Receipt>();

  if (dir === undefined) return receipts;

  for (const file of readdirSync(dir)) {
    const path = join(dir, file);
    const owner = receiptOwner(office, file);

    if (owner === undefined) throw new OfficeError(`${path} isn't a receipt of a unit of office ${office.name}'s packages; move it aside`);

    if (!lstatSync(path).isFile()) throw new OfficeError(`${path} is a link or not a regular file; move it aside`);
    let parsed;

    try {
      parsed = check(v.safeParse(receiptSchema, JSON.parse(readFileSync(path, "utf8"))));
    } catch {
      parsed = undefined;
    }

    if (parsed === undefined || !parsed.ok || parsed.value.owner !== owner) throw new OfficeError(`${path} isn't a unit receipt office can read; restore it or move it aside`);
    receipts.set(file.slice(0, -".json".length), parsed.value);
  }

  return receipts;
}

function saveReceipt(office: Pick<Office, "name" | "state">, name: string, receipt: Receipt): void {
  receiptFolder(office);
  atomicWrite(join(receiptsDir(office), `${name}.json`), `${JSON.stringify(receipt, null, 2)}\n`);
}

function dropReceipt(office: Pick<Office, "state">, name: string): void {
  rmSync(join(receiptsDir(office), `${name}.json`), { force: true });
}

function packageFile(dir: string, file: string, what: string): string {
  const path = join(dir, file);

  if (!statSync(path, { throwIfNoEntry: false })?.isFile() || relative(realpathSync(dir), realpathSync(path)).startsWith("..")) throw new OfficeError(`${what}: ${file} must be a file inside the package`);

  return path;
}

function declaresTool(item: UnitPackage, tool: UnitToolClaim): boolean {
  const { required, provided } = item.claims;
  const covers = (bin: readonly string[]) => tool.bin.every(name => bin.includes(name));

  return required.some(claim => claim.name === tool.name && claim.minimum === tool.minimum && covers(claim.bin))
    || provided.some(claim => claim.name === tool.name && tool.minimum === undefined && covers(claim.bin));
}

/** The units packages declare, and a problem for each declaration office can't use. */
type Declarations = { units: Declared[]; problems: string[] };

/** The units the office's packages declare. Only a host-mode office has any. */
function declaredUnits(office: Office, gathered: UnitInputs): Declarations {
  const units: Declared[] = [];
  const problems: string[] = [];

  if (office.opencode.mode !== "host") return { units, problems };

  for (const { value, owner } of gathered.entries(userUnits)) {
    const item = gathered.packages.find(found => found.entry.name === owner);
    const name = unitName(office, owner, value.id);

    if (item === undefined) continue;

    if (item.manifest.host?.services?.[value.id] !== undefined) problems.push(`package ${owner}: user unit ${value.id} and host.services.${value.id} both want ${name}; keep one`);

    for (const tool of value.tools) {
      if (!declaresTool(item, tool)) problems.push(`package ${owner}: user unit ${value.id} restarts with tool ${tool.name}, which the package doesn't require or provide with that handle; pass the handle its tools.require or tools.provide returned`);
    }

    units.push({ owner, name, dir: item.dir, unit: value });
  }

  return { units, problems };
}

function resolveTool(record: AppliedRecord, folder: string, tool: UnitToolClaim, bin: string) {
  const name = record.tools[tool.name] === undefined ? Object.keys(record.tools).find(key => record.tools[key].names.includes(tool.name)) : tool.name;
  const applied = name === undefined ? undefined : record.tools[name];

  if (applied === undefined) return { status: "missing" } as const;

  return resolveIn(record, { name: tool.name, minimum: tool.minimum ?? applied.version, bin }, folder);
}

function facts(office: Office, declared: Declared): UnitFacts {
  const what = `user unit ${declared.unit.id} of package ${declared.owner}`;

  return {
    office: officeInfo(office),
    dir: declared.dir,
    launch: script => (packageFile(declared.dir, script, what), packageLaunch(office, declared.dir, script)),
    executable(tool, bin = tool.bin[0]) {
      if (!declared.unit.tools.some(claim => claim.name === tool.name && claim.bin.includes(bin))) throw new OfficeError(`${what}: tool ${tool.name}'s ${bin} isn't in its restartWhenChanged`);

      return join(activeBin(toolsState(office)), bin);
    },
  };
}

/**
 * Renders a declared unit and measures its launch inputs; a problem when a tool isn't the verified
 * applied release or a file is missing, or, `refused` even while the unit runs, when the text reaches other units.
 */
async function render(office: Office, declared: Declared): Promise<{ ok: true; desired: Desired } | { ok: false; problem: string; refused?: true }> {
  const what = `user unit ${declared.unit.id} of package ${declared.owner}`;
  const { unit, dir } = declared;
  const inputs: string[][] = [];

  try {
    if (unit.tools.length > 0) {
      const folder = toolsState(office);
      const record = readRecord(folder);

      for (const tool of unit.tools) {
        for (const bin of tool.bin) {
          const resolved = resolveTool(record, folder, tool, bin);

          if (resolved.status === "drifted") return { ok: false, problem: `${what}: ${resolved.message}` };

          if (resolved.status !== "ready") return { ok: false, problem: `${what}: tool ${tool.name} is ${resolved.status === "upgrade-pending" ? `${resolved.version}, below ${tool.minimum}` : "not applied"} yet; office up installs it` };
          inputs.push(["tool", tool.name, bin, resolved.identity]);
        }
      }
    }

    for (const file of unit.files) inputs.push(["file", file, unitSha256(readFileSync(packageFile(dir, file, what)))]);
    const known = facts(office, declared);
    const renderer = unit.render === undefined ? undefined : userUnits.functions(unit.render)?.render;

    if (unit.render !== undefined && renderer === undefined) return { ok: false, problem: `${what}: its renderer isn't in this process; declare it with systemd.userUnits.add` };
    const text = renderer === undefined ? readFileSync(packageFile(dir, unit.file ?? "", what), "utf8") : renderer(known);

    if (text.trim() === "" || text.includes("\0")) return { ok: false, problem: `${what}: its unit text must be the unit file's contents` };
    const broadens = installProblem(text);

    if (broadens !== undefined) return { ok: false, problem: `${what}: ${broadens}`, refused: true };
    const sha256 = unitSha256(text);

    return { ok: true, desired: { ...declared, text, sha256, revision: unitSha256(JSON.stringify([sha256, inputs])), facts: known } };
  } catch (error) {
    return { ok: false, problem: `${what}: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * Refuses, before anything changes, the declarations office can't use (`problems`) and every
 * destination it doesn't own: the units declared and those the receipts hold.
 */
function refuseUnowned(manager: UnitManager, declared: readonly Declared[], receipts: ReadonlyMap<string, Receipt>, problems: readonly string[]): void {
  const dir = unitDir();
  const names = new Map<string, string | undefined>([...receipts.keys()].map(name => [name, undefined]));
  const refused = [...problems];

  for (const unit of declared) names.set(unit.name, unit.owner);

  for (const [name, owner] of names) {
    const receipt = receipts.get(name);

    if (owner !== undefined && receipt !== undefined && receipt.owner !== owner) {
      refused.push(`${name} belongs to package ${receipt.owner}, not ${owner}`);
      continue;
    }

    const problem = ownershipProblem(dir, name, receipt?.sha256, manager.state(name));

    if (problem !== undefined) refused.push(problem);
  }

  if (refused.length > 0) throw new OfficeError(`packages' user units: ${refused.join("; ")}`);
}

/** The units declared and the receipts held, once `refuseUnowned` let them through. */
function admit(office: Office, gathered: UnitInputs, manager: UnitManager) {
  const { units, problems } = declaredUnits(office, gathered);
  const receipts = readReceipts(office);

  refuseUnowned(manager, units, receipts, problems);

  return { units, receipts };
}

/** What `up` refuses before it starts any service: declarations office can't use and destinations it doesn't own. */
export function precheckUnits(office: Office, gathered: UnitInputs, { manager = userManager }: UnitsRun = {}): void {
  admit(office, gathered, manager);
}

/** Whether the package's probe, if any, says the unit's main process `pid` serves; a probe that throws says no. */
async function serves(unit: UserUnit, pid: number, known: UnitFacts): Promise<boolean> {
  const probe = unit.ready === undefined ? undefined : userUnits.functions(unit.ready)?.ready;

  if (probe === undefined) return unit.ready === undefined;

  try {
    return await probe({ pid, facts: known }) === true;
  } catch {
    return false;
  }
}

/** The main process a look verified, by PID and systemd invocation. */
type Served = { pid: number; invocation: string };

/**
 * One look at `desired`: its main process when systemd runs it from exactly the recorded file, with
 * no drop-in or pending reload, under an invocation `accepts` takes, and the package's probe, if any,
 * says serves; undefined unless a second look finds the same process and invocation.
 */
async function observe(manager: UnitManager, desired: Desired, accepts: (invocation: string) => boolean): Promise<Served | undefined> {
  const path = join(unitDir(), desired.name);
  const settled = (state: UnitState) => state.active === "active" && state.pid > 0 && state.invocation !== "" && !state.stale && state.fragment === path && state.dropIns === "";
  const state = manager.state(desired.name);

  if (!settled(state) || !accepts(state.invocation) || !await serves(desired.unit, state.pid, desired.facts)) return undefined;
  const after = manager.state(desired.name);

  return settled(after) && after.pid === state.pid && after.invocation === state.invocation ? { pid: state.pid, invocation: state.invocation } : undefined;
}

/** Looks until `observe` verifies the unit; undefined when it fails or doesn't in time. */
async function ready(manager: UnitManager, desired: Desired, accepts: (invocation: string) => boolean, wait: Patience): Promise<Served | undefined> {
  for (let attempt = 0; attempt < wait.attempts; attempt++) {
    const served = await observe(manager, desired, accepts);

    if (served !== undefined) return served;

    if (manager.state(desired.name).active === "failed") return undefined;

    await Bun.sleep(wait.interval);
  }

  return undefined;
}

/** What one unit's step said, and which of `Reconciled`'s lists it goes in: done (and verified ready), pending an upgrade, or the failure. */
type Step = [keyof Reconciled, string];

/**
 * Why a running unit isn't current: its definition changed, its launch inputs differ from the
 * revision last verified (`applied`), or no verified revision vouches for its process.
 */
function pendingDetail(pid: number, changed: boolean, applied: string | undefined, revision: string): string {
  if (changed || (applied !== undefined && applied !== revision)) return `its ${changed ? "definition" : "launch inputs"} changed while it runs as PID ${pid}; office up --upgrade applies them`;

  return `it runs as PID ${pid}, a process office didn't start and verify; office up --upgrade restarts and verifies it`;
}

/** What a running, verified unit that only awaits systemd's reload of its unchanged file says. */
function staleDetail(pid: number): string {
  return `systemd needs a reload of its unchanged definition while it runs as PID ${pid}; office up --upgrade reloads it and checks it again`;
}

/** Brings one rendered unit to its desired state, as the module comment says. */
async function apply(office: Office, manager: UnitManager, desired: Desired, receipt: Receipt | undefined, { upgrade, wait }: { upgrade: boolean; wait: Patience }): Promise<Step> {
  const dir = unitDir();
  const state = manager.state(desired.name);
  const changed = receipt === undefined || receipt.sha256 !== desired.sha256 || !unitPresent(dir, desired.name);
  const current = !changed && receipt.applied === desired.revision && receipt.invocation === state.invocation;
  const up = running(state);

  if (up && current) {
    // Systemd's view is stale though the file is office's bytes (touched, or a drop-in removed): only --upgrade reloads, then checks again.
    if (state.stale && !upgrade) return ["pending", `${desired.name}: ${staleDetail(state.pid)}`];

    if (state.enabled !== "enabled") enableUnit(manager, desired.name);
    else if (state.stale) manager.run(["daemon-reload"]);
    const problem = activationProblem(dir, desired.name, desired.sha256, manager.state(desired.name));

    if (problem !== undefined) return ["failed", problem];
    const served = await ready(manager, desired, invocation => invocation === receipt.invocation, wait);

    return served === undefined ? ["failed", unready(desired.name, manager.state(desired.name))] : ["lines", `${desired.name}: unchanged, ready as PID ${served.pid}`];
  }

  if (up && !upgrade) return ["pending", `${desired.name}: ${pendingDetail(state.pid, changed, receipt?.applied, desired.revision)}`];

  const enable = state.enabled !== "enabled";
  // Before anything starts, the receipt stops vouching for a process: only a verified one gets it back.
  const unverified: Receipt = { owner: desired.owner, sha256: desired.sha256 };

  if (changed) writeUnit(manager, dir, desired.name, desired.text, { enable, record: sha256 => saveReceipt(office, desired.name, { ...unverified, sha256 }) });
  else {
    saveReceipt(office, desired.name, unverified);

    if (enable) enableUnit(manager, desired.name);
    else if (state.stale) manager.run(["daemon-reload"]);
  }

  const problem = activationProblem(dir, desired.name, desired.sha256, manager.state(desired.name));

  if (problem !== undefined) return ["failed", problem];
  manager.run([up ? "restart" : "start", desired.name]);
  const served = await ready(manager, desired, invocation => !up || invocation !== state.invocation, wait);

  if (served === undefined) return ["failed", unready(desired.name, manager.state(desired.name))];
  saveReceipt(office, desired.name, { ...unverified, applied: desired.revision, invocation: served.invocation });

  return ["lines", `${desired.name}: ${up ? "restarted" : "started"}${changed ? " with its new definition" : ""}, ready as PID ${served.pid}`];
}

function unready(name: string, state: UnitState): string {
  return `${name} is ${state.active}${state.pid > 0 ? ` as PID ${state.pid}` : ""}${state.stale ? ", with a reload pending," : ""} but not ready; its change stays pending; see journalctl --user -u ${name}`;
}

/** What `up`'s part did and verified, what waits for `--upgrade` or a verified tool, and what failed; any failure fails up after the rest is said. */
export type Reconciled = { lines: string[]; pending: string[]; failed: string[] };

/** `up`'s part, after the shared tools staged: removes units no package wants, then installs, holds or upgrades the rest. */
export async function reconcileUnits(office: Office, gathered: UnitInputs, { upgrade, manager = userManager, patience: wait = patience }: UnitsRun & { upgrade: boolean }): Promise<Reconciled> {
  const { units, receipts } = admit(office, gathered, manager);
  const result: Reconciled = { lines: [], pending: [], failed: [] };

  for (const name of receipts.keys()) {
    if (units.some(unit => unit.name === name)) continue;

    try {
      removeUnit(manager, unitDir(), name);
      dropReceipt(office, name);
      result.lines.push(`${name}: removed, as no package wants it`);
    } catch (error) {
      result.failed.push(error instanceof Error ? error.message : String(error));
    }
  }

  for (const declared of units) {
    const rendered = await render(office, declared);

    if (!rendered.ok) {
      if (rendered.refused === undefined && running(manager.state(declared.name))) result.pending.push(`${declared.name}: held at its running process, as ${rendered.problem}`);
      else result.failed.push(rendered.problem);
      continue;
    }

    try {
      const [kind, line] = await apply(office, manager, rendered.desired, receipts.get(declared.name), { upgrade, wait });

      result[kind].push(line);
    } catch (error) {
      result.failed.push(error instanceof Error ? error.message : String(error));
    }
  }

  return result;
}

/** `down`'s part: stops, disables and removes every unit a receipt holds. */
export function removeUnits(office: Office, { manager = userManager }: UnitsRun = {}): string[] {
  const receipts = readReceipts(office);

  refuseUnowned(manager, [], receipts, []);

  for (const name of receipts.keys()) {
    removeUnit(manager, unitDir(), name);
    dropReceipt(office, name);
  }

  return [...receipts.keys()].map(name => `${name}: removed`);
}

type Report = (ok: boolean | "warn", name: string, detail: string) => void;

/** What `office check` says of each unit: installed as office wrote it, running the verified revision and invocation, and ready by the same look `up` takes. Changes nothing. */
export async function unitStatus(office: Office, gathered: UnitInputs, report: Report, { manager = userManager }: UnitsRun = {}): Promise<void> {
  const { units, problems } = declaredUnits(office, gathered);
  const receipts = readReceipts(office);
  const dir = unitDir();

  for (const problem of problems) report(false, "user units", problem);

  for (const declared of units) {
    const receipt = receipts.get(declared.name);
    const state = manager.state(declared.name);
    const problem = ownershipProblem(dir, declared.name, receipt?.sha256, state);
    const rendered = await render(office, declared);

    if (problem !== undefined) report(false, declared.name, problem);
    else if (receipt === undefined || !existsSync(join(dir, declared.name))) report(false, declared.name, "not installed; run office up");
    else if (!rendered.ok) report(false, declared.name, rendered.problem);
    else if (!running(state)) report(false, declared.name, "not active; run office up");
    else if (receipt.sha256 !== rendered.desired.sha256 || receipt.applied !== rendered.desired.revision || receipt.invocation !== state.invocation) report("warn", declared.name, pendingDetail(state.pid, receipt.sha256 !== rendered.desired.sha256, receipt.applied, rendered.desired.revision));
    else if (state.stale) report("warn", declared.name, staleDetail(state.pid));
    else {
      const served = await observe(manager, rendered.desired, invocation => invocation === receipt.invocation);
      const now = manager.state(declared.name);

      report(served !== undefined, declared.name, served === undefined ? `${now.active} as PID ${now.pid}${now.stale ? " with a reload pending" : ""}, but not ready; see journalctl --user -u ${declared.name}` : `active and ready as PID ${served.pid}`);
    }
  }

  for (const name of receipts.keys()) {
    if (!units.some(unit => unit.name === name)) report(false, name, "no package wants it; office up removes it");
  }
}
