// The office package's `ignore_claude_synced_skills` and `ignore_skill_folders` settings: folders outside the office whose skills
// its sessions don't get, such as the one a desktop app syncs account skills into. The plugin
// removes each loaded skill whose file is inside one of them; `ignoredSkills` reads the same
// folders to say which those are. Nothing here lists skill IDs by hand, so a skill that appears in
// a folder later is covered.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Where the Claude desktop app syncs account skills, which `ignore_claude_synced_skills` covers. */
export const claudeSyncedSkills = "~/.claude/skills/synced";

/** The folders the two settings name, as `office sync` wrote them to the package's `.settings.json`; none when it is unreadable. */
export function readIgnoredFolders(packageDir: string): string[] {
  try {
    const read: { ignore_claude_synced_skills?: unknown; ignore_skill_folders?: unknown } = JSON.parse(readFileSync(join(packageDir, ".settings.json"), "utf8"));
    const folders = read.ignore_skill_folders;
    const more = Array.isArray(folders) ? folders.filter((folder): folder is string => typeof folder === "string" && folder !== "") : [];

    // On unless the office turned it off: the office's own list adds to it, never replaces it.
    return [...new Set([...(read.ignore_claude_synced_skills === false ? [] : [claudeSyncedSkills]), ...more])];
  } catch {
    return [claudeSyncedSkills];
  }
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

/**
 * Skill IDs the office's packages give sessions through their plugins, each with the package that
 * has it. A skill outside the office with one of these IDs replaces the package's in OpenCode,
 * which reads skill folders after plugins register theirs, so removing it would leave neither.
 */
export function packageSkills(office: string): Map<string, string> {
  const provided = new Map<string, string>();

  for (const root of [join(office, ".office/packages"), join(office, "packages")]) {
    for (const item of entries(root)) {
      if (item.type !== "dir") continue;

      for (const skill of entries(join(item.path, "skills"))) {
        if (skill.type === "dir" && existsSync(join(skill.path, "SKILL.md")) && !provided.has(skill.name)) provided.set(skill.name, item.name);
      }
    }
  }

  return provided;
}

export type IgnoredSkills = {
  /** The setting's folders, expanded. */
  folders: string[];
  /** Skills in those folders that sessions don't get. */
  hidden: FoundSkill[];
  /** Skills in those folders left in place, because a package of the office has the same ID. */
  kept: (FoundSkill & { package: string })[];
};

/** What the setting hides for an office, by reading the folders as they are now. */
export function ignoredSkills(office: string, settingFolders: string[], home: string): IgnoredSkills {
  const folders = settingFolders.map((folder) => expandFolder(folder, home, office));
  const provided = packageSkills(office);
  const result: IgnoredSkills = { folders, hidden: [], kept: [] };

  for (const skill of folders.flatMap(skillsIn)) {
    const owner = provided.get(skill.id);

    if (owner === undefined) result.hidden.push(skill);
    else result.kept.push({ ...skill, package: owner });
  }

  return result;
}

/** A path under the home as ~/…, others as they are. */
function short(home: string, path: string): string {
  return contains(home, path) ? join("~", relative(home, path)) : path;
}

/** One line per ignored folder, then one per skill left in place, for `office check`. */
export function describeIgnoredSkills(found: IgnoredSkills, home: string): { ok: boolean; text: string }[] {
  const lines = found.folders.map((folder) => {
    const here = (skill: FoundSkill) => contains(folder, skill.path);
    const hidden = found.hidden.filter(here).map((skill) => skill.id);

    return {
      ok: true,
      text: `${short(home, folder)}: ${existsSync(folder) ? (hidden.length > 0 ? `hides ${hidden.join(", ")}` : "holds no skills to hide") : "doesn't exist, so nothing is hidden"}`,
    };
  });

  return [
    ...lines,
    ...found.kept.map((skill) => ({
      ok: false,
      text: `skill ${skill.id} at ${short(home, skill.path)} is not hidden: the ${skill.package} package has a skill of that ID, which this one replaces; rename one of them`,
    })),
  ];
}
