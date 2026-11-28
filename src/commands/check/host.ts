import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";

import { envFilePath } from "../../features/machine/paths.ts";
import { hostWrappers, sourceLine, sourcedBy } from "../../features/machine/host-env.ts";
import { officeCommands, officePins, officeTool, officeToolNamed, type OfficeTool, required } from "../../features/tools/host-tools.ts";
import { claim } from "../../features/machine/record.ts";
import { wrappedCommands } from "../../features/tools/sfw.ts";
import { machineFile, packagesFile } from "../../features/mise-integration/delivery.ts";
import { toolPins } from "../../features/mise-integration/mise-toml.ts";
import { type Office, OfficeError } from "../../office.ts";
import type { Report } from "./context.ts";

/**
 * The tools the office CLI runs, the office package's: whether this host has the versions
 * machine.packages.toml pins (in a host-mode office, the shared tools office up applied), and
 * which of them the office's own mise files pin too.
 */
export function officeToolChecks(office: Office, report: Report): void {
  const host = office.opencode.mode === "host";
  const install = host ? "office up installs it (office setup --install-deps, until then)" : "office setup --install-deps installs it";
  const found: string[] = [];

  const pins = officePins(office);

  for (const command of officeCommands) {
    let tool: OfficeTool | undefined;

    try {
      tool = officeTool(office, command);
    } catch (error) {
      if (!(error instanceof OfficeError)) throw error;
      report(false, `office tool ${command}`, error.message);

      continue;
    }

    if (tool?.managed === true) {
      found.push(`${command} ${tool.version}`);

      continue;
    }

    const version = pins[command === "age-keygen" ? "age" : command];
    const pin = host ? `office up hasn't applied the office package's ${command} on this machine` : version === undefined ? `the office package's ${command} isn't in ${packagesFile} (office sync writes it)` : `mise hasn't installed ${command} ${version}, the office's pin, on this host`;
    const detail = tool === undefined ? `${pin}, and there is no other copy; ${install}` : `${pin}, so office runs ${command} ${tool.version} from ${tool.path}; ${install}`;

    report(tool === undefined && required.includes(command) ? false : "warn", `office tool ${command}`, detail);
  }

  if (found.length > 0) report(true, "office tools", `${found.join(", ")}: ${host ? "the versions office up applied" : `the versions ${packagesFile} pins, as mise installed them`}`);

  const files = ["mise.toml", machineFile];

  const duplicates = files.flatMap((file) => {
    const path = join(office.dir, file);
    const pins = existsSync(path) ? toolPins(readFileSync(path, "utf8")).filter((pin) => officeToolNamed(pin.tool) !== undefined) : [];

    return pins.length === 0 ? [] : [`${file} pins ${pins.map((pin) => `${pin.tool} ${pin.version}`).join(" and ")}`];
  });

  if (duplicates.length > 0) {
    report("warn", "office tools", host ? `${duplicates.join("; ")}, which the office package now requires as shared tools: machine.toml's exact pin holds office bump's selection, and mise.toml's applies only in the office folder, where agents can run another version than the office CLI does; you can remove these pins unless one holds a tool back on purpose` : `${duplicates.join("; ")}, which the office package now provides in ${packagesFile}; you can remove these pins unless one holds a tool back on purpose. Where such a pin applies it wins over the package's, so agents can run another version than the office CLI does`);
  }
}

/** An age as hours when it is one office.yaml can hold (36h, 3d, 2w), else undefined. */
function hours(age: string): number | undefined {
  const match = /^(\d+)([hdw])$/.exec(age);

  return match === null ? undefined : Number(match[1]) * (match[2] === "h" ? 1 : match[2] === "d" ? 24 : 168);
}

/**
 * Notes on office.yaml's `tools`, none a failure: a `[settings] minimum_release_age` in the office's machine.toml or mise.toml
 * other than the office's, which MISE_MINIMUM_RELEASE_AGE in the office's environment overrides.
 */
export function toolsNotes(office: Office): string[] {
  const { tools } = office;
  const notes: string[] = [];

  for (const name of ["machine.toml", "mise.toml"]) {
    const path = join(office.dir, name);
    let setting: string | undefined;

    try {
      if (!existsSync(path)) continue;
      const read = v.safeParse(v.object({ settings: v.object({ minimum_release_age: v.string() }) }), Bun.TOML.parse(readFileSync(path, "utf8")));

      if (read.success) setting = read.output.settings.minimum_release_age;
    } catch {
      continue;
    }

    if (setting === undefined || setting === tools.minimumReleaseAge) continue;

    const same = hours(setting);

    if (same !== undefined && same === hours(tools.minimumReleaseAge)) continue;

    notes.push(`${name} sets minimum_release_age = "${setting}" under [settings], but the office's environment sets MISE_MINIMUM_RELEASE_AGE=${tools.minimumReleaseAge} (minimum_release_age in office.yaml), which wins wherever it is loaded; remove the setting or change the office's age`);
  }

  return notes;
}

/** Whether Socket Firewall is on, and where it applies in the office's mode. */
export function firewallChecks(office: Office, report: Report): void {
  const age = office.tools.minimumReleaseAge;
  const ages = hours(age) === 0 ? "package managers and mise take releases as soon as they're published (minimum_release_age: 0)" : `package managers and mise take only releases at least ${age} old`;

  if (!office.socketFirewall) {
    report("warn", "Socket Firewall", `off (enabled: false for sfw under tools in office.yaml): package downloads aren't checked; ${ages}`);

    return;
  }

  if (office.opencode.mode === "host" && claim(office).kind !== "ours") {
    report("warn", "Socket Firewall", "on in office.yaml, but nothing is installed on this machine until the office may manage it (see the machine line), so package downloads here aren't checked");

    return;
  }

  report(
    true,
    "Socket Firewall",
    office.opencode.mode === "host"
      ? `on: ${wrappedCommands.join(", ")} and mise installs go through sfw, from ${hostWrappers()} first on PATH in ${envFilePath()} (each file is on its machine line below); ${ages}`
      : `on: the image's sfw, with ${wrappedCommands.join(", ")} and mise wrapped, first on PATH in the container (office env --container shows the file); office up rebuilds the image when the pin moves; ${ages}`,
  );
}

/**
 * Whether the user's shell startup sources the environment file: a note, never a failure, since
 * office never edits those files and can't see every way a shell could source it.
 */
export function shellCheck(report: Report): void {
  const where = sourcedBy();

  report(
    where === undefined ? "warn" : true,
    "shell environment",
    where === undefined ? `no shell startup file sources ${envFilePath()} that office can see, so your terminal's package managers bypass Socket Firewall; add after mise activate in ~/.zshrc: ${sourceLine()}` : `sourced from ${where}`,
  );
}
