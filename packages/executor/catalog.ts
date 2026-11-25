// Executor's installed apps and its catalog: which catalog apps to install, installing them, and
// adopting one's source into the office as `executor-apps/<id>/`.
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { ExecutorAccess } from "@office/sdk";
import { adoptionMarker, type AppFolder, rootFolder } from "./inventory.ts";

export type ExecutorApp = {
  id: string;
  slug: string;
  copiedFrom?: { name?: string | null } | null;
  activeVersion?: string | null;
  requirements?: { accounts?: Record<string, { scope?: string; provider?: string }> | null } | null;
};

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** A response that isn't what Executor's API documents, named by its request. */
export const unexpected = (what: string) => new Error(`Executor: unexpected response for ${what}`);

function isApp(value: unknown): value is ExecutorApp {
  return isObject(value) && typeof value.id === "string" && typeof value.slug === "string";
}

type CatalogEntry = { id: string; package: string };

function isCatalogEntry(value: unknown): value is CatalogEntry {
  return isObject(value) && typeof value.id === "string" && typeof value.package === "string";
}

/** The `apps` framework version Executor serves. */
export async function frameworkVersion(executor: ExecutorAccess, base: string): Promise<string> {
  const release = await executor.request<unknown>("GET", `${base}/framework/release`);

  if (!isObject(release) || typeof release.version !== "string") throw unexpected(`${base}/framework/release`);

  return release.version;
}

/** The organization path every app request is under. */
export async function organizationPath(executor: ExecutorAccess): Promise<string> {
  const context = await executor.request<unknown>("GET", "/api/context");

  if (!isObject(context) || typeof context.organization !== "string") throw unexpected("/api/context");

  return `/api/organizations/${context.organization}`;
}

export async function installedApps(executor: ExecutorAccess, base: string): Promise<ExecutorApp[]> {
  const apps = await executor.request<unknown>("GET", `${base}/apps`);

  if (!Array.isArray(apps) || !apps.every(isApp)) throw unexpected(`${base}/apps`);

  return apps;
}

export type CatalogItem = { id: string; pkg: string; existing: ExecutorApp | undefined };

/** Plans every listed catalog app before installing any; a same-name app isn't proof of its origin. */
export async function catalogPlan(executor: ExecutorAccess, base: string, ids: readonly string[], apps: readonly ExecutorApp[], folders: readonly AppFolder[]): Promise<CatalogItem[]> {
  return Promise.all(ids.map(async id => {
    const local = folders.filter(folder => folder.slug === id);

    if (local.some(folder => !folder.adopted)) throw new Error(`catalog app ${id} conflicts with a local app folder; rename one of them`);

    const path = `${base}/catalog?search=${encodeURIComponent(id)}&limit=100`;
    const entries = await executor.request<unknown>("GET", path);

    if (!Array.isArray(entries) || !entries.every(isCatalogEntry)) throw unexpected(path);
    const item = entries.find(candidate => candidate.id === id);

    if (!item) throw new Error(`Executor catalog has no exact entry ${id}; check the ID and that the catalog is enabled`);

    const existing = apps.find(app => app.slug === id);

    if (existing && existing.copiedFrom?.name !== item.package) throw new Error(`Executor app ${id} exists but is not from ${item.package}`);

    return { id, pkg: item.package, existing };
  }));
}

/** Installs each planned app that isn't there yet, adding it to `apps`; returns what it did. */
export async function installMissing(executor: ExecutorAccess, base: string, plan: readonly CatalogItem[], apps: ExecutorApp[]): Promise<string[]> {
  const lines: string[] = [];

  for (const { id, pkg, existing } of plan) {
    if (existing) continue;
    const app = await executor.request<unknown>("POST", `${base}/apps/install`, { entry: id, name: id });

    if (!isApp(app)) throw unexpected(`${base}/apps/install`);

    if (app.slug !== id || app.copiedFrom?.name !== pkg) throw new Error(`Executor installed ${app.slug} instead of the expected ${id} from ${pkg}; inspect the apps before retrying`);

    apps.push(app);
    lines.push(`installed catalog app ${id} (${app.id})`);
  }

  return lines;
}

const reservedParts = new Set(["", ".", "..", ".git", "node_modules", adoptionMarker]);

type WorkspaceFile = { path: string; content: string; encoding?: "base64" };

/** One file of an app's source as adoption writes it: a plain relative path, and its bytes. */
function workspaceFile(id: string, file: unknown): WorkspaceFile {
  if (!isObject(file)) throw unexpected(`${id}'s source`);
  const { path, content, encoding } = file;

  if (typeof path !== "string" || path.includes("\\") || path.includes("\0") || path.split("/").some(part => reservedParts.has(part))) throw new Error(`${id}: invalid app source path ${JSON.stringify(path)}`);

  if (typeof content !== "string") throw new Error(`${id}: source bytes unavailable; clone the app from Executor instead`);

  if (encoding === undefined) return { path, content };

  if (encoding !== "base64") throw new Error(`${id}: unknown encoding for ${path}`);

  return { path, content, encoding };
}

/**
 * Copies installed catalog app `id`'s source into `executor-apps/<id>/` with the adoption marker,
 * never over an existing folder and never leaving a partial copy. Returns what it did.
 */
export async function adoptCatalog(officeDir: string, catalogApps: readonly string[], id: string, executor: ExecutorAccess, folders: readonly AppFolder[]): Promise<string> {
  if (!catalogApps.includes(id)) throw new Error(`list ${id} in the executor package's catalog_apps setting in office.yaml first`);

  const base = await organizationPath(executor);
  const [item] = await catalogPlan(executor, base, [id], await installedApps(executor, base), folders);
  const app = item.existing;

  if (!app) throw new Error(`catalog app ${id} isn't installed; run office apps deploy first`);

  const parent = join(officeDir, rootFolder);
  const dir = join(parent, id);

  if (existsSync(dir)) throw new Error(`${dir} already exists; adoption will not overwrite it`);

  const path = `${base}/apps/${app.id}/source`;
  const source = await executor.request<unknown>("GET", path);

  if (!isObject(source) || !Array.isArray(source.files)) throw unexpected(path);
  const files = source.files.map(file => workspaceFile(id, file));

  if (!["package.json", "index.ts"].every(name => files.some(file => file.path === name))) throw new Error(`${id}: source needs package.json and index.ts`);

  mkdirSync(parent, { recursive: true });

  if (realpathSync(parent) !== join(realpathSync(officeDir), rootFolder)) throw new Error(`${parent} must not be a symlink`);
  mkdirSync(dir);

  try {
    for (const file of files) {
      const target = join(dir, file.path);

      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content, { encoding: file.encoding ?? "utf8", flag: "wx" });
    }

    writeFileSync(join(dir, adoptionMarker), `${id}\n`);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }

  return `adopted ${id} (${app.id}) into ${rootFolder}/${id}; commit its source and use office apps deploy after editing`;
}
