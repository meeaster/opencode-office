// The skills package: a catalog of standalone skills and the links that deliver the enabled ones
// into the office root's `.agents/skills/`. Sync fetches each Git source's pinned commit once and
// links; `office skills update` (and `office refresh`) moves tracked pins and relinks at once. A
// generated source offers nothing until office up first publishes it; until then, sync links what
// the other sources offer and defers enabled IDs nobody offers yet. Up generates each source whose
// key changed, checks the whole selection against the new generations, then publishes and links;
// every reader takes a source's published generation from its `current` link.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Entries, type ExclusionUpdate, type OfficeInfo, Package, type Problem } from "@office/sdk";
import { bundleProblem, catalog, linkFolder, linkTarget, type Pending, selection } from "./catalog.ts";
import { type Declared, declaredSources, nextGeneration, publish, type Published, readPublished, type Runner } from "./generation.ts";
import { checkoutFolder, checkoutProblem, comparison, ensureCheckout, resolveTrack, short } from "./git.ts";
import { skills } from "./handles.ts";
import { generatedSources } from "./sources.ts";
import { applyLinks, lostLinks, planLinks, readReceipt } from "./links.ts";
import { cleanup, discard, exclusively, generate } from "./publication.ts";
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
 * or not, so a pin stands only at a commit holding all of them. Sync defers while a generated
 * source waits; up passes the generations it would publish as `candidates` and delivers the whole
 * selection or nothing.
 */
function wantedLinks(office: string, settings: SkillSettings, entries: Entries, runner: Runner, candidates?: ReadonlyMap<string, Published>) {
  const final = candidates !== undefined;
  const { offers, notes, pending, problems: declared } = catalog(office, settings, entries, runner, candidates);
  const { enabled, problems, deferred } = selection(settings, offers, !final && pending.length > 0);

  problems.unshift(...declared);

  if (final && problems.length) problems.push(...pending.map(pendingLine));
  const chosen = new Set(enabled.values());
  const wanted = new Map<string, { target: string; label: string }>();

  for (const offer of offers) {
    if (!offer.git && !chosen.has(offer)) continue;
    const problem = bundleProblem(office, offer);

    if (problem !== undefined) problems.push(problem);
    else if (chosen.has(offer)) wanted.set(`${linkFolder}/${offer.id}`, { target: linkTarget(offer), label: offer.source });
  }

  return { wanted, notes, problems, pending, deferred };
}

const pendingLine = ({ label, reason }: Pending) => `${label} hasn't published yet: ${reason}`;

/** The line naming the enabled IDs deferred until a pending source publishes, if any are. */
function deferredLine(pending: readonly Pending[], deferred: readonly string[]): string | undefined {
  return deferred.length ? `enabled skills ${deferred.join(", ")} are deferred: no source offers them until ${pending.map(each => each.label).join(" or ")} publishes` : undefined;
}

type UpdateExcluded = ExclusionUpdate["updateExcluded"];

const runnerOf = (office: OfficeInfo): Runner => ({ container: office.mode === "container" });

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
function prepare(office: string, settings: SkillSettings, entries: Entries, runner: Runner, candidates?: ReadonlyMap<string, Published>) {
  const { wanted, notes, problems, pending, deferred } = wantedLinks(office, settings, entries, runner, candidates);
  const receipt = readReceipt(office);
  const plan = planLinks(office, wanted, receipt);

  problems.push(...plan.problems);

  if (problems.length) throw new Error(`no skill link changed: ${problems.join("; ")}`);
  const ids = deferredLine(pending, deferred);

  return { notes: [...notes, ...pending.map(pendingLine), ...(ids === undefined ? [] : [ids])], receipt, changes: plan.changes, owned: [...wanted.keys()].sort() };
}

/**
 * `up`: generates each generated source whose key changed into a new generation, checks the whole
 * selection with those generations as every source's offers (no deferral), then excludes the new
 * links, publishes the generations by switching their `current` links, links, and removes earlier
 * generations, holding the office's generated-skills lock. A generator failure or any problem,
 * a failed exclusion included, leaves the published generations, links and exclusions as they
 * were. With no generated source declared it does nothing: sync and `skills update` deliver the rest.
 */
async function deliver(office: string, settings: SkillSettings, entries: Entries, runner: Runner, runtimes: () => readonly string[], updateExcluded: UpdateExcluded): Promise<string[]> {
  const { sources, problems } = declaredSources(entries);

  if (sources.length === 0 && problems.length === 0) return [];

  for (const source of settings.sources) {
    const problem = isGit(source) ? checkoutProblem(office, source.repo, source.ref) : undefined;

    if (problem !== undefined) problems.push(problem);
  }

  if (problems.length) throw new Error(`no skill link changed: ${problems.join("; ")}`);

  return exclusively(office, () => publishSources(office, settings, entries, runner, runtimes, updateExcluded, sources));
}

async function publishSources(office: string, settings: SkillSettings, entries: Entries, runner: Runner, runtimes: () => readonly string[], updateExcluded: UpdateExcluded, sources: readonly Declared[]): Promise<string[]> {
  const lines: string[] = [];
  const candidates = new Map<string, Published>();
  let prepared: ReturnType<typeof prepare>;
  let adding: string[] = [];

  try {
    for (const declared of sources) {
      const { source, label } = declared;
      const published = readPublished(office, source.id);
      const next = nextGeneration(office, source, runner);

      if ("waiting" in next) {
        // A source that never published is named once, by the selection's notes or problems.
        if (published !== undefined) lines.push(`${label} keeps its published skills: ${next.waiting}`);
        continue;
      }

      if (published?.key === next.ready.key) continue;
      const candidate = await generate(office, declared, next.ready, runtimes);

      candidates.set(source.id, candidate);
      lines.push(`${label}: generated ${candidate.skills.length ? candidate.skills.join(", ") : "no skills"} with ${source.tool.name} ${next.ready.version}`);
    }

    prepared = prepare(office, settings, entries, runner, candidates);
    const { owned, receipt } = prepared;

    adding = owned.filter(path => !receipt.has(path));
    lines.push(...updateExcluded({ add: adding }));
  } catch (error) {
    for (const [id, { generation }] of candidates) discard(office, id, generation);

    throw new Error(`${error instanceof Error ? error.message : String(error)}; published generated skills and their links stay as they were`, { cause: error });
  }

  const { notes, receipt, changes, owned } = prepared;

  try {
    for (const [id, { generation }] of candidates) publish(office, id, generation);
    lines.push(...applyLinks(office, changes, receipt));
  } catch (error) {
    const held = readReceipt(office);

    updateExcluded({ remove: adding.filter(path => !held.has(path)) });
    throw error;
  }

  const gone = [...receipt.keys()].filter(path => !owned.includes(path));

  lines.push(...updateExcluded({ remove: gone }));

  for (const { source } of sources) {
    const published = readPublished(office, source.id);

    if (published !== undefined) lines.push(...cleanup(office, source.id, published.generation));
  }

  return [...lines, ...notes];
}

/**
 * What check says about published generated sources: a tool that is missing, below the minimum or
 * changed since activation, or a key that changed, is a warning, since the published skills stay
 * linked until office up.
 */
function publishedProblems(office: string, entries: Entries, runner: Runner): Problem[] {
  return declaredSources(entries).sources.flatMap(({ source, label }): Problem[] => {
    const published = readPublished(office, source.id);

    if (published === undefined) return [];
    const next = nextGeneration(office, source, runner);

    if ("waiting" in next) return [{ level: "warning", message: `${label} keeps its published skills: ${next.waiting}` }];

    return next.ready.key === published.key ? [] : [{ level: "warning", message: `${label} was generated for another tool or profile; office up generates it again` }];
  });
}

/** `office skills list`: one row per offer, ID, source and status, sorted; diagnostics go to standard error. */
function list(office: string, settings: SkillSettings, entries: Entries, runner: Runner): string {
  const { offers, notes, pending, problems } = catalog(office, settings, entries, runner);
  const enabled = new Set(settings.enabled);
  const byId = Map.groupBy(offers, offer => offer.id);
  const unoffered = pending.length ? "enabled, deferred until a generated source publishes" : "enabled, offered by no source";

  for (const note of [...problems, ...notes, ...pending.map(pendingLine)]) console.error(note);

  for (const source of settings.sources) {
    if (isGit(source) && !existsSync(join(office, checkoutFolder(source.repo, source.ref)))) console.error(`${source.repo} at ${short(source.ref)} isn't fetched yet; office sync fetches it`);
  }

  const rows = offers.map(offer => [offer.id, offer.source, `${enabled.has(offer.id) ? "enabled" : "available"}${(byId.get(offer.id)?.length ?? 0) > 1 ? ", conflicting" : ""}`]);

  for (const id of enabled) {
    if (!byId.has(id)) rows.push([id, "-", unoffered]);
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
function update(office: string, start: SkillSettings, entries: Entries, runner: Runner, replaceSetting: (path: (string | number)[], value: string) => SkillSettings, updateExcluded: UpdateExcluded) {
  const released = releaseLost(office, updateExcluded);

  for (const line of released) console.log(line);
  reporting(released, () => moveTracks(office, start, entries, runner, replaceSetting, updateExcluded));
}

function moveTracks(office: string, start: SkillSettings, entries: Entries, runner: Runner, replaceSetting: (path: (string | number)[], value: string) => SkillSettings, updateExcluded: UpdateExcluded) {
  let settings = start;
  let notes: readonly string[] = [];
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
      prepared = prepare(office, candidate, entries, runner);
    } catch (error) {
      throw new Error(`${source.repo} at ${short(found.commit)} (${found.via}): ${error instanceof Error ? error.message : String(error)}; ${unchanged}`, { cause: error });
    }

    settings = replaceSetting(["sources", index, "ref"], found.commit);
    const compare = comparison(source.repo, source.ref, found.commit);

    console.log(`${source.repo}: pinned ${short(source.ref)} → ${found.commit} (${found.via}); skills ${names}${compare === undefined ? "" : `; changes: ${compare}`}`);

    for (const line of applyLinks(office, prepared.changes, prepared.receipt)) console.log(line);
    const gone = [...prepared.receipt.keys()].filter(path => !prepared.owned.includes(path));

    for (const line of updateExcluded({ add: prepared.owned, remove: gone })) console.log(line);
    ({ notes } = prepared);
  }

  for (const note of notes) console.log(note);
}

export default Package.define({
  settings: settingsSchema,
  commands: {
    "skills list": {
      summary: "List the standalone skills the office's sources offer: ID, source, and enabled or available",
      result({ office, settings, entries, args }) {
        if (args.length) throw new Error("usage: office skills list");

        return list(office.dir, readSettings(settings), entries, runnerOf(office));
      },
    },
    "skills update": {
      summary: "Move each Git skill source with a track to where it points now, then relink its enabled skills",
      run({ office, settings, entries, args, replaceSetting, updateExcluded }) {
        if (args.length) throw new Error("usage: office skills update");

        update(office.dir, readSettings(settings), entries, runnerOf(office), (path, value) => readSettings(replaceSetting(path, value)), updateExcluded);
      },
    },
  },
  setup(ctx) {
    ctx.registry(skills);
    ctx.registry(generatedSources);
  },
  up({ office, settings, entries, runtimes, updateExcluded }) {
    return deliver(office.dir, readSettings(settings), entries, runnerOf(office), runtimes, updateExcluded);
  },
  sync({ office, settings, entries, exclude, updateExcluded }) {
    const read = readSettings(settings);
    const released = releaseLost(office.dir, updateExcluded);

    return reporting(released, () => {
      const fetched = fetchSources(office.dir, read);
      const { notes, receipt, changes, owned } = prepare(office.dir, read, entries, runnerOf(office));
      const lines = applyLinks(office.dir, changes, receipt);

      exclude(owned);

      return [...released, ...fetched, ...notes, ...lines];
    });
  },
  check({ office, settings, entries }) {
    const read = readSettings(settings);
    const problems: Problem[] = [];
    const { wanted, problems: selected, pending, deferred } = wantedLinks(office.dir, read, entries, runnerOf(office));
    const ids = deferredLine(pending, deferred);
    const plan = planLinks(office.dir, wanted, readReceipt(office.dir));

    for (const source of read.sources) {
      const message = isGit(source) ? checkoutProblem(office.dir, source.repo, source.ref) : undefined;

      if (message !== undefined) problems.push({ level: "failed", message });
    }

    for (const message of [...selected, ...plan.problems]) problems.push({ level: "failed", message });

    for (const line of pending.map(pendingLine)) problems.push({ level: ids === undefined ? "warning" : "failed", message: line });

    problems.push(...publishedProblems(office.dir, entries, runnerOf(office)));

    if (ids !== undefined) problems.push({ level: "failed", message: ids });

    for (const change of plan.changes) {
      if (change.kind === "link") problems.push({ level: "failed", message: `${change.path} isn't linked (office sync links it)` });
      else if (change.kind === "relink") problems.push({ level: "failed", message: `${change.path} links to ${change.from}, not ${change.target} (office sync relinks it)` });
      else if (change.kind === "unlink") problems.push({ level: "failed", message: `${change.path} is no longer enabled (office sync removes it)` });
      else problems.push({ level: "warning", message: `${change.path}: ${change.why}; office sync stops managing it` });
    }

    return problems;
  },
});
