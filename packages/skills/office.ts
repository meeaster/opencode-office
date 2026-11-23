// The skills package: a catalog of standalone skills and the links that deliver the enabled ones
// into the office root's `.agents/skills/`. Sync fetches each Git source's pinned commit once and
// links; `office skills update` (and `office refresh`) moves tracked pins and relinks at once.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Entries, type ExclusionUpdate, Package, type Problem } from "@office/sdk";
import { bundleProblem, catalog, linkFolder, linkTarget, selection } from "./catalog.ts";
import { checkoutFolder, checkoutProblem, comparison, ensureCheckout, resolveTrack, short } from "./git.ts";
import { skills } from "./handles.ts";
import { applyLinks, lostLinks, planLinks, readReceipt } from "./links.ts";
import { isGit, readSettings, type SkillSettings, settingsSchema } from "./settings.ts";

/** Fetches each Git source's pinned commit that isn't here yet; one that is here is used offline. */
function fetchSources(office: string, settings: SkillSettings): string[] {
  return settings.sources.flatMap(source => {
    if (!isGit(source)) return [];

    return ensureCheckout(office, source.repo, source.ref).fetched ? [`fetched ${source.repo} at ${short(source.ref)}`] : [];
  });
}

/**
 * Every problem with the offers and the enabled skills, and the links the enabled ones want:
 * `.agents/skills/<id>` to each one's folder. Every folder a Git source names is checked, enabled
 * or not, so a pin stands only at a commit holding all of them.
 */
function wantedLinks(office: string, settings: SkillSettings, entries: Entries) {
  const { offers, notes } = catalog(office, settings, entries);
  const { enabled, problems } = selection(settings, offers);
  const chosen = new Set(enabled.values());
  const wanted = new Map<string, { target: string; label: string }>();

  for (const offer of offers) {
    if (!offer.git && !chosen.has(offer)) continue;
    const problem = bundleProblem(office, offer);

    if (problem !== undefined) problems.push(problem);
    else if (chosen.has(offer)) wanted.set(`${linkFolder}/${offer.id}`, { target: linkTarget(offer), label: offer.source });
  }

  return { wanted, notes, problems };
}

type UpdateExcluded = ExclusionUpdate["updateExcluded"];

/**
 * Releases the exclusions of recorded links that are no longer the package's, so Git shows what
 * the owner put there even when a fetch or a plan then fails. Returns what changed.
 */
function releaseLost(office: string, updateExcluded: UpdateExcluded): readonly string[] {
  let receipt;

  try {
    receipt = readReceipt(office);
  } catch {
    // Nothing it records is proven; planning reads it again and stops, naming it.
    return [];
  }

  const lost = lostLinks(office, receipt);

  return lost.length ? updateExcluded({ remove: lost }) : [];
}

/** `act`, with `released` added to the message of an error it throws. */
function reporting<T>(released: readonly string[], act: () => T): T {
  try {
    return act();
  } catch (error) {
    if (!released.length) throw error;

    throw new Error(`${error instanceof Error ? error.message : String(error)}; ${released.join("; ")}`, { cause: error });
  }
}

/** Plans every link change for `settings` before any is made. With any problem it changes no link and throws naming every one. */
function prepare(office: string, settings: SkillSettings, entries: Entries) {
  const { wanted, notes, problems } = wantedLinks(office, settings, entries);
  const receipt = readReceipt(office);
  const plan = planLinks(office, wanted, receipt);

  problems.push(...plan.problems);

  if (problems.length) throw new Error(`no skill link changed: ${problems.join("; ")}`);

  return { notes, receipt, changes: plan.changes, owned: [...wanted.keys()].sort() };
}

/** `office skills list`: one row per offer, ID, source and status, sorted; diagnostics go to standard error. */
function list(office: string, settings: SkillSettings, entries: Entries): string {
  const { offers, notes } = catalog(office, settings, entries);
  const enabled = new Set(settings.enabled);
  const byId = Map.groupBy(offers, offer => offer.id);

  for (const note of notes) console.error(note);

  for (const source of settings.sources) {
    if (isGit(source) && !existsSync(join(office, checkoutFolder(source.repo, source.ref)))) console.error(`${source.repo} at ${short(source.ref)} isn't fetched yet; office sync fetches it`);
  }

  const rows = offers.map(offer => [offer.id, offer.source, `${enabled.has(offer.id) ? "enabled" : "available"}${(byId.get(offer.id)?.length ?? 0) > 1 ? ", conflicting" : ""}`]);

  for (const id of enabled) {
    if (!byId.has(id)) rows.push([id, "-", "enabled, offered by no source"]);
  }

  rows.sort(([a, sa], [b, sb]) => a.localeCompare(b) || sa.localeCompare(sb));
  const widths = [0, 1].map(column => Math.max(0, ...rows.map(row => row[column].length)));

  return rows.map(([id, source, status]) => `${id.padEnd(widths[0])}  ${source.padEnd(widths[1])}  ${status}`).join("\n");
}

/**
 * `office skills update`: moves each tracked Git source's pin and relinks at once. The whole
 * candidate, every named folder and every link change, is checked before the pin moves; the first
 * failure stops it. Exclusions follow the links straight away.
 */
function update(office: string, start: SkillSettings, entries: Entries, replaceSetting: (path: (string | number)[], value: string) => SkillSettings, updateExcluded: UpdateExcluded) {
  const released = releaseLost(office, updateExcluded);

  for (const line of released) console.log(line);
  reporting(released, () => moveTracks(office, start, entries, replaceSetting, updateExcluded));
}

function moveTracks(office: string, start: SkillSettings, entries: Entries, replaceSetting: (path: (string | number)[], value: string) => SkillSettings, updateExcluded: UpdateExcluded) {
  let settings = start;
  const sources = settings.sources.flatMap((source, index) => (isGit(source) ? [{ source, index }] : []));

  if (sources.length === 0) console.log("no Git skill sources to update");

  for (const { source, index } of sources) {
    const names = source.skills.map(skill => skill.name).join(", ");

    if (source.track === undefined) {
      console.log(`${source.repo}: pinned at ${short(source.ref)} with no track, so left there`);
      continue;
    }

    const unchanged = `pin left at ${short(source.ref)} and its skills unchanged`;
    let found;

    try {
      found = resolveTrack(source.repo, source.track);
    } catch (error) {
      throw new Error(`${source.repo}: ${error instanceof Error ? error.message : String(error)}; pin left at ${short(source.ref)}`, { cause: error });
    }

    if (found.commit === source.ref) {
      console.log(`${source.repo}: already at ${short(found.commit)} (${found.via})`);
      continue;
    }

    ensureCheckout(office, source.repo, found.commit);
    const candidate = { ...settings, sources: settings.sources.map((each, at) => (at === index ? { ...source, ref: found.commit } : each)) };
    let prepared;

    try {
      prepared = prepare(office, candidate, entries);
    } catch (error) {
      throw new Error(`${source.repo} at ${short(found.commit)} (${found.via}): ${error instanceof Error ? error.message : String(error)}; ${unchanged}`, { cause: error });
    }

    settings = replaceSetting(["sources", index, "ref"], found.commit);
    const compare = comparison(source.repo, source.ref, found.commit);

    console.log(`${source.repo}: pinned ${short(source.ref)} → ${found.commit} (${found.via}); skills ${names}${compare === undefined ? "" : `; changes: ${compare}`}`);

    for (const line of applyLinks(office, prepared.changes, prepared.receipt)) console.log(line);
    const gone = [...prepared.receipt.keys()].filter(path => !prepared.owned.includes(path));

    for (const line of updateExcluded({ add: prepared.owned, remove: gone })) console.log(line);
  }
}

export default Package.define({
  settings: settingsSchema,
  commands: {
    "skills list": {
      summary: "List the standalone skills the office's sources offer: ID, source, and enabled or available",
      result({ office, settings, entries, args }) {
        if (args.length) throw new Error("usage: office skills list");

        return list(office.dir, readSettings(settings), entries);
      },
    },
    "skills update": {
      summary: "Move each Git skill source with a track to where it points now, then relink its enabled skills",
      run({ office, settings, entries, args, replaceSetting, updateExcluded }) {
        if (args.length) throw new Error("usage: office skills update");

        update(office.dir, readSettings(settings), entries, (path, value) => readSettings(replaceSetting(path, value)), updateExcluded);
      },
    },
  },
  setup(ctx) {
    ctx.registry(skills);
  },
  sync({ office, settings, entries, exclude, updateExcluded }) {
    const read = readSettings(settings);
    const released = releaseLost(office.dir, updateExcluded);

    return reporting(released, () => {
      const fetched = fetchSources(office.dir, read);
      const { notes, receipt, changes, owned } = prepare(office.dir, read, entries);
      const lines = applyLinks(office.dir, changes, receipt);

      exclude(owned);

      return [...released, ...fetched, ...notes, ...lines];
    });
  },
  check({ office, settings, entries }) {
    const read = readSettings(settings);
    const problems: Problem[] = [];
    const { wanted, problems: selected } = wantedLinks(office.dir, read, entries);
    const plan = planLinks(office.dir, wanted, readReceipt(office.dir));

    for (const source of read.sources) {
      const message = isGit(source) ? checkoutProblem(office.dir, source.repo, source.ref) : undefined;

      if (message !== undefined) problems.push({ level: "failed", message });
    }

    for (const message of [...selected, ...plan.problems]) problems.push({ level: "failed", message });

    for (const change of plan.changes) {
      if (change.kind === "link") problems.push({ level: "failed", message: `${change.path} isn't linked (office sync links it)` });
      else if (change.kind === "relink") problems.push({ level: "failed", message: `${change.path} links to ${change.from}, not ${change.target} (office sync relinks it)` });
      else if (change.kind === "unlink") problems.push({ level: "failed", message: `${change.path} is no longer enabled (office sync removes it)` });
      else problems.push({ level: "warning", message: `${change.path}: ${change.why}; office sync stops managing it` });
    }

    return problems;
  },
});
