// What an office's folders should hold, derived from office.yaml and the tool: the clones, the
// skill links and the tool's plugins. `office sync` makes the folders match; `office check` compares.
import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";

import { type Office, skillsFolder, toolPlugins } from "./office.ts";
import { toolFiles, toolPath } from "./tool.ts";

export type Clone = { name: string; url: string; ref: string | undefined; kind: string; dir: string };

/** Every clone office.yaml declares, with the folder it belongs in. */
export function clones(office: Office): Clone[] {
  return [
    ...office.references.map((reference) => ({ ...reference, kind: "reference", dir: join(office.dir, "references", reference.name) })),
    ...office.desks.flatMap((desk) =>
      desk.repos.map((repo) => ({ ...repo, kind: `${desk.name} repo`, dir: join(office.dir, desk.name, "repos", repo.name) })),
    ),
    ...office.plugins.map((plugin) => ({ ...plugin, kind: "plugin", dir: join(office.dir, ".opencode/plugins", plugin.name) })),
  ];
}

/** Skill IDs in the office's library, `skills/<id>/`. */
export function library(office: Office): string[] {
  const dir = join(office.dir, "skills");

  if (!existsSync(dir)) return [];

  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export type SkillSelection = {
  desk: string | undefined;
  folder: string;
  enabled: string[];
  links: Map<string, string>;
  folders: string[];
  target: (skill: string) => string;
};

/**
 * The skill selection of the root (`desk` undefined) and of each desk: which library skills
 * should be linked into that `.opencode/skills/`, and what is there now.
 */
export function skillSelections(office: Office): SkillSelection[] {
  const levels = [{ desk: undefined, enabled: office.skills.enabled }, ...office.desks.map((desk) => ({ desk: desk.name, enabled: desk.skills }))];

  return levels.map(({ desk, enabled }) => {
    const folder = skillsFolder(office, desk);
    const links = new Map<string, string>();
    const folders: string[] = [];

    for (const entry of existsSync(folder) ? readdirSync(folder, { withFileTypes: true }) : []) {
      if (entry.isSymbolicLink()) links.set(entry.name, readlinkSync(join(folder, entry.name)));
      else if (entry.isDirectory()) folders.push(entry.name);
    }

    return {
      desk,
      folder,
      enabled,
      links,
      folders,
      /** The relative link target for a library skill, so it resolves on the host and in the container. */
      target: (skill) => relative(folder, join(office.dir, "skills", skill)),
    };
  });
}

/**
 * One file of a tool plugin's copy in the office, `.opencode/plugins/<plugin>/<file>`: `missing`,
 * `differs` from the tool's, or `extra` (the tool's copy has no such file).
 */
export type PluginDrift = { path: string; state: "missing" | "differs" | "extra"; content: string | undefined };

/** Where the office's copies of the tool's plugins differ from the tool's own. */
export function pluginDrift(office: Office): PluginDrift[] {
  return toolPlugins.flatMap((plugin) => {
    const folder = join(office.dir, ".opencode/plugins", plugin);
    const wanted = toolFiles(`plugins/${plugin}`);
    const present = existsSync(folder) ? readdirSync(folder, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => relative(folder, join(entry.parentPath, entry.name))) : [];
    const drift: PluginDrift[] = [];

    for (const file of wanted) {
      const content = readFileSync(toolPath(`plugins/${plugin}/${file}`), "utf8");
      const path = relative(office.dir, join(folder, file));

      if (!present.includes(file)) drift.push({ path, state: "missing", content });
      else if (readFileSync(join(folder, file), "utf8") !== content) drift.push({ path, state: "differs", content });
    }

    for (const file of present) {
      if (!wanted.includes(file)) drift.push({ path: relative(office.dir, join(folder, file)), state: "extra", content: undefined });
    }

    return drift;
  });
}
