import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { redactUrl } from "../../../sdk/redact-url.ts";
import { type PackageKind, packageRoot, pulledFolder } from "../../bound-paths.ts";
import { type Office, OfficeError, type PackageEntry } from "../../office.ts";
import { builtinPackages } from "../../tool.ts";
import { scope, sdkName } from "./manifest.ts";
import { readRecord } from "./records.ts";

const sdkReserved = `the name ${sdkName} is reserved for ${scope}${sdkName}; rename the package`;

/** The built-in packages every office has, without an entry in office.yaml. */
export const requiredPackages = ["tools", "mise-integration", "opencode", "office", "references", "seeds", "cron"];

/** The names of the packages `office` selects: the required built-ins and each office.yaml entry, whether or not it resolves or loads. */
export function selectedNames(office: Pick<Office, "packages">): Set<string> {
  return new Set([...requiredPackages, ...office.packages.map(entry => entry.name)]);
}

/** A package the office has, with the source folder to read (possibly bound or staged). */
export type ResolvedPackage = { entry: PackageEntry; kind: PackageKind; dir: string };

/** Why a package isn't installed, or its plugin isn't linked. */
export type PackageProblem = { packages: string[]; message: string };

/** The packages an office has, and the entries of office.yaml that can't be one. */
export type ResolvedPackages = { packages: ResolvedPackage[]; problems: PackageProblem[] };

/** The folder of a built-in or remote package. */
export function pulledDir(office: Pick<Office, "dir">, name: string): string {
  return join(packageRoot(office.dir), name);
}

/** The folder of a package written in the office. */
function localDir(office: Pick<Office, "dir">, name: string): string {
  return join(office.dir, "packages", name);
}

function folders(dir: string): string[] {
  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
}

/** The package folders in `.office/packages/`, declared or not. */
export function pulledFolders(office: Office): string[] {
  return folders(join(office.dir, pulledFolder));
}

/** The package folders in `packages/`, declared or not; `node_modules/` holds sync's editor link. */
export function localFolders(office: Office): string[] {
  return folders(join(office.dir, "packages")).filter((name) => name !== "node_modules");
}

function ownershipProblems(office: Pick<Office, "dir" | "packages">, builtins: string[], only?: string, live = false): PackageProblem[] {
  const problems: PackageProblem[] = [];

  for (const name of selectedNames(office)) {
    if (only !== undefined && name !== only) continue;

    if (!builtins.includes(name)) continue;

    const entry = office.packages.find(item => item.name === name);
    const local = localDir(office, name);

    if (existsSync(local)) problems.push({ packages: [name], message: `built-in package ${name} conflicts with local ${relative(office.dir, local)}; rename one before syncing` });

    if (entry?.source) problems.push({ packages: [name], message: `built-in package ${name} conflicts with ${redactUrl(entry.source.repo)}@${entry.source.ref}:${entry.source.path}; rename one before syncing` });
    else {
      const installed = readRecord(pulledDir(office, name));

      if (installed && "repo" in installed) problems.push({ packages: [name], message: `built-in package ${name} conflicts with installed ${redactUrl(installed.repo)}@${installed.ref}:${installed.path}; move the existing copy before syncing` });

      // A live load leaves such a copy to fail its own source check.
      if (!live && requiredPackages.includes(name) && name !== "office" && !installed && existsSync(pulledDir(office, name))) {
        problems.push({ packages: [name], message: `cannot establish ownership of ${pulledFolder}/${name}; restore its source record or move the existing copy before syncing` });
      }
    }
  }

  return problems;
}

export function requirePackageOwnership(office: Office): void {
  const collisions = ownershipProblems(office, builtinPackages());

  if (collisions.length) throw new OfficeError(collisions.map(problem => problem.message).join("\n"));
}

/**
 * The packages the office has: the required built-ins, then each entry of office.yaml, with its
 * kind. An entry without `repo` is built-in when the tool ships a package of its name, so those
 * names are reserved. A required built-in's entry configures it without installing it twice.
 * Ownership problems leave no packages, unless `live` (the gathering): then only the packages
 * they name are left out.
 */
export function resolvePackages(office: Pick<Office, "dir" | "packages">, only?: string, live = false): ResolvedPackages {
  const builtins = builtinPackages();
  const problems = ownershipProblems(office, builtins, only, live);
  const excluded = new Set(problems.flatMap(problem => problem.packages));

  if (problems.length && !live) return { packages: [], problems };

  const packages: ResolvedPackage[] = requiredPackages.flatMap((name) => (only !== undefined && name !== only) || excluded.has(name) ? [] : [{
    entry: office.packages.find((entry) => entry.name === name) ?? { name, settings: {}, source: undefined },
    kind: "built-in",
    dir: pulledDir(office, name),
  }]);

  for (const entry of office.packages) {
    const problem = (message: string) => problems.push({ packages: [entry.name], message });

    if ((only !== undefined && entry.name !== only) || requiredPackages.includes(entry.name) || excluded.has(entry.name)) continue;

    // Its link would take the SDK's place in the package set.
    if (entry.name === sdkName) {
      problem(sdkReserved);
      continue;
    }

    if (!builtins.includes(entry.name)) {
      packages.push({ entry, kind: entry.source === undefined ? "local" : "remote", dir: entry.source === undefined ? localDir(office, entry.name) : pulledDir(office, entry.name) });

      continue;
    }

    packages.push({ entry, kind: "built-in", dir: pulledDir(office, entry.name) });
  }

  return { packages, problems };
}
