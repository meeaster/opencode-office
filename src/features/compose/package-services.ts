// CLI adapter: both definition readers already resolve to InstalledPackage. Compose receives
// native package inputs and applied state; secret declarations and their values stay here.
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import * as compose from "./services.ts";
import { type InstalledPackage, installedPackages, type InstalledPackages } from "../../loader/definitions/inventory.ts";
import { type Office, OfficeError, readEnvFile } from "../../office.ts";
import { say } from "../../report/index.ts";
import type { PackageManifest } from "../../loader/sources/manifest-schema.ts";

export function secretsPath(office: Office, name: string): string {
  return join(office.state, "packages", `${name}.env`);
}

export function packageSecret(office: Office, name: string, key: string): string {
  const item = installedPackages(office).installed.find(({ entry }) => entry.name === name);

  if (!item || !Object.hasOwn(item.manifest.secrets, key)) throw new OfficeError(`no installed package ${name} declares ${key}`);
  const values = readEnvFile(secretsPath(office, name));

  if (!Object.hasOwn(values, key)) throw new OfficeError(`${name}: ${key} has not been generated; run office up`);

  return values[key];
}

/** A new value for one of a package's secrets. */
function generateSecret(secret: PackageManifest["secrets"][string]): string {
  return `${secret.prefix ?? ""}${randomBytes(secret.bytes).toString(secret.generate)}`;
}

/**
 * Adds each of `secrets` missing from the env file at `path` (mode 600) and returns the names it
 * added. An existing value is never replaced: services sign users in and encrypt with them.
 */
export function ensureSecrets(path: string, secrets: PackageManifest["secrets"]): string[] {
  const existing = readEnvFile(path);
  const missing = Object.keys(secrets).filter((key) => existing[key] === undefined);
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  const lines = missing.map((key) => `${key}=${generateSecret(secrets[key])}\n`);

  writeFileSync(path, `${before}${before === "" || before.endsWith("\n") ? "" : "\n"}${lines.join("")}`, { mode: 0o600 });
  chmodSync(path, 0o600);

  return missing;
}

function source(item: InstalledPackage): compose.ComposeSource {
  return { name: item.entry.name, namespace: item.manifest.namespace, dir: item.dir, settings: item.settings, spawnLabel: item.manifest.spawns?.label };
}

export function sharedNamespaces(installed: InstalledPackage[]) {
  return compose.sharedNamespaces(installed.map(source));
}

export function serviceStatus(office: Office, item: InstalledPackage) {
  return compose.serviceStatus(office, source(item));
}

/** `inventory` is the caller's packages, read here when it has none. */
export async function preparePackageServices(office: Office, upgrade: boolean, inventory: InstalledPackages = installedPackages(office)) {
  const { installed, selected } = inventory;
  const plan = compose.prepareServices(office, installed.map(source), selected, upgrade);
  const envFile = (name: string) => secretsPath(office, name);

  const apply = () => {
    const { dropped, includes } = plan.applyDefinitions(envFile);

    for (const item of installed) {
      const name = item.entry.name;
      const include = includes.get(name);

      // Active Compose includes need an env file even with no declarations. Packages with
      // declarations need their values even without a Compose service (e.g. a host unit).
      if (include === undefined && Object.keys(item.manifest.secrets).length === 0) continue;
      const path = envFile(name);

      for (const key of ensureSecrets(path, item.manifest.secrets)) say(`generated ${key} for package ${name} in ${path}`, "office: ");
      include?.();
    }

    return dropped;
  };

  return { upgraded: plan.upgraded, apply };
}
