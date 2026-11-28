import { readdirSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { linkForEditors } from "../installed/links.ts";
import type { Gathered } from "../../gather.ts";
import { runPackageHooks } from "../../lifecycle-inputs.ts";
import { installPanel, locate, panelId, removalNote } from "../../features/opencode/desktop.ts";
import { syncMachine } from "../../features/machine/owned-files.ts";
import { machineReconciliation } from "../../features/machine/plan.ts";
import { deliverPlugins, withPluginPlan } from "../../features/opencode/delivery.ts";
import { type Declaration, readDeclarations } from "../../features/opencode/declarations.ts";
import { syncTools } from "../../features/mise-integration/delivery.ts";
import { type Office } from "../../office.ts";
import { removePackage, writeOfficeDeclaration } from "../sources/copies.ts";
import { prepareAppliedSettings, publishAppliedSettings } from "../../applied-settings.ts";
import { publishToolsLocation } from "../../features/tools/applied.ts";
import { failure, isFailure, type Change } from "../../lib/change.ts";
import { appliedSettingsPath } from "../../../sdk/applied-settings.ts";
import { excludeAppliedSettings, excludedPath, excludePlumbing, updateExcludedOrThrow } from "../../exclude-plumbing.ts";

/**
 * Applies a published package set from its gathering. While a selected package is unread (this
 * sync couldn't fetch it), what it claims is unknown, so the applied settings aren't published, no
 * package's sync function runs and no package's tools or machine files are reconciled; the
 * others' OpenCode plugins and panels are still delivered, and the unread package's stay as the
 * last sync left them. Returns the paths the sync functions excluded from commits.
 */
export async function applyPackages(office: Office, gathered: Gathered, changes: Change[], exclude: boolean, withdrawals: string): Promise<string[]> {
  const installed = gathered.inventory;

  // Before any plugin is linked, so a plugin can watch for settings even before they're published.
  prepareAppliedSettings(office);

  // .office/packages/ holds only what sync pulled in, so a folder no package wants goes. Its panel
  // stays on the app's machine, where other offices may use it.
  const removedPanels: string[] = [];
  let declarations: Map<string, Declaration> | undefined;

  for (const name of readdirSync(withdrawals)) {
    if (installed.unread.has(name) || installed.selected.has(name)) continue;

    // The last synced registration names the bundle.
    const claim = (declarations ??= readDeclarations(office)).get(name);
    const bundle = claim?.state === "declared" ? claim.paths.panel : undefined;

    if (bundle !== undefined && existsSync(join(withdrawals, name, bundle))) removedPanels.push(name);

    changes.push(...removePackage(office, name, join(withdrawals, name)));
    rmSync(join(withdrawals, name), { recursive: true });
  }

  for (const item of installed.installed) changes.push(...writeOfficeDeclaration(office, item));

  // The machine is reconciled in either mode (container mode releases the host's files), and
  // packages' sync functions run, only once every selected package loaded. A sync function that
  // throws stops the rest, plugins and panels included.
  const paths = new Set<string>();

  if (gathered.unread.size) {
    const unknown = [...gathered.unread].join(", ");

    changes.push(`not publishing the applied settings: package ${unknown} is selected but unread, so they would be incomplete`, `not running any package's sync function: what package ${unknown} registers is unknown until a sync loads it`, `not reconciling any package's tools or machine files: what package ${unknown} claims is unknown until a sync loads it`);
  } else {
    // Before any hook or delivery, so each sees the settings it is applied with. A hook that
    // throws later leaves them published, and excluded from commits. Settings Git wouldn't
    // ignore aren't published: the application stops, any earlier snapshot left as it was.
    const exclusion = excludeAppliedSettings(office);

    changes.push(...exclusion);

    if (exclusion.some(isFailure)) throw new Error(`not publishing the applied settings: ${appliedSettingsPath} isn't kept out of commits (above)`);
    changes.push(...publishAppliedSettings(office, installed.installed));
    changes.push(...publishToolsLocation(office));

    for await (const result of runPackageHooks(office, gathered, { phase: "sync", exclude: additions => {
      for (const path of additions) paths.add(excludedPath(path));
    }, updateExcluded: change => updateExcludedOrThrow(office, change) })) {
      if (!result.ok) throw new SyncStopped(result.problem, "hook");
      changes.push(...result.lines);
    }

    changes.push(...syncTools(office, gathered.packages, [...gathered.selected]), ...syncMachine(office, machineReconciliation, gathered));
  }

  let plan: ReturnType<typeof withPluginPlan>;

  try {
    plan = withPluginPlan(office, { ...installed, problems: [] }, gathered.assets);

    changes.push(...plan.problems.map((problem) => failure(`FAILED package ${problem.packages.join(", ")}: ${problem.message}`)));

    if (plan.conflict) throw new Error("a plugin destination belongs to the owner");
    changes.push(...deliverPlugins(office, plan, path => updateExcludedOrThrow(office, { add: [path] })));
  } catch (error) {
    throw new SyncStopped(error instanceof Error ? error.message : String(error), "plugins", { cause: error });
  }

  changes.push(...installPanels(office, plan.panels, removedPanels));
  changes.push(...linkForEditors(office.dir));

  const excluded = [...paths].sort();

  if (exclude && !gathered.unread.size) changes.push(...excludePlumbing(office, gathered.committed, excluded));

  return excluded;
}

export class SyncStopped extends Error {
  constructor(message: string, readonly step: "hook" | "plugins", options?: ErrorOptions) {
    super(message, options);
  }
}

/**
 * Installs each package's desktop app panel on the machine the app runs on, and says how to remove
 * the panel of a package that left office.yaml. The app machine is looked up only when there is a
 * panel to handle; inside the container, or when it can't be reached, nothing is installed.
 */
function installPanels(office: Office, bundles: ReadonlyMap<string, string>, removed: string[]): Change[] {
  const panels = [...bundles].map(([name, bundle]) => ({ name, bundle }));

  if (panels.length === 0 && removed.length === 0) return [];

  const where = locate();
  const names = panels.map((panel) => panelId(panel.name)).join(", ");

  if (where.kind === "container") return panels.length === 0 ? [] : [`not installing panels (${names}) from the container: they install on the desktop app's machine, so run office sync on the host`];

  if (where.kind === "unreachable") return panels.length === 0 ? [] : [`not installing panels (${names}): ${where.reason}`];

  return [...panels.flatMap((panel) => installPanel(where.machine, office, panel)), ...removed.map((name) => removalNote(where.machine, name))];
}
