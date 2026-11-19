import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { argument, requireLocalUnit, unitDir } from "./cron/host.ts";
import { envFilePath } from "./host-env.ts";
import { userSystemd } from "./host-server.ts";
import { installedPackages } from "./layout.ts";
import { type Office, OfficeError } from "./office.ts";
import { hostApplies } from "./package-tools.ts";
import { say } from "./report/index.ts";

// Different marker from the office's cron services: each reconciler owns only its units.
const marker = (office: Office) => `# office package services: ${office.dir}\n`;

function units(office: Office, packages: ReturnType<typeof installedPackages>) {
  const wanted = new Map<string, string>();

  for (const item of packages.installed) {
    if (!hostApplies(office, item)) continue;

    for (const [id, service] of Object.entries(item.manifest.host?.services ?? {})) {
      if (service.setting !== undefined && !item.settings[service.setting]) continue;
      const name = `office-${office.name}-pkg-${item.entry.name}.${id}.service`;
      const args = ["/bin/bash", "-ec", 'export PATH="$HOME/.local/bin:$PATH"; source "$1"; cd -- "$2"; exec /bin/bash "$3"', "office", envFilePath(), item.dir, service.script];

      wanted.set(name, `${marker(office)}[Unit]\nDescription=${service.description.replaceAll("%", "%%")}\n\n[Service]\nType=exec\nExecStart=${args.map(argument).join(" ")}\nUMask=0077\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`);
    }
  }

  return wanted;
}

function installed(office: Office) {
  const dir = unitDir();
  const owned = new Map<string, string>();

  if (!existsSync(dir)) return owned;

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(`office-${office.name}-pkg-`) || !entry.name.endsWith(".service")) continue;
    const body = readFileSync(join(dir, entry.name), "utf8");

    if (body.startsWith(marker(office))) owned.set(entry.name, body);
  }

  return owned;
}

export function reconcileHostServices(office: Office, action: "up" | "upgrade" | "down") {
  const packages = installedPackages(office);

  if (action !== "down" && packages.problems.length) throw new OfficeError(packages.problems.map(problem => problem.message).join("\n"));
  const wanted = action === "down" ? new Map<string, string>() : units(office, packages);
  const owned = installed(office);
  const dir = unitDir();

  for (const name of new Set([...owned.keys(), ...wanted.keys()])) {
    if (!owned.has(name) && lstatSync(join(dir, name), { throwIfNoEntry: false })) throw new OfficeError(`${name} is not this office's package service`);
    requireLocalUnit(name);
  }

  for (const name of owned.keys()) {
    if (wanted.has(name)) continue;
    userSystemd(["disable", "--now", name]);
    rmSync(join(dir, name));
    userSystemd(["daemon-reload"]);
  }

  for (const [name, body] of wanted) {
    const previous = owned.get(name);
    const changed = previous !== undefined && body !== previous;

    if (previous === undefined || (changed && action === "upgrade")) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), body);
      userSystemd(["daemon-reload"]);

      if (changed) userSystemd(["restart", name]);
    }

    userSystemd(["enable", "--now", name]);
    userSystemd(["is-active", "--quiet", name]);
    say(`host service ${name}: active${changed && action !== "upgrade" ? " (definition changed; office up --upgrade applies it)" : ""}`);
  }
}

export function hostServiceStatus(office: Office, report: (ok: boolean, name: string, detail: string) => void) {
  const owned = installed(office);
  const wanted = units(office, installedPackages(office));

  for (const [name, body] of wanted) {
    const previous = owned.get(name);
    const active = previous !== undefined && userSystemd(["show", "--property=ActiveState", "--value", name]) === "active";
    const detail = !active ? "not active; run office up" : previous !== body ? "definition changed; run office up --upgrade" : "active";

    report(active && previous === body, name, detail);
  }

  for (const name of owned.keys()) if (!wanted.has(name)) report(false, name, "obsolete; run office up");
}
