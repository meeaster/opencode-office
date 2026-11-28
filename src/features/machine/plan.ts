import { globalConfD, miseRemovalReason, prepareConfD, wantedMiseFiles } from "../mise-integration/machine-files.ts";
import { isCurrentServerUnit, removeServerFile, serverRemovalReason } from "../opencode/server-units.ts";
import { firewallRemovalReason, firstFirewallInstallNotice, missingSfw, removeEmptyFirewallFolders, sfwLine, wantedFirewall } from "../tools/firewall.ts";
import { wantedEnvironment } from "./host-env.ts";
import type { PlanContext, Reconciliation, WantedFiles } from "./owned-files.ts";
import { envFilePath } from "./paths.ts";
import { consentCommand } from "./record.ts";

export function machinePlan(context: PlanContext): WantedFiles {
  const environment = wantedEnvironment(context);
  const links = wantedMiseFiles(context);
  const firewall = wantedFirewall(context.office);

  return {
    wanted: [...links, environment.entry, ...firewall.wanted],
    problems: [...environment.problems, ...firewall.problems],
  };
}

export const machineReconciliation = {
  plan: machinePlan,
  currentManagedFile: isCurrentServerUnit,
  removeManagedFile: removeServerFile,
  removalReason(office, file) {
    return serverRemovalReason(file) ?? miseRemovalReason(office, file) ?? firewallRemovalReason(office, file) ?? "as machine.toml is gone";
  },
  removeEmptyFolders: removeEmptyFirewallFolders,
  prepareFolders: prepareConfD,
  syncWithoutConsent(office) {
    const firewall = office.socketFirewall ? ", and package downloads don't go through Socket Firewall" : "";

    return `not linking machine.toml, machine.packages.toml and .office/mise/ into ${globalConfD()} or writing ${envFilePath()} yet, so the office's tools apply nowhere${firewall}: office writes outside its folder only once you agree; run ${consentCommand}`;
  },
  afterPlacement: firstFirewallInstallNotice,
  initialReport() {
    if (!process.env.MISE_GLOBAL_CONFIG_FILE) return [];

    return [{ ok: "warn", name: "machine", detail: "MISE_GLOBAL_CONFIG_FILE is set here, which makes mise ignore its global conf.d and so the office's linked tools; unset it" }];
  },
  reportWithoutConsent() {
    return { ok: false, name: "machine", detail: `no consent for this office to manage this machine, so machine.toml and the packages' tools in machine.packages.toml apply nowhere and ${envFilePath()} isn't written; run ${consentCommand}, then office sync` };
  },
  reportDeferredFile: sfwLine,
  missingDeferredFile: missingSfw,
} satisfies Reconciliation;
