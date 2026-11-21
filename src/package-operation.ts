import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { bindPaths } from "./bound-paths.ts";
import { boundRevision, collectReferences } from "./collect-references.ts";
import { currentOffice, type Office, OfficeError } from "./office.ts";
import { activeGeneration, beginGeneration, managedDirectory, publishGeneration, type Candidate } from "./package-generation.ts";
import { bindImports, createImportMap, requireCoherentImports } from "./package-imports.ts";
import { installedPackages } from "./layout.ts";
import { materializePackage, resolvePackages, validateReplacement } from "./packages.ts";
import { beginReferencePublication } from "./reference-publication.ts";
import { readSnapshot } from "./reference-snapshot.ts";
import { applyPackages } from "./commands/sync.ts";
import { openCheckoutLease } from "./checkout-lease.ts";
import { collectAssets } from "../standard/opencode/assets.ts";

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

type Outcome = { published: boolean; lines: string[] };

function program() {
  return Bun.isStandaloneExecutable ? [process.execPath] : [process.execPath, "--no-install", join(import.meta.dir, "cli.ts")];
}

async function run(args: string[], folder: string) {
  const child = Bun.spawn([...program(), ...args], {
    env: { ...process.env, NODE_PATH: join(folder, "node_modules") },
    stdin: "inherit", stdout: "inherit", stderr: "inherit",
  });

  const stop = () => child.kill("SIGINT");
  process.once("SIGINT", stop);

  try { return await child.exited; } finally { process.off("SIGINT", stop); }
}

export async function runReader(dir: string, args: string[]) {
  const name = activeGeneration(dir);

  if (!name) return;
  const folder = managedDirectory(dir, name);

  return run(["--package-reader", dir, name, ...args], folder);
}

export function bindReader(dir: string, name: string) {
  const folder = managedDirectory(dir, name);
  bindPaths(dir, folder);
  const selection = join(folder, "selection.json");

  if (existsSync(selection)) {
    const packages: Office["packages"] = JSON.parse(readFileSync(selection, "utf8"));
    bindImports(dir, resolvePackages({ dir, packages }).packages);
  }
}

export async function publishPackages(office: Office, exclude: boolean, update?: { yaml: (text: string) => string; apply: boolean }): Promise<Outcome> {
  const lines: string[] = [];
  const selection = resolvePackages(office);

  if (selection.problems.length) return { published: false, lines: selection.problems.map(p => `FAILED ${p.message}`) };
  const transaction = beginGeneration(office.dir);
  const folder = managedDirectory(office.dir, transaction.name);
  const packages = join(folder, "packages");
  const previous = managedDirectory(office.dir, transaction.previous);
  const temporary = mkdtempSync(join(tmpdir(), "office-admission-"));

  try {
    const yaml = update ? update.yaml(transaction.original) : transaction.original;
    const snapshot = readSnapshot(office.dir);

    if (!snapshot.ok) throw new OfficeError(snapshot.errors.join("; "));
    mkdirSync(packages);
    const embedded: [string, string][] = [];
    const validate: string[] = [];
    const rejected: string[] = [];

    for (const item of selection.packages) {
      if (item.kind === "local") continue;
      const old = join(previous, "packages", item.entry.name);
      const dir = join(packages, item.entry.name);

      if (lstatSync(old, { throwIfNoEntry: false })?.isSymbolicLink()) throw new OfficeError(`cannot materialize redirected package ${old}`);

      if (existsSync(old)) cpSync(old, dir, { recursive: true, verbatimSymlinks: true });
      const materialized = await materializePackage(office, item, packages, boundRevision(snapshot.value, item.entry));

      if (materialized.source) embedded.push([item.entry.name, materialized.source]);
      lines.push(...materialized.changes.map(line => line.replaceAll(relative(office.dir, packages), ".office/packages")));

      if (materialized.changes.some(line => line.startsWith("FAILED"))) {
        rejected.push(item.entry.name);
        rmSync(dir, { recursive: true, force: true });
      } else if (materialized.changes.length) validate.push(item.entry.name);
      item.dir = dir;
    }

    if (update && rejected.length) return { published: false, lines };
    createImportMap(folder, selection.packages);
    writeFileSync(join(folder, "selection.json"), JSON.stringify(office.packages));
    const request: Admission = { office, transaction, yaml, embedded, validate, rejected, exclude, tracked: !!update, apply: update?.apply ?? true };
    writeFileSync(join(temporary, "input"), JSON.stringify(request));
    const code = await run(["--package-admission", temporary], folder);

    if (code !== 0) throw new OfficeError(`package evaluator exited ${code}`);
    const result: Outcome = JSON.parse(readFileSync(join(temporary, "output"), "utf8"));
    lines.push(...result.lines);

    return { published: result.published, lines };
  } catch (error) {
    return { published: false, lines: [...lines, `FAILED ${error instanceof Error ? error.message : String(error)}`] };
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

      if (brokenReplacement || (input.tracked && lines.some(line => line.startsWith("FAILED")))) throw new OfficeError(`candidate failed collection${brokenReplacement ? `: ${brokenReplacement.name}` : ""}`);
      application.acquire();
      writeFileSync(join(folder, "references.json"), JSON.stringify(snapshot, null, 2) + "\n");
      publishGeneration(transaction, yaml);
      published = true;
    });

    if (!publication.ok) throw new OfficeError(publication.errors.join("; "));
    bindReader(office.dir, transaction.name);
    const selection = resolvePackages(office);
    const rejected = new Set(input.rejected);
    const installed = installedPackages(office, rejected, false);

    for (const item of selection.packages) {
      if (input.validate.includes(item.entry.name)) await validateReplacement(office, item, false);
    }

    lines.push(...installed.problems.map(p => `FAILED package ${p.packages.join(", ")}: ${p.message}`));
    const accepted = await collectReferences(office, selection.packages, installed, lines, publication.value, rejected, new Map(input.embedded));

    if (accepted && input.apply) {
      for (const item of installed.installed) {
        if (item.kind === "local") continue;
        const stable = join(office.dir, ".office/packages", item.entry.name);

        if (item.panel) item.panel = join(stable, relative(item.dir, item.panel));
        item.dir = stable;
      }

      await applyPackages(office, installed, publication.value.previous, lines, input.exclude, managedDirectory(office.dir, transaction.previous));

      if (lines.some(line => line.startsWith("FAILED"))) lines.push(`generation ${transaction.name} is active; retry the incomplete application with office sync --packages`);
    }
  } catch (error) {
    lines.push(`FAILED ${published ? `generation ${transaction.name} is active; retry application with office sync --packages: ` : ""}${error instanceof Error ? error.message : String(error)}`);
  }

  writeFileSync(join(temporary, "output"), JSON.stringify({ published, lines } satisfies Outcome));
}
