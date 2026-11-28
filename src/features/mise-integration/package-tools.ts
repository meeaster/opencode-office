import type { Office } from "../../office.ts";
import { compareToolVersions } from "../tools/versions.ts";
import type { ProjectedPackage } from "./projection.ts";

/** The package whose tools are the ones the office CLI itself runs: SOPS, age, gh and pre-commit (src/features/tools/host-tools.ts). */
const cliToolsPackage = "office";

/**
 * The tools a package declares in this office, at the versions it was tested with. A container
 * keeps its tools here, so there the package's `@office/tools` requirements count as declared too;
 * a host-mode office installs those itself (src/features/tools/).
 */
export function wantedTools(office: Office, item: ProjectedPackage) {
  const tools: Record<string, string> = {};

  if (office.opencode.mode === "host") return tools;

  for (const { name, minimum, hostOnly } of item.claims.required) {
    if (hostOnly) continue;

    if (!Object.hasOwn(tools, name) || (compareToolVersions(minimum, tools[name]) ?? 0) > 0) tools[name] = minimum;
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
export function declaredTools(office: Office, installed: ProjectedPackage[]): Map<string, Declared> {
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
