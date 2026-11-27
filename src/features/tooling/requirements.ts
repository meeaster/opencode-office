import type { Office } from "../../office.ts";
import type { GatheredPackage } from "../../gather.ts";
import type { InstalledPackage } from "../../loader/packages.ts";
import { compareToolVersions } from "../../../packages/tools/versions.ts";

export { compareToolVersions };

/** The package whose tools are the ones the office CLI itself runs: SOPS, age, gh and pre-commit (src/features/host/host-tools.ts). */
const cliToolsPackage = "office";

/** Whether the package's own switch for its host block, if it names one, is on. */
export function switchedOn(item: InstalledPackage): boolean {
  const setting = item.manifest.host?.setting;

  return setting === undefined || String(item.settings[setting]) === "true";
}

/** Whether a package's host block applies: the office runs OpenCode on the host, and the package's switch is on. */
export function hostApplies(office: Office, item: InstalledPackage): boolean {
  return item.manifest.host !== undefined && office.opencode.mode === "host" && switchedOn(item);
}

/**
 * The tools a package declares in this office, at the versions it was tested with. A container
 * keeps its tools here, so there the package's `@office/tools` requirements count as declared too;
 * a host-mode office installs those itself (src/features/tools/).
 */
export function wantedTools(office: Office, item: GatheredPackage): Record<string, string> {
  const tools = hostApplies(office, item) ? { ...item.manifest.tools, ...item.manifest.host?.tools } : { ...item.manifest.tools };
  const shared = office.opencode.mode === "host" ? [] : item.claims.required.map(({ name, minimum, hostOnly }) => ({ name, minimumVersion: minimum, hostOnly }));

  for (const { name, minimumVersion, hostOnly } of [...item.claims.tools, ...shared]) {
    if (hostOnly && office.opencode.mode !== "host") continue;

    if (!Object.hasOwn(tools, name) || (compareToolVersions(minimumVersion, tools[name]) ?? 0) > 0) tools[name] = minimumVersion;
  }

  return tools;
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
export function declaredTools(office: Office, installed: GatheredPackage[]): Map<string, Declared> {
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
