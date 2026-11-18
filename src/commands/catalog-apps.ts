import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as v from "valibot";

import { OfficeError, type Office } from "../office.ts";
import { check } from "../schema.ts";
import type { AppFolder, Call, ExecutorApp } from "./apps.ts";

export const adoptionMarker = ".office-catalog";

const entry = v.object({ id: v.string(), package: v.string() });
const installed = v.object({ id: v.string(), slug: v.string(), copiedFrom: v.nullish(v.object({ name: v.nullish(v.string()) })) });

const sourcePath = v.pipe(v.string(), v.check((path) => !path.includes("\\") && !path.includes("\0") &&
  path.split("/").every(part => !["", ".", "..", ".git", "node_modules", adoptionMarker].includes(part)), "invalid app source path"));

const workspace = v.object({ files: v.array(v.object({ path: sourcePath, content: v.string("source bytes unavailable; clone the app from Executor instead"), encoding: v.optional(v.literal("base64")) })) });

function parse<S extends v.GenericSchema>(schema: S, value: v.InferInput<S>): v.InferOutput<S> {
  const result = check(v.safeParse(schema, value));

  if (!result.ok) throw new OfficeError(`Executor: ${result.errors.join("; ")}`);

  return result.value;
}

export async function installedApps(call: Call, base: string) {
  return parse(v.array(installed), await call<ExecutorApp[]>("GET", `${base}/apps`));
}

/** Plan all entries before installing any; a same-name app isn't proof of its origin. */
export async function catalogPlan(call: Call, base: string, ids: string[], apps: ExecutorApp[], folders: AppFolder[]) {
  return Promise.all(ids.map(async id => {
    const local = folders.filter(folder => folder.slug === id);
    const collision = local.some(folder => !folder.adopted) || local.length > 1;

    if (collision) throw new OfficeError(`catalog app ${id} conflicts with a local app folder; rename one of them`);

    const entries = parse(v.array(entry), await call<v.InferInput<typeof entry>[]>("GET", `${base}/catalog?search=${encodeURIComponent(id)}&limit=100`));
    const item = entries.find(candidate => candidate.id === id);

    if (!item) throw new OfficeError(`Executor catalog has no exact entry ${id}; check the ID and that the catalog is enabled`);

    const existing = apps.find(app => app.slug === id);

    if (existing && existing.copiedFrom?.name !== item.package) throw new OfficeError(`Executor app ${id} exists but is not from ${item.package}`);

    return { id, pkg: item.package, existing };
  }));
}

export async function installMissing(call: Call, base: string, plan: Awaited<ReturnType<typeof catalogPlan>>, apps: ExecutorApp[]) {
  for (const { id, pkg, existing } of plan) {
    if (existing) continue;
    const app = parse(installed, await call<ExecutorApp>("POST", `${base}/apps/install`, { entry: id, name: id }));

    if (app.slug !== id || app.copiedFrom?.name !== pkg) throw new OfficeError(`Executor installed ${app.slug} instead of the expected ${id} from ${pkg}; inspect the apps before retrying`);

    apps.push(app);
    console.log(`installed catalog app ${id} (${app.id})`);
  }
}

export async function adoptCatalog(office: Office, id: string, call: Call, folders: AppFolder[]) {
  if (!office.catalogApps.includes(id)) throw new OfficeError(`declare ${id} in executor.catalog_apps in office.yaml first`);

  const { organization } = await call<{ organization: string }>("GET", "/api/context");
  const base = `/api/organizations/${organization}`;
  const [item] = await catalogPlan(call, base, [id], await installedApps(call, base), folders);
  const app = item.existing;

  if (!app) throw new OfficeError(`catalog app ${id} isn't installed; run office apps deploy first`);

  const parent = join(office.dir, "executor-apps");
  const dir = join(parent, id);

  if (existsSync(dir)) throw new OfficeError(`${dir} already exists; adoption will not overwrite it`);

  const source = parse(workspace, await call<v.InferInput<typeof workspace>>("GET", `${base}/apps/${app.id}/source`));

  if (!["package.json", "index.ts"].every(path => source.files.some(file => file.path === path))) throw new OfficeError(`${id}: source needs package.json and index.ts`);

  mkdirSync(parent, { recursive: true });

  if (realpathSync(parent) !== join(realpathSync(office.dir), "executor-apps")) throw new OfficeError(`${parent} must not be a symlink`);
  mkdirSync(dir);

  try {
    for (const file of source.files) {
      const path = join(dir, file.path);

      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.content, { encoding: file.encoding ?? "utf8", flag: "wx" });
    }

    writeFileSync(join(dir, adoptionMarker), `${id}\n`);
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }

  console.log(`adopted ${id} (${app.id}) into executor-apps/${id}; commit its source and use office apps deploy after editing`);
}
