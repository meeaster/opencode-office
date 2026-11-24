// The office package's `ignore_claude_synced_skills` and `ignore_skill_folders` settings: folders outside the office whose skills
// its sessions don't get, such as the one a desktop app syncs account skills into. The plugin
// removes each loaded skill whose file is inside one of them; `ignoredSkills` reads the same
// folders to say which those are. Nothing here lists skill IDs by hand, so a skill that appears in
// a folder later is covered.
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Where the Claude desktop app syncs account skills, which `ignore_claude_synced_skills` covers. */
export const claudeSyncedSkills = "~/.claude/skills/synced";

type FolderSettings = { ignore_claude_synced_skills?: unknown; ignore_skill_folders?: unknown };

/**
 * The folders the two settings name, as `office sync` last applied them; only the Claude app's
 * before it has applied any.
 */
export function ignoredFolders(settings: FolderSettings | undefined): string[] {
  if (settings === undefined) return [claudeSyncedSkills];
  const folders = settings.ignore_skill_folders;
  const more = Array.isArray(folders) ? folders.filter((folder): folder is string => typeof folder === "string" && folder !== "") : [];

  // On unless the office turned it off: the office's own list adds to it, never replaces it.
  return [...new Set([...(settings.ignore_claude_synced_skills === false ? [] : [claudeSyncedSkills]), ...more])];
}

/** A folder as the setting names it: `~` is the session's home, a relative path is from the office root. */
export function expandFolder(folder: string, home: string, office: string): string {
  if (folder === "~") return home;

  if (folder.startsWith("~/")) return join(home, folder.slice(2));

  return isAbsolute(folder) ? resolve(folder) : resolve(office, folder);
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function contains(parent: string, child: string): boolean {
  const path = relative(parent, child);

  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

/**
 * Whether a loaded skill's file is inside one of `folders`. OpenCode reports a skill from a
 * compatibility folder by its resolved path and one from a configured folder as written, so both
 * forms of each side are compared.
 */
export function inFolders(folders: string[], skillPath: string): boolean {
  if (skillPath.includes("://")) return false;

  const paths = [skillPath, join(real(dirname(skillPath)), basename(skillPath))];

  return folders.some((folder) => [folder, real(folder)].some((parent) => paths.some((path) => contains(parent, path))));
}

type Entry = { name: string; path: string; type: "file" | "dir" | "other" };

/** A folder's entries OpenCode would look at, following links; none when it can't be read. */
function entries(dir: string): Entry[] {
  let names: string[];

  try {
    names = readdirSync(dir).toSorted();
  } catch {
    return [];
  }

  return names
    .filter((name) => !name.startsWith(".") && name !== "node_modules")
    .map((name) => {
      const path = join(dir, name);

      try {
        const info = statSync(path);

        return { name, path, type: info.isDirectory() ? "dir" : info.isFile() ? "file" : "other" };
      } catch {
        return { name, path, type: "other" };
      }
    });
}

export type FoundSkill = { id: string; path: string };

/**
 * The skills in a folder as OpenCode finds them: each folder holding a SKILL.md, up to six levels
 * down and named by that folder, and Markdown files at the top. A folder without a SKILL.md is not
 * a skill but is searched, so the skills in `<folder>/<group>/<id>/` are found.
 */
export function skillsIn(folder: string): FoundSkill[] {
  const found: FoundSkill[] = [];
  const queue = [{ dir: folder, depth: 0 }];

  for (const { dir, depth } of queue) {
    const children = entries(dir);

    if (children.some((entry) => entry.type === "file" && entry.name === "SKILL.md")) {
      found.push({ id: basename(dir), path: dir });

      continue;
    }

    if (depth === 0) {
      for (const entry of children) {
        if (entry.type === "file" && entry.name.endsWith(".md")) found.push({ id: entry.name.slice(0, -3), path: entry.path });
      }
    }

    if (depth < 6) queue.push(...children.filter((entry) => entry.type === "dir").map((entry) => ({ dir: entry.path, depth: depth + 1 })));
  }

  return found;
}

export type IgnoredSkills = {
  /** The setting's folders, expanded. */
  folders: string[];
  /** Skills in those folders that sessions don't get. */
  hidden: FoundSkill[];
};

/** What the setting hides for an office, by reading the folders as they are now. */
export function ignoredSkills(office: string, settingFolders: string[], home: string): IgnoredSkills {
  const folders = settingFolders.map((folder) => expandFolder(folder, home, office));

  return { folders, hidden: folders.flatMap(skillsIn) };
}

/** A path under the home as ~/…, others as they are. */
function short(home: string, path: string): string {
  return contains(home, path) ? join("~", relative(home, path)) : path;
}

/** One line per ignored folder, for `office check`. */
export function describeIgnoredSkills(found: IgnoredSkills, home: string): string[] {
  return found.folders.map((folder) => {
    const hidden = found.hidden.filter((skill) => contains(folder, skill.path)).map((skill) => skill.id);

    return `${short(home, folder)}: ${existsSync(folder) ? (hidden.length > 0 ? `hides ${hidden.join(", ")}` : "holds no skills to hide") : "doesn't exist, so nothing is hidden"}`;
  });
}
