import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { argument, quoted, requireLocalUnit, unitDir } from "./systemd.ts";
import { machineDir, miseShims } from "./host-env.ts";
import { userSystemd } from "./host-server.ts";
import { installedPackages, type InstalledPackages } from "./layout.ts";
import { machineRecordPath } from "./machine.ts";
import { type Office, OfficeError } from "./office.ts";
import { hostApplies } from "./package-tools.ts";
import { say } from "./report/index.ts";
import { officeCommand } from "./tool.ts";

// Different marker from the office's cron services: each reconciler owns only its units.
const marker = (office: Office) => `# office package services: ${office.dir}\n`;

// Capture profile directories, not the caller's shell environment. Leave the user manager's
// PATH as the fallback for system utilities; a caller's cwd, aliases and login shell aren't needed.
function launch(office: Office, dir: string, script: string) {
  const command = officeCommand();
  const home = homedir();
  const path = [...new Set([dirname(command), join(home, ".local/bin"), resolve(miseShims()), resolve(process.env.BUN_INSTALL || join(home, ".bun"), "bin")])].join(":");
  const profile = [`HOME=${home}`, `OFFICE_MACHINE_RECORD=${resolve(machineRecordPath())}`, `OFFICE_MACHINE_DIR=${resolve(machineDir())}`, "MISE_AUTO_INSTALL=0", "MISE_NOT_FOUND_AUTO_INSTALL=0"];

  for (const key of ["XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "MISE_CONFIG_DIR", "MISE_DATA_DIR", "MISE_STATE_DIR", "MISE_CACHE_DIR", "CODEX_HOME"]) {
    const value = process.env[key];

    if (value) profile.push(`${key}=${resolve(value)}`);
  }

  const setup = [
    'export PATH="$1:$PATH"',
    '[[ -x "$2" ]] || { echo "Office launcher missing: $2; restore it or run office up --upgrade from its new location" >&2; exit 127; }',
    'env_script=$("$2" --office "$3" env host-service "$4") || { echo "Cannot load host service environment; check the machine record and run office up --upgrade with a compatible launcher" >&2; exit 1; }',
    'source /dev/stdin <<< "$env_script"',
    'export MISE_AUTO_INSTALL=0 MISE_NOT_FOUND_AUTO_INSTALL=0',
    'cd -- "$5"',
    'exec /bin/bash "$6"',
  ].join("; ");

  const args = ["/bin/bash", "-ec", setup, "office", path, command, office.dir, office.name, dir, script];

  return [...profile.map(value => `Environment=${quoted(value)}`), `ExecStart=${args.map(argument).join(" ")}`].join("\n");
}

function units(office: Office, packages: ReturnType<typeof installedPackages>) {
  const wanted = new Map<string, string>();

  for (const item of packages.installed) {
    if (!hostApplies(office, item)) continue;

    for (const [id, service] of Object.entries(item.manifest.host?.services ?? {})) {
      if (service.setting !== undefined && !item.settings[service.setting]) continue;
      const name = `office-${office.name}-pkg-${item.entry.name}.${id}.service`;
      wanted.set(name, `${marker(office)}[Unit]\nDescription=${service.description.replaceAll("%", "%%")}\n\n[Service]\nType=exec\n${launch(office, item.dir, service.script)}\nUMask=0077\nRestart=on-failure\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`);
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

/** `inventory` is the caller's packages, read here when it has none; `down` reads none. */
export function reconcileHostServices(office: Office, action: "up" | "upgrade" | "down", inventory?: InstalledPackages) {
  const packages = action === "down" ? undefined : inventory ?? installedPackages(office);

  if (packages?.problems.length) throw new OfficeError(packages.problems.map(problem => problem.message).join("\n"));
  const wanted = packages === undefined ? new Map<string, string>() : units(office, packages);
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

export function hostServiceStatus(office: Office, report: (ok: boolean, name: string, detail: string) => void, inventory: InstalledPackages = installedPackages(office)) {
  const owned = installed(office);
  const wanted = units(office, inventory);

  for (const [name, body] of wanted) {
    const previous = owned.get(name);
    const active = previous !== undefined && userSystemd(["show", "--property=ActiveState", "--value", name]) === "active";
    const detail = !active ? "not active; run office up" : previous !== body ? "definition changed; run office up --upgrade" : "active";

    report(active && previous === body, name, detail);
  }

  for (const name of owned.keys()) if (!wanted.has(name)) report(false, name, "obsolete; run office up");
}
