import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { claimAssetProblems, destinationProblems } from "../../features/mise-integration/projection.ts";
import { validateAssets } from "../../features/opencode/assets.ts";
import { writeAppliedReferences } from "../../features/references/applied-references.ts";
import { recordUnmet } from "../../features/tools/host.ts";
import { publishedView, type GatheredPackage, type GatherProblem, gatherPackages, problemLines } from "../../gather.ts";
import { failure, isFailure, type Change } from "../../lib/change.ts";
import { type Office, OfficeError } from "../../office.ts";
import { parsePackageLock } from "../../schema.ts";
import { lockFile } from "../../versions.ts";
import { validateReplacement } from "../definitions/inventory.ts";
import { bindReader } from "../generation/reader.ts";
import { managedDirectory, publishGeneration } from "../generation/storage.ts";
import { writeOfficeDeclaration } from "../sources/copies.ts";
import { resolvePackages } from "../sources/selection.ts";
import { applyPackages, SyncStopped } from "./application.ts";
import { applicationLease } from "./lease.ts";
import type { Admission, Outcome } from "./protocol.ts";

/** The problems admission finds beyond the gathering's: the files claims name, destinations across packages and every command name. */
function admissionProblems(office: Office, packages: GatheredPackage[], names: { owners: string[]; message: string }[]): GatherProblem[] {
  const problems: GatherProblem[] = [];

  for (const item of packages) {
    const owner = [item.entry.name];

    problems.push(...claimAssetProblems(item).map(message => ({ packages: owner, message })));
  }

  const owners = new Set<string>();
  const destinations = destinationProblems(office, packages, (...names) => { for (const name of names) owners.add(name); });

  if (destinations.length) problems.push(...destinations.map(message => ({ packages: [...owners], named: true as const, message })));
  problems.push(...names.map(problem => ({ packages: problem.owners, named: true as const, message: problem.message })));

  return problems;
}

export async function evaluateAdmission(temporary: string) {
  const input: Admission = JSON.parse(readFileSync(join(temporary, "input"), "utf8"));
  const { transaction, office, yaml } = input;
  const packages = parsePackageLock(input.packages);

  if (!packages.ok) throw new OfficeError(`invalid candidate ${lockFile}: ${packages.errors.join("; ")}`);
  const folder = managedDirectory(office.dir, transaction.name);
  let published = false;
  let recorded = false;
  let stopped = false;
  let committed: string[] | undefined;
  let excluded: string[] | undefined;
  let rejectedOwners: string[] | undefined;
  const lines: Change[] = [];

  try {
    bindReader(office.dir, transaction.name);
    const selection = resolvePackages(office);
    // This sync's fetch failures are already FAILED lines: they stay selected and unread.
    const gathered = await gatherPackages(office, { skip: new Set(input.rejected), machine: true });

    const refuse = (problems: GatherProblem[], reason: string) => {
      lines.push(...problemLines(problems).map(line => failure(`FAILED ${line}`)));

      // The caller widens rejection to the other packages this update must hold back.
      if (input.tracked) rejectedOwners = [...new Set(problems.flatMap(problem => problem.packages))];

      return new OfficeError(reason);
    };

    // Every copy, package.json, declared dependency and link is checked before the first import.
    if (gathered.blocked) throw refuse(gathered.blocked, "no package was loaded and no package set was published; fix the packages above and sync again");

    // Every package's settings are checked before any setup runs.
    if (gathered.inventory.invalidSettings.length) throw refuse(gathered.inventory.invalidSettings, "no package was set up and no package set was published; fix the settings above and sync again");

    for (const item of selection.packages) {
      if (!input.validate.includes(item.entry.name)) continue;

      try {
        validateReplacement(office, item);
      } catch (error) {
        throw refuse([{ packages: [item.entry.name], message: error instanceof Error ? error.message : String(error) }], "no package set was published");
      }
    }

    // A changed copy's OpenCode registrations must name files of its own before it is published,
    // even while another package is unread.
    for (const item of gathered.packages) {
      const paths = gathered.assets.get(item.entry.name);

      if (!input.validate.includes(item.entry.name) || paths === undefined) continue;

      try {
        validateAssets(office.dir, item.dir, paths);
      } catch (error) {
        throw refuse([{ packages: [item.entry.name], message: `OpenCode registration: ${error instanceof Error ? error.message : String(error)}` }], "no package set was published");
      }
    }

    const problems = [...gathered.problems, ...admissionProblems(office, gathered.packages, gathered.names)];

    if (problems.length) throw refuse(problems, "no package set was published; fix or deselect the packages above and sync again");

    // A shared tool whose recorded release no longer serves the candidate gets one before it is published.
    const desired = recordUnmet(office, gathered.packages);

    lines.push(...desired.lines.map(line => line.startsWith("FAILED") ? failure(line) : line));

    if (!desired.ok) throw new OfficeError("no package set was published, and office.lock's shared tools are as they were");

    // Held through the switch, the applied references and the application, apply: false included.
    using application = applicationLease(office.dir);

    for (const item of gathered.packages) {
      if (item.kind !== "local") lines.push(...writeOfficeDeclaration(office, item).map(line => line.replace(relative(office.dir, folder) + "/packages", ".office/packages")));
    }

    publishGeneration(transaction, yaml, packages.value);
    published = true;

    try {
      writeAppliedReferences(office.dir, gathered.references);
      recorded = true;
    } catch (error) {
      lines.push(failure(`FAILED the references were not recorded (${error instanceof Error ? error.message : String(error)}), so no reference checkout is cloned or updated; run office sync again`));
    }

    if (input.apply) {
      // Lines a step returned before one threw are still reported.
      const applied: Change[] = [];

      try {
        excluded = await applyPackages(office, publishedView(office, gathered), applied, input.exclude, join(folder, "withdrawals"));
      } finally {
        lines.push(...applied);
      }

      if (!gathered.unread.size) committed = gathered.committed;

      if (applied.some(isFailure)) lines.push(`generation ${transaction.name} is active; retry the incomplete application with office sync --packages`);
    }
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);

    stopped = error instanceof SyncStopped;

    if (stopped) lines.push(failure(`FAILED ${text}; the new package set is active and the rest of this sync did not run: fix the package, then run office sync again`));
    else lines.push(failure(`FAILED ${published ? `generation ${transaction.name} is active; retry application with office sync --packages: ` : ""}${text}`));
  }

  writeFileSync(join(temporary, "output"), JSON.stringify({ published, recorded, stopped, committed, excluded, lines, rejected: rejectedOwners, generation: published ? transaction.name : undefined } satisfies Outcome));
}
