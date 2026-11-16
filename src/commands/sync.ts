// `office sync`: makes the office's folders match office.yaml and the tool. It clones and updates,
// refreshes the tool's plugins, scaffolds desks that are declared but missing, copies declared
// skills into the library and links enabled skills. It never rewrites AGENTS.md, other
// hand-written content or an existing app.
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { cloneOrFetch, cloneShallow, git, refreshClone } from "../git.ts";
import { clones, pluginDrift, skillSelections } from "../layout.ts";
import type { CopiedSkill, Desk, Office } from "../office.ts";
import { toolFiles, toolPath, writeToolFile } from "../tool.ts";

/** "release-notes" → "Release notes", for titles in scaffolded files. */
function title(name: string): string {
  const words = name.replaceAll("-", " ");

  return words.charAt(0).toUpperCase() + words.slice(1);
}

function fill(text: string, values: Record<string, string>): string {
  let result = text;

  for (const [key, value] of Object.entries(values)) result = result.replaceAll(`__${key}__`, value);

  return result;
}

/**
 * Copies a tool template folder (such as "template/desk"), filling placeholders in file names and
 * contents. Existing files are kept, and so are template paths (after filling) that `include`
 * rejects.
 */
export function copyTemplate(from: string, to: string, values: Record<string, string>, include: (path: string) => boolean = () => true): string[] {
  const written: string[] = [];

  for (const file of toolFiles(from)) {
    const path = fill(file, values);
    const target = join(to, path);

    if (existsSync(target) || !include(path)) continue;

    writeToolFile(target, fill(readFileSync(toolPath(`${from}/${file}`), "utf8"), values));
    written.push(target);
  }

  return written;
}

/**
 * Scaffolds a desk whose folder is missing, or only the starter Executor app of a desk that has
 * none. A desk that has both is left alone; `office check` reports anything else missing.
 */
function scaffoldDesk(office: Office, desk: Desk): string[] {
  const dir = join(office.dir, desk.name);
  const appPath = join("executor/apps", desk.name);
  const deskExists = existsSync(dir);
  const appExists = existsSync(join(dir, appPath));

  for (const folder of ["repos", "scratch"]) mkdirSync(join(dir, folder), { recursive: true });

  if (deskExists && appExists) return [];

  const written = copyTemplate(
    "template/desk",
    dir,
    { DESK: desk.name, DESK_TITLE: title(desk.name) },
    (path) => !deskExists || path.startsWith(`${appPath}/`),
  );

  // Desk apps carry a copy of the office's OpenCode client, so they declare the same provider
  // and one OpenCode account links to all of them.
  if (!appExists) {
    for (const file of ["opencode.ts", "office.ts"]) {
      const copy = join(dir, appPath, file);

      cpSync(join(office.dir, "executor/apps/opencode", file), copy);
      written.push(copy);
    }
  }

  return written;
}

const licenseNames = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"];

/**
 * Copies one skill folder of a git repository at a ref into `to`, with the repository's licence
 * when the folder has none of its own, and records where it came from in `.source.json`, so a
 * later check can compare the copied commit with upstream.
 */
function copyFromRepository({ repo, ref, path }: CopiedSkill, to: string): string {
  const checkout = mkdtempSync(join(tmpdir(), "office-skill-"));

  try {
    cloneShallow(repo, ref, checkout);

    const source = join(checkout, path);

    if (!existsSync(join(source, "SKILL.md"))) throw new Error(`${repo}${ref === undefined ? "" : `@${ref}`} has no ${path}/SKILL.md`);

    cpSync(source, to, { recursive: true });

    const license = licenseNames.find((name) => existsSync(join(checkout, name)));

    if (license !== undefined && !licenseNames.some((name) => existsSync(join(to, name)))) cpSync(join(checkout, license), join(to, license));

    const commit = git(["rev-parse", "HEAD"], checkout);

    writeFileSync(join(to, ".source.json"), `${JSON.stringify({ repo, ref: ref ?? null, path, commit, copied: new Date().toISOString() }, null, 2)}\n`);

    return commit;
  } finally {
    rmSync(checkout, { recursive: true, force: true });
  }
}

/** Makes each .opencode/skills/ hold exactly the enabled library skills as relative links. */
function linkSkills(office: Office): string[] {
  const changes: string[] = [];

  for (const selection of skillSelections(office)) {
    mkdirSync(selection.folder, { recursive: true });

    for (const [entry, target] of selection.links) {
      if (selection.enabled.includes(entry) && target === selection.target(entry)) continue;

      unlinkSync(join(selection.folder, entry));
      changes.push(`unlinked ${relative(office.dir, join(selection.folder, entry))}`);
    }

    for (const skill of selection.enabled) {
      const path = join(selection.folder, skill);

      if (selection.folders.includes(skill)) {
        changes.push(`kept the real folder ${relative(office.dir, path)} instead of linking skills/${skill}`);
      } else if (!existsSync(join(office.dir, "skills", skill))) {
        changes.push(`not linked: skills/${skill} is missing from the library`);
      } else if (selection.links.get(skill) !== selection.target(skill)) {
        symlinkSync(selection.target(skill), path);
        changes.push(`linked ${relative(office.dir, path)}`);
      }
    }
  }

  return changes;
}

/**
 * Makes the office's copies of the tool's plugins match the tool's, saying what it replaced:
 * a differing file was edited by hand or written by an older `office`.
 */
async function refreshPlugins(office: Office): Promise<string[]> {
  return (await pluginDrift(office)).map((file) => {
    const path = join(office.dir, file.path);

    if (file.content === undefined) {
      rmSync(path);

      return `removed ${file.path}: the tool's plugin has no such file`;
    }

    writeToolFile(path, file.content);

    return file.state === "missing" ? `created ${file.path}` : `replaced ${file.path}, which differed from the tool's copy`;
  });
}

/** Runs the sync and returns one line per change. With `referencesOnly`, it only updates references. */
export async function sync(office: Office, { referencesOnly = false } = {}): Promise<string[]> {
  const changes: string[] = [];

  for (const clone of clones(office)) {
    if (referencesOnly && clone.kind !== "reference") continue;

    const where = relative(office.dir, clone.dir);

    try {
      const result =
        clone.kind === "reference" || clone.kind === "plugin"
          ? existsSync(clone.dir)
            ? refreshClone(clone.ref, clone.dir)
            : cloneShallow(clone.url, clone.ref, clone.dir)
          : cloneOrFetch(clone.url, clone.ref, clone.dir);

      if (result !== "current" && result !== "fetched") changes.push(`${result} ${clone.kind} ${where}`);
    } catch (error) {
      changes.push(`FAILED ${clone.kind} ${where}: ${error instanceof Error ? error.message.trim() : String(error)}`);
    }
  }

  if (referencesOnly) return changes;

  changes.push(...(await refreshPlugins(office)));

  for (const desk of office.desks) {
    for (const path of scaffoldDesk(office, desk)) changes.push(`created ${relative(office.dir, path)}`);
  }

  for (const skill of office.skills.copied) {
    const to = join(office.dir, "skills", skill.name);

    if (existsSync(to)) continue;

    try {
      const commit = copyFromRepository(skill, to);

      changes.push(`copied skills/${skill.name} from ${skill.repo} at ${commit}`);
    } catch (error) {
      changes.push(`FAILED to copy skills/${skill.name}: ${error instanceof Error ? error.message.trim() : String(error)}`);
    }
  }

  changes.push(...linkSkills(office));
  changes.push(...excludePluginClones(office));

  return changes;
}

/**
 * Keeps plugin clones out of the office's commits through the repository's local
 * .git/info/exclude, so no committed file needs a section the tool rewrites.
 */
function excludePluginClones(office: Office): string[] {
  const exclude = join(office.dir, ".git/info/exclude");

  if (office.plugins.length === 0 || !existsSync(join(office.dir, ".git"))) return [];

  const current = existsSync(exclude) ? readFileSync(exclude, "utf8") : "";
  const missing = office.plugins.map((plugin) => `/.opencode/plugins/${plugin.name}/`).filter((line) => !current.split("\n").includes(line));

  if (missing.length === 0) return [];

  mkdirSync(join(exclude, ".."), { recursive: true });
  appendFileSync(exclude, `${current === "" || current.endsWith("\n") ? "" : "\n"}${missing.join("\n")}\n`);

  return missing.map((line) => `excluded ${line} from commits (.git/info/exclude)`);
}
