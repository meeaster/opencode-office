import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { bindPaths } from "./bound-paths.ts";
import { boundRevision, collectReferences } from "./collect-references.ts";
import { currentOffice, loadOffice, type Office, OfficeError, readOfficeFields } from "./office.ts";
import { parse } from "yaml";
import * as v from "valibot";
import { commandBootstrapSchema, officeSchema, packageEntry } from "./schema.ts";
import { activeGeneration, beginGeneration, managedDirectory, pinActive, publishGeneration, type Candidate } from "./package-generation.ts";
import { bindImports, coupledFailures, createImportMap, requireCoherentImports } from "./package-imports.ts";
import { installedPackages } from "./layout.ts";
import { embeddedPackage, materializePackage, readRecord, requiredPackages, resolvePackages, validateReplacement, writePackageSettings } from "./packages.ts";
import { beginReferencePublication } from "./reference-publication.ts";
import { readSnapshot, type ReferenceSnapshot } from "./reference-snapshot.ts";
import { applyPackages } from "./commands/sync.ts";
import { openCheckoutLease } from "./checkout-lease.ts";
import { collectAssets } from "../standard/opencode/assets.ts";
import { renameNoReplace } from "./no-replace.ts";

type Admission = {
  transaction: Candidate;
  office: Office;
  yaml: string;
  embedded: [string, string][];
  validate: string[];
  rejected: string[];
  exclude: boolean;
  apply: boolean;
  tracked: boolean;
};

type Outcome = { published: boolean; lines: string[]; rejected?: string[]; generation?: string };

function program() {
  return Bun.isStandaloneExecutable ? [process.execPath] : [process.execPath, "--no-install", join(import.meta.dir, "cli.ts")];
}

async function run(args: string[], folder: string, fd: number) {
  const child = Bun.spawn([...program(), ...args], {
    env: { ...process.env, NODE_PATH: join(folder, "node_modules") },
    stdio: ["inherit", "inherit", "inherit", fd],
  });

  const stop = () => child.kill("SIGINT");
  process.once("SIGINT", stop);

  try { return await child.exited; } finally { process.off("SIGINT", stop); }
}

export async function runReader(dir: string, args: string[]) {
  using active = pinActive(dir);

  if (!active) return;
  const folder = managedDirectory(dir, active.name);

  return run(["--package-reader", dir, active.name, ...args], folder, active.fd);
}

export function bindReader(dir: string, name: string, candidate = false) {
  const folder = managedDirectory(dir, name);
  bindPaths(dir, folder, candidate);
  const selection = join(folder, "selection.json");

  if (existsSync(selection)) {
    const packages = v.parse(v.array(packageEntry), JSON.parse(readFileSync(selection, "utf8")));
    const unavailable = join(folder, "unavailable.json");
    const rejected = new Set(existsSync(unavailable) ? v.parse(v.array(v.string()), JSON.parse(readFileSync(unavailable, "utf8"))) : []);
    let live: v.InferOutput<typeof commandBootstrapSchema> | undefined;
    bindImports(dir, resolvePackages({ dir, packages }).packages.filter(pkg => !rejected.has(pkg.entry.name)), pkg => {
      if (candidate) return;
      live ??= readOfficeFields(dir, commandBootstrapSchema);
      const matches = live.packages.filter(entry => entry.name === pkg.entry.name);

      if (!matches.length && requiredPackages.includes(pkg.entry.name)) return;
      const entry = matches[0];

      if (matches.length !== 1 || entry.repo !== pkg.entry.source?.repo || entry.ref !== pkg.entry.source?.ref || entry.path !== pkg.entry.source?.path) {
        throw new OfficeError(`selection of imported package ${pkg.entry.name} differs from the active package set; run office sync --packages`);
      }
    });
  }
}

async function prepareSources(office: Office, selection: ReturnType<typeof resolvePackages>, folder: string, previous: string, snapshot: ReferenceSnapshot | undefined, lines: string[]) {
  const packages = join(folder, "packages");
  mkdirSync(packages);
  const embedded: [string, string][] = [];
  const validate: string[] = [];
  const rejected: string[] = [];

  using deliveries = openCheckoutLease(office.dir, ".package-application");
  deliveries.acquire();

  for (const item of selection.packages) {
    if (item.kind === "local") continue;
    const old = join(previous, "packages", item.entry.name);
    const dir = join(packages, item.entry.name);

    if (lstatSync(old, { throwIfNoEntry: false })?.isSymbolicLink()) throw new OfficeError(`cannot materialize redirected package ${old}`);

    const bound = boundRevision(snapshot, item.entry);
    let copiedPrevious = false;

    try {
      if (existsSync(old)) {
        cpSync(old, dir, { recursive: true, verbatimSymlinks: true });
        copiedPrevious = true;
      }

      const materialized = await materializePackage(office, item, packages, bound);

      if (materialized.source) embedded.push([item.entry.name, materialized.source]);
      lines.push(...materialized.changes.map(line => line.replaceAll(relative(office.dir, packages), ".office/packages")));

      if (materialized.changes.some(line => line.startsWith("FAILED"))) {
        rejected.push(item.entry.name);
      } else if (materialized.changes.length) {
        validate.push(item.entry.name);

        if (bound && !existsSync(old)) {
          // Exact repair of a lost published Git source, independently of whether new
          // registrations are admitted. Never restore a floating tag or replace an entry.
          const record = readRecord(dir);

          if (record && "repo" in record && record.commit === bound) {
            const repair = join(folder, `repair-${item.entry.name}`);
            cpSync(dir, repair, { recursive: true, verbatimSymlinks: true });
            renameNoReplace(repair, old);
          }
        }
      }
    } catch (error) {
      rejected.push(item.entry.name);

      if (item.kind === "built-in") embedded.push([item.entry.name, (await embeddedPackage(item.entry.name)).source]);
      lines.push(`FAILED package ${item.entry.name}: ${String(error)}`);

      if (!copiedPrevious) rmSync(dir, { force: true, recursive: true });
    }

    item.dir = dir;
  }

  // Keep outstanding removal receipts with the candidate. After a crash or a deferred
  // apply, the previous generation need not stay pinned just to finish a template withdrawal.
  const withdrawals = join(folder, "withdrawals");
  mkdirSync(withdrawals);
  const selected = new Set(selection.packages.map(pkg => pkg.entry.name));

  for (const source of ["withdrawals", "packages"]) {
    const parent = join(previous, source);

    if (!existsSync(parent)) continue;

    for (const entry of readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || selected.has(entry.name)) continue;
      cpSync(join(parent, entry.name), join(withdrawals, entry.name), { recursive: true, verbatimSymlinks: true });
    }
  }

  return { embedded, validate, rejected };
}

export async function publishPackages(office: Office, exclude: boolean, update?: { yaml: (text: string) => string; apply: boolean; names: string[] }): Promise<Outcome> {
  const lines: string[] = [];
  const selection = resolvePackages(office);

  if (selection.problems.length) return { published: false, lines: selection.problems.map(p => `FAILED ${p.message}`) };
  using reservation = beginGeneration(office.dir);
  const { transaction } = reservation;
  const folder = managedDirectory(office.dir, transaction.name);
  const previous = managedDirectory(office.dir, transaction.previous);
  const temporary = mkdtempSync(join(tmpdir(), "office-admission-"));
  const old = selection.packages.map(item => item.kind === "local" ? item : { ...item, dir: join(previous, "packages", item.entry.name) });
  const coupled = (names: string[]) => update && update.names.length > 1 ? coupledFailures(names, update.names, [old, selection.packages]) : names;

  try {
    const yaml = update ? update.yaml(transaction.original) : transaction.original;
    const desired = loadOffice(office.dir, v.parse(officeSchema, parse(yaml, { stringKeys: true })));

    if (!Bun.deepEquals(desired, office)) throw new OfficeError("office.yaml changed while resolving packages; retry");
    const snapshot = readSnapshot(office.dir);

    if (!snapshot.ok) throw new OfficeError(`${snapshot.errors.join("; ")}; restore a readable generation, or verify installed Git pins before moving it aside and running office sync --packages`);
    const { embedded, validate, rejected } = await prepareSources(office, selection, folder, previous, snapshot.value, lines);

    if (update && rejected.length) return { published: false, lines, rejected: coupled(rejected) };
    createImportMap(folder, selection.packages.filter(pkg => !rejected.includes(pkg.entry.name)));
    writeFileSync(join(folder, "unavailable.json"), JSON.stringify(rejected));
    writeFileSync(join(folder, "selection.json"), JSON.stringify(office.packages.map(({ name, settings, cron, source }) => ({ name, settings, cron, ...source }))));
    const request: Admission = { office, transaction, yaml, embedded, validate, rejected, exclude, tracked: !!update, apply: update?.apply ?? true };
    writeFileSync(join(temporary, "input"), JSON.stringify(request));
    const code = await run(["--package-admission", temporary], folder, reservation.fd);

    if (code !== 0) throw new OfficeError(`package evaluator exited ${code}`);
    const result: Outcome = JSON.parse(readFileSync(join(temporary, "output"), "utf8"));
    lines.push(...result.lines);

    return { ...result, rejected: result.rejected && coupled(result.rejected), lines: result.published ? lines : lines.filter(line => line.startsWith("FAILED")) };
  } catch (error) {
    const published = activeGeneration(office.dir) === transaction.name;
    const reason = error instanceof Error ? error.message : String(error);

    return { published, lines: [`FAILED ${reason}${published ? `; generation ${transaction.name} is active, rerun office sync --packages to reconcile external files` : ""}`] };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    // A pending switch may need the candidate even when its publisher died.
  }
}

export async function evaluateAdmission(temporary: string) {
  const input: Admission = JSON.parse(readFileSync(join(temporary, "input"), "utf8"));
  const { transaction, office, yaml } = input;
  const folder = managedDirectory(office.dir, transaction.name);
  let published = false;
  let rejectedOwners: string[] | undefined;
  const lines: string[] = [];

  try {
    const owner = currentOffice({ office: office.dir });
    using application = openCheckoutLease(office.dir, ".package-application");

    const publication = beginReferencePublication(owner, snapshot => {
      requireCoherentImports();

      // OpenCode registrations may depend on defaults that setup just supplied.
      for (const item of installed.installed) {
        if (input.validate.includes(item.entry.name) && item.manifest.opencode) collectAssets(office.dir, item);
      }

      const brokenReplacement = snapshot.contributors.find(group => group.stale && input.validate.includes(group.name) && existsSync(join(office.dir, ".office/packages", group.name)));

      if (brokenReplacement || (input.tracked && lines.some(line => line.startsWith("FAILED")))) {
        if (input.tracked) rejectedOwners = snapshot.contributors.flatMap(group => group.stale ? [group.name] : []);
        throw new OfficeError(`candidate failed collection${brokenReplacement ? `: ${brokenReplacement.name}` : ""}`);
      }

      application.acquire();

      for (const item of installed.installed) {
        if (item.kind !== "local") lines.push(...writePackageSettings(office, item).map(line => line.replace(relative(office.dir, folder) + "/packages", ".office/packages")));
      }

      writeFileSync(join(folder, "references.json"), JSON.stringify(snapshot, null, 2) + "\n");
      publishGeneration(transaction, yaml);
      published = true;
    });

    if (!publication.ok) throw new OfficeError(publication.errors.join("; "));
    bindReader(office.dir, transaction.name, true);
    const selection = resolvePackages(office);
    const rejected = new Set(input.rejected);
    const installed = installedPackages(office, rejected, false);

    for (const item of selection.packages) {
      if (!input.validate.includes(item.entry.name)) continue;

      try {
        await validateReplacement(office, item, false);
      } catch (error) {
        if (input.tracked) rejectedOwners = [item.entry.name];
        throw error;
      }
    }

    lines.push(...installed.problems.map(p => `FAILED package ${p.packages.join(", ")}: ${p.message}`));
    const conflicts = new Set<string>();

    const accepted = await collectReferences(office, selection.packages, installed, lines, publication.value, rejected, new Map(input.embedded), (...owners) => {
      for (const owner of owners) conflicts.add(owner);
    });

    // Only retry attributable admission failures. Never turn a lost writer ticket,
    // failed pointer switch, or failed application into a different publication.
    if (!accepted && input.tracked) rejectedOwners = [...conflicts];

    if (accepted && input.apply) {
      for (const item of installed.installed) {
        if (item.kind === "local") continue;
        const stable = join(office.dir, ".office/packages", item.entry.name);

        if (item.panel) item.panel = join(stable, relative(item.dir, item.panel));
        item.dir = stable;
      }

      const application: string[] = [];
      await applyPackages(office, installed, publication.value.previous, application, input.exclude, join(folder, "withdrawals"));
      lines.push(...application);

      if (application.some(line => line.startsWith("FAILED"))) lines.push(`generation ${transaction.name} is active; retry the incomplete application with office sync --packages`);
    }
  } catch (error) {
    lines.push(`FAILED ${published ? `generation ${transaction.name} is active; retry application with office sync --packages: ` : ""}${error instanceof Error ? error.message : String(error)}`);
  }

  writeFileSync(join(temporary, "output"), JSON.stringify({ published, lines, rejected: rejectedOwners, generation: published ? transaction.name : undefined } satisfies Outcome));
}
