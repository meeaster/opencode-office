// The catalog: every skill the sources offer, enabled or not, read without fetching anything.
// Packages offer folders with skills.add; a { folder } source offers each child folder holding a
// SKILL.md; a Git source offers the folders it names, at its pinned commit's checkout. Nothing is
// found by scanning a folder the settings don't name.
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, posix, relative, sep } from "node:path";
import type { Entries } from "@office/sdk";
import { checkoutFolder, short } from "./git.ts";
import { skills } from "./handles.ts";
import { isGit, type SkillSettings, skillId } from "./settings.ts";

/** Where enabled skills are linked, from the office root: the folder agent runtimes read. */
export const linkFolder = ".agents/skills";

/**
 * One skill a source offers: its ID, the source for messages, its folder and the folder it must
 * stay inside (both office-relative), and whether that is a Git checkout.
 */
export type Offer = { id: string; source: string; bundle: string; within: string; git: boolean };

const portable = (path: string) => path.split(sep).join("/");

/** The offers of every source, in the settings' order after the packages', and notes on what offers nothing. */
export function catalog(office: string, settings: SkillSettings, entries: Entries) {
  const offers: Offer[] = [];
  const notes: string[] = [];

  for (const { owner, root, value } of entries(skills)) {
    const within = portable(relative(office, root));

    offers.push({ id: posix.basename(value.directory), source: `package ${owner}`, bundle: posix.join(within, value.directory), within, git: false });
  }

  for (const source of settings.sources) {
    if (isGit(source)) {
      const within = checkoutFolder(source.repo, source.ref);

      for (const skill of source.skills) offers.push({ id: skill.name, source: `${source.repo} at ${short(source.ref)}`, bundle: posix.join(within, skill.path), within, git: true });

      continue;
    }

    const dir = join(office, source.folder);

    if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      notes.push(`folder ${source.folder} isn't there, so it offers no skills`);
      continue;
    }

    for (const name of readdirSync(dir).sort()) {
      if (!existsSync(join(dir, name, "SKILL.md"))) continue;

      if (skillId.test(name)) offers.push({ id: name, source: `folder ${source.folder}`, bundle: posix.join(source.folder, name), within: source.folder, git: false });
      else notes.push(`${posix.join(source.folder, name)} isn't offered: a skill ID is lowercase letters and digits, joined by single dashes`);
    }
  }

  return { offers, notes };
}

/** The link text for an offer, from `.agents/skills/`: relative, so it resolves on the host and in the container. */
export function linkTarget(offer: Pick<Offer, "bundle">): string {
  return posix.relative(linkFolder, offer.bundle);
}

function realPath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** Whether `path` is strictly inside `folder`, both real paths. */
function inside(folder: string, path: string): boolean {
  const rest = relative(folder, path);

  return rest !== "" && rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest);
}

/**
 * What is wrong with an offer's folder on disk, followed to where it really is: a Git checkout
 * that isn't there, a folder that isn't inside its source, or a SKILL.md that isn't a regular file
 * inside that folder.
 */
export function bundleProblem(office: string, offer: Offer): string | undefined {
  const label = `skill ${offer.id} from ${offer.source}`;
  const shown = offer.git ? posix.relative(offer.within, offer.bundle) : offer.bundle;
  const within = realPath(join(office, offer.within));

  if (offer.git && within === undefined) return `${label}: its checkout ${offer.within} isn't there; office sync fetches it`;
  const bundle = realPath(join(office, offer.bundle));
  const marker = realPath(join(office, offer.bundle, "SKILL.md"));

  if (bundle === undefined || marker === undefined || !statSync(marker).isFile()) return `${label}: ${shown} has no SKILL.md file${offer.git ? " at that commit" : ""}`;

  if (within === undefined || !inside(within, bundle) || !inside(bundle, marker)) return `${label}: ${shown} leads outside its source`;
}

/**
 * The enabled offers by ID, and every problem that stops delivery: an ID two sources offer, and an
 * enabled ID no source offers.
 */
export function selection(settings: SkillSettings, offers: readonly Offer[]) {
  const byId = Map.groupBy(offers, offer => offer.id);
  const problems: string[] = [];

  for (const [id, same] of byId) {
    if (same.length > 1) problems.push(`skill ${id} is offered by more than one source: ${same.map(offer => offer.source).join(" and ")}`);
  }

  const enabled = new Map<string, Offer>();

  for (const id of settings.enabled) {
    const offer = byId.get(id)?.[0];

    if (offer === undefined) problems.push(`skill ${id} is enabled, but no source offers it`);
    else enabled.set(id, offer);
  }

  return { enabled, problems };
}
