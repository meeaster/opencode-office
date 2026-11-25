// The apps a session is told about: the office's own `executor-apps/<slug>/` as they are when the
// session starts, the apps packages contributed at the last sync (which `sync` records, since a
// session gets no registry entries), and the catalog apps the settings list.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Entry } from "@office/sdk";
import type { App } from "./apps.ts";
import { contributedFolder, readManifest, rootAppNames, rootFolder } from "./inventory.ts";

/** Where `sync` records the contributed apps for `session`, in the office's uncommitted `.office/`. */
export const contributedFile = ".office/executor/contributed.json";

type Contributed = { slug: string; owner: string; description?: string };

/** An app's description from its package.json: its description, else its Executor title. */
function description(dir: string): string | undefined {
  // An unfinished manifest should not take a session's instructions away.
  try {
    const manifest = readManifest(dir);
    const text = manifest?.description;
    const title = manifest?.executor?.title;

    if (typeof text === "string" && text.trim()) return text.trim();

    return typeof title === "string" ? title : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Records the contributed apps as this sync gathered them, leaving out any outside its package or
 * without package.json, which deploy names instead; returns nothing to print.
 */
export function recordContributed(officeDir: string, entries: readonly Entry<App>[]): void {
  const apps: Contributed[] = entries.flatMap((entry) => {
    let dir: string;

    try {
      dir = contributedFolder(officeDir, entry).dir;
    } catch {
      return [];
    }

    return [{ slug: entry.namespace, owner: entry.owner, description: description(dir) }];
  });
  const path = join(officeDir, contributedFile);

  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(apps, null, 2)}\n`);
}

function readContributed(officeDir: string): Contributed[] {
  try {
    const apps: unknown = JSON.parse(readFileSync(join(officeDir, contributedFile), "utf8"));

    return Array.isArray(apps) ? apps.filter((app): app is Contributed => typeof app?.slug === "string" && typeof app?.owner === "string") : [];
  } catch {
    return [];
  }
}

const line = (name: string, text: string | undefined) => (text === undefined ? `- ${name}` : `- ${name}: ${text}`);

/** The session's section on Executor apps, or "" when the office has none. */
export function sessionText(officeDir: string, catalogApps: readonly string[]): string {
  const lines = new Map(catalogApps.map(slug => [slug, `- \`${slug}\` (catalog)`]));

  for (const slug of rootAppNames(officeDir)) lines.set(slug, line(`\`${rootFolder}/${slug}/\``, description(join(officeDir, rootFolder, slug))));

  for (const app of readContributed(officeDir)) lines.set(app.slug, line(`\`${app.slug}\` (package ${app.owner})`, app.description));

  if (lines.size === 0) return "";

  return [
    "# Executor apps",
    "",
    "Use Executor apps through `office-executor` by name (the last folder of an `executor-apps/` path, or the name given). To change an office app, edit its source in `executor-apps/` and run `office apps deploy`; a package's app follows its package's settings.",
    "",
    ...lines.values(),
  ].join("\n");
}
