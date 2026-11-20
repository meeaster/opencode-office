import type { Office } from "../../src/office.ts";
import type { InstalledPackage } from "../../src/packages.ts";

/** The package whose tools are the ones the office CLI itself runs: SOPS, age, gh and pre-commit (src/host-tools.ts). */
export const cliToolsPackage = "office";

/** Whether the package's own switch for its host block, if it names one, is on. */
export function switchedOn(item: InstalledPackage): boolean {
  const setting = item.manifest.host?.setting;

  return setting === undefined || String(item.settings[setting]) === "true";
}

/** Whether a package's host block applies: the office runs OpenCode on the host, and the package's switch is on. */
export function hostApplies(office: Office, item: InstalledPackage): boolean {
  return item.manifest.host !== undefined && office.opencode.mode === "host" && switchedOn(item);
}

/** The tools a package declares in this office, at the versions it was tested with. */
export function wantedTools(office: Office, item: InstalledPackage): Record<string, string> {
  const tools = hostApplies(office, item) ? { ...item.manifest.tools, ...item.manifest.host?.tools } : { ...item.manifest.tools };

  for (const { name, minimumVersion, hostOnly } of item.machine?.tools ?? []) {
    if (hostOnly && office.opencode.mode !== "host") continue;

    if (!Object.hasOwn(tools, name) || (compareToolVersions(minimumVersion, tools[name]) ?? 0) > 0) tools[name] = minimumVersion;
  }

  return tools;
}

// A version office can order: dotted numbers, optionally a `v` before them, a prerelease after a
// `-`, and build metadata after a `+`, which doesn't count. Every package's version is one
// (src/schema.ts); the office's line may be anything mise takes, such as "2" or "latest".
const orderable = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Compares dotted identifiers, numerically where both are numbers, a missing one first. */
function compareParts(left: string[], right: string[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const [a, b] = [left[index], right[index]];

    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;

    const order = /^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : a < b ? -1 : a > b ? 1 : 0;

    if (order !== 0) return Math.sign(order);
  }

  return 0;
}

/**
 * Orders two versions SemVer-like: release numbers part by part (1.10 after 1.9, 1.2 before
 * 1.2.1), a prerelease before its release, build metadata ignored. Undefined when either isn't
 * such a version: office then doesn't guess, and keeps the office's line.
 */
export function compareToolVersions(left: string, right: string): number | undefined {
  const [a, b] = [orderable.exec(left), orderable.exec(right)];

  if (a === null || b === null) return undefined;

  const core = compareParts(a[1].split("."), b[1].split("."));

  if (core !== 0) return core;

  if (a[2] === undefined || b[2] === undefined) return a[2] === b[2] ? 0 : a[2] === undefined ? 1 : -1;

  return compareParts(a[2].split("."), b[2].split("."));
}

/** The owner keeps a newer or non-comparable adopted pin; a comparable floor can only raise it. */
export function adoptVersion(floor: string, pin: string | undefined): string {
  if (pin === undefined || (compareToolVersions(pin, floor) ?? 0) < 0) return floor;

  return pin;
}

/** A tool the packages declare: the version the line starts at and must not fall below, and who declares it at what. */
type Declared = { floor: string; packages: { name: string; version: string }[] };

/**
 * Every tool the installed packages declare in this office, the office package's first, then by
 * package and in each package's order. Its floor is the highest version a package declares; among
 * versions office can't order, the first package's stands.
 */
export function declaredTools(office: Office, installed: InstalledPackage[]): Map<string, Declared> {
  const ordered = installed.toSorted((a, b) => a.entry.name === b.entry.name ? 0 : a.entry.name === cliToolsPackage ? -1 : b.entry.name === cliToolsPackage ? 1 : a.entry.name.localeCompare(b.entry.name));
  const tools = new Map<string, Declared>();

  for (const item of ordered) {
    for (const [tool, version] of Object.entries(wantedTools(office, item))) {
      const known = tools.get(tool);

      if (known === undefined) {
        tools.set(tool, { floor: version, packages: [{ name: item.entry.name, version }] });

        continue;
      }

      known.packages.push({ name: item.entry.name, version });

      if ((compareToolVersions(version, known.floor) ?? 0) > 0) known.floor = version;
    }
  }

  return tools;
}
