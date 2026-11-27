// `office down`'s part for packages, run in a reader bound to the published package set: the one
// exception to "nothing loads from a set that fails its checks". Every check made before an import
// runs on the whole selection as for any reader; a package that fails one, and every package that
// depends on it at any depth (through a selected optional provider too), is left out unimported. The rest are imported providers first, a
// package whose provider failed to import is left out unimported too, and each that has a `down`
// gets its settings, checked against its own schema, and the host helpers. No `setup` runs, so
// there are no registries. Every package left out is named, and the reader exits 1; the kernel's
// own shutdown runs in the process that started this one, whatever happens here.
import { officeInfo, packageHost, packageLines } from "../../lifecycle-inputs.ts";
import type { Office } from "../../office.ts";
import { definitionGate, installedDefinition } from "../definitions/inventory.ts";
import { schemaSettings } from "../definitions/settings.ts";
import { importEdges, readPackageJson } from "../sources/manifest.ts";
import { type ResolvedPackage, resolvePackages, selectedNames } from "../sources/selection.ts";
import type { PackageManifest } from "../../schema.ts";
import { say } from "../../report/index.ts";

/**
 * Each package's import edges, for those whose package.json reads: its optional providers office.yaml
 * `selected` included, even one resolution left out for an ownership conflict.
 */
function dependencies(packages: ResolvedPackage[], selected: ReadonlySet<string>): Map<string, string[]> {
  const declared = new Map<string, string[]>();

  for (const item of packages) {
    const json = readPackageJson(item.dir, item.entry.name, item.kind);

    if (json.ok) declared.set(item.entry.name, importEdges(json.value, selected));
  }

  return declared;
}

/** Adds to `left` every package that depends on one in it, at any depth, with why. */
function dependents(left: Map<string, string>, declared: ReadonlyMap<string, readonly string[]>): void {
  for (let grew = true; grew;) {
    grew = false;

    for (const [name, needs] of declared) {
      const provider = needs.find(dependency => left.has(dependency));

      if (provider === undefined || left.has(name)) continue;
      left.set(name, `depends on package ${provider}, which is left out`);
      grew = true;
    }
  }
}

/** `packages` providers first where their declarations allow; a cycle keeps selection order. */
function loadingOrder(packages: ResolvedPackage[], declared: ReadonlyMap<string, readonly string[]>): ResolvedPackage[] {
  const byName = new Map(packages.map(item => [item.entry.name, item]));
  const ordered: ResolvedPackage[] = [];
  const seen = new Set<string>();

  const visit = (item: ResolvedPackage) => {
    if (seen.has(item.entry.name)) return;
    seen.add(item.entry.name);

    for (const dependency of declared.get(item.entry.name) ?? []) {
      const provider = byName.get(dependency);

      if (provider) visit(provider);
    }

    ordered.push(item);
  };

  for (const item of packages) visit(item);

  return ordered;
}

/**
 * Runs each loadable package's `down`; returns whether every package took part: false when any was
 * left out or its `down` threw or returned something other than lines.
 */
export async function shutdownPackages(office: Office): Promise<boolean> {
  const resolved = resolvePackages(office, undefined, true);
  const left = new Map<string, string>();
  const leave = (name: string, why: string) => left.set(name, left.has(name) ? `${left.get(name)}; ${why}` : why);

  for (const problem of [...resolved.problems, ...definitionGate(office, resolved.packages)]) {
    for (const name of problem.packages) leave(name, problem.message);
  }

  const declared = dependencies(resolved.packages, selectedNames(office));

  dependents(left, declared);
  const imported: { item: ResolvedPackage; manifest: PackageManifest; file: string }[] = [];

  for (const item of loadingOrder(resolved.packages, declared)) {
    const name = item.entry.name;

    if (left.has(name)) continue;
    const provider = (declared.get(name) ?? []).find(dependency => left.has(dependency));

    // Its provider didn't import: importing it would load the provider again.
    if (provider !== undefined) {
      left.set(name, `depends on package ${provider}, which is left out`);
      continue;
    }

    const read = installedDefinition(office, item);

    if (read.ok) imported.push({ item, ...read.value });
    else left.set(name, read.errors.join("; "));
  }

  // A provider that failed after its dependent imported (a cycle): no dependent's `down` runs either.
  dependents(left, declared);
  let ok = left.size === 0;

  // What a package left out installed, such as its host timers, stays until its down runs.
  for (const [name, why] of left) say(`package ${name}: left out of shutdown, so what it installed, such as its timers, stays installed: ${why}`);

  for (const { item, manifest, file } of imported) {
    const name = item.entry.name;
    const down = manifest.down?.bind(manifest);

    if (!down || left.has(name)) continue;
    const settings = schemaSettings(item, manifest, file);

    if (!settings.ok) {
      say(`package ${name}: its down didn't run: ${settings.errors.join("; ")}`);
      ok = false;
      continue;
    }

    const result = await packageLines(name, "down", () => down({ office: officeInfo(office), settings: settings.value, host: packageHost(office, name) }));

    if (!result.ok) {
      say(result.problem);
      ok = false;
      continue;
    }

    for (const line of result.lines) say(line);
  }

  return ok;
}
