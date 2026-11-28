import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Entries, type ExclusionUpdate, type OfficeInfo, Package, type Problem } from "@office/sdk";
import { copyExcludePath } from "@office/sdk/copy-tree";
import { bundleProblem, catalog, linkFolder, linkTarget, type Pending, selection } from "./catalog.ts";
import { type Declared, declaredSources, nextGeneration, type Published, readPublished, type Runner } from "./generated.ts";
import { checkoutFolder, checkoutProblem, comparison, ensureCheckout, resolveTrack, short } from "./git.ts";
import { skills } from "./handles.ts";
import { generatedSources } from "./sources.ts";
import { applyDelivery, type Delivery, deliveryProblems, lostLinks, ownedPaths, planDelivery, readReceipt } from "./links.ts";
import { discard, exclusively, generate, publish } from "./publication.ts";
import { isGit, readSettings, type SkillSettings, settingsSchema } from "./settings.ts";

/** Fetches each Git source's pinned commit that isn't here yet; one that is here is used offline. */
function fetchSources(office: string, settings: SkillSettings): string[] {
  return settings.sources.flatMap(source => {
    if (!isGit(source)) return [];

    return ensureCheckout(office, source.repo, source.ref).fetched ? [`fetched ${source.repo} at ${short(source.ref)}`] : [];
  });
}

/**
 * Checks even disabled Git offers so a pin stands only at a commit holding every named skill.
 * Up can plan against staged output before publishing it.
 */
function wantedSkills(office: string, settings: SkillSettings, entries: Entries, runner: Runner, candidates?: ReadonlyMap<string, Published>) {
  const final = candidates !== undefined;
  const { offers, notes, pending, problems: declared } = catalog(office, settings, entries, runner, candidates);
  const { enabled, problems, deferred } = selection(settings, offers, !final && pending.length > 0);

  problems.unshift(...declared);

  if (final && problems.length) problems.push(...pending.map(pendingLine));
  const chosen = new Set(enabled.values());
  const wanted = new Map<string, Delivery>();

  for (const offer of offers) {
    if (!offer.git && !chosen.has(offer)) continue;
    const problem = bundleProblem(office, offer);

    if (problem !== undefined) problems.push(problem);
    else if (chosen.has(offer)) {
      const delivery = offer.copy
        ? { kind: "copy", source: join(office, offer.bundle), label: offer.source } as const
        : { kind: "link", target: linkTarget(offer), label: offer.source } as const;

      wanted.set(`${linkFolder}/${offer.id}`, delivery);
    }
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

function prepare(office: string, settings: SkillSettings, entries: Entries, runner: Runner, candidates?: ReadonlyMap<string, Published>) {
  const { wanted, notes, problems, pending, deferred } = wantedSkills(office, settings, entries, runner, candidates);
  const receipt = readReceipt(office);
  const deferredPaths = new Set(deferred.map(id => `${linkFolder}/${id}`));
  const plan = planDelivery(office, wanted, receipt, deferredPaths);

  problems.push(...plan.problems);

  if (problems.length) throw new Error(`no skill delivery changed: ${problems.join("; ")}`);
  const ids = deferredLine(pending, deferred);
  const copying = new Map(plan.changes.flatMap(change => change.kind === "copy" ? [[change.path, copyExcludePath(office, change.path)] as const] : []));

  const owned = [...wanted.keys(), ...[...deferredPaths].filter(path => receipt.copies.has(path))].sort();

  return { notes: [...notes, ...pending.map(pendingLine), ...(ids === undefined ? [] : [ids])], receipt, changes: plan.changes, owned, copying };
}

/**
 * `up`: stages output for each source whose key changed, checks the whole selection (no deferral),
 * excludes new deliveries, installs the output and copies the skills under the generated-skills
 * lock. A generator failure or a failed check leaves the published output and deliveries as they
 * were. With no generated source declared it does nothing: sync and `skills update` deliver the rest.
 */
async function deliver(office: string, settings: SkillSettings, entries: Entries, runner: Runner, runtimes: () => readonly string[], updateExcluded: UpdateExcluded): Promise<string[]> {
  const { sources, problems } = declaredSources(entries);

  if (sources.length === 0 && problems.length === 0) return [];

  for (const source of settings.sources) {
    const problem = isGit(source) ? checkoutProblem(office, source.repo, source.ref) : undefined;

    if (problem !== undefined) problems.push(problem);
  }

  if (problems.length) throw new Error(`no skill delivery changed: ${problems.join("; ")}`);

  return exclusively(office, () => publishSources(office, settings, entries, runner, runtimes, updateExcluded, sources));
}

async function publishSources(office: string, settings: SkillSettings, entries: Entries, runner: Runner, runtimes: () => readonly string[], updateExcluded: UpdateExcluded, sources: readonly Declared[]): Promise<string[]> {
  const lines: string[] = [];
  const candidates = new Map<string, Published>();
  let prepared: ReturnType<typeof prepare>;
  let adding: string[] = [];
  let excluded = new Set<string>();

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

    const recorded = new Set(ownedPaths(receipt));

    adding = owned.filter(path => !recorded.has(path));
    excluded = new Set(adding.map(path => prepared.copying.get(path) ?? path));
    lines.push(...updateExcluded({ add: [...excluded] }));
  } catch (error) {
    for (const { folder } of candidates.values()) discard(office, folder);

    throw new Error(`${error instanceof Error ? error.message : String(error)}; published generated skills and their deliveries stay as they were`, { cause: error });
  }

  const { notes, receipt, owned } = prepared;

  try {
    for (const [id, { folder }] of candidates) publish(office, id, folder);
    // The preflight plans read from staging. Replan from the newly installed output.
    const delivery = candidates.size ? prepare(office, settings, entries, runner, new Map()) : prepared;

    lines.push(...applyDelivery(office, delivery.changes, delivery.receipt, path => excluded.has(path) ? [] : updateExcluded({ add: [path] })));
  } catch (error) {
    const held = new Set(ownedPaths(readReceipt(office)));

    updateExcluded({ remove: adding.filter(path => !held.has(path)) });
    throw error;
  } finally {
    for (const { folder } of candidates.values()) discard(office, folder);
  }

  const gone = ownedPaths(receipt).filter(path => !owned.includes(path));

  lines.push(...updateExcluded({ remove: gone }));

  return [...lines, ...notes];
}

/**
 * What check says about published generated sources: a tool that is missing, below the minimum or
 * changed since activation, or a key that changed, is a warning, since the published skills stay
 * delivered until office up.
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
 * `office skills update`: checks each Git pin's candidate and deliveries before moving the pin.
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

    const excluded = new Set(prepared.owned.map(path => prepared.copying.get(path) ?? path));

    for (const line of updateExcluded({ add: [...excluded] })) console.log(line);
    settings = replaceSetting(["sources", index, "ref"], found.commit);
    const compare = comparison(source.repo, source.ref, found.commit);

    console.log(`${source.repo}: pinned ${short(source.ref)} → ${found.commit} (${found.via}); skills ${names}${compare === undefined ? "" : `; changes: ${compare}`}`);

    for (const line of applyDelivery(office, prepared.changes, prepared.receipt, path => excluded.has(path) ? [] : updateExcluded({ add: [path] }))) console.log(line);
    const gone = ownedPaths(prepared.receipt).filter(path => !prepared.owned.includes(path));

    if (gone.length) for (const line of updateExcluded({ remove: gone })) console.log(line);
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
      summary: "Move each tracked Git skill source to where it points now and copy its enabled skills",
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
      const lines = applyDelivery(office.dir, changes, receipt, path => updateExcluded({ add: [path] }));

      exclude(owned);

      return [...released, ...fetched, ...notes, ...lines];
    });
  },
  check({ office, settings, entries }) {
    const read = readSettings(settings);
    const problems: Problem[] = [];
    const { wanted, problems: selected, pending, deferred } = wantedSkills(office.dir, read, entries, runnerOf(office));
    const ids = deferredLine(pending, deferred);
    const plan = planDelivery(office.dir, wanted, readReceipt(office.dir), new Set(deferred.map(id => `${linkFolder}/${id}`)));

    for (const source of read.sources) {
      const message = isGit(source) ? checkoutProblem(office.dir, source.repo, source.ref) : undefined;

      if (message !== undefined) problems.push({ level: "failed", message });
    }

    for (const message of [...selected, ...plan.problems]) problems.push({ level: "failed", message });

    for (const line of pending.map(pendingLine)) problems.push({ level: ids === undefined ? "warning" : "failed", message: line });

    problems.push(...publishedProblems(office.dir, entries, runnerOf(office)));

    if (ids !== undefined) problems.push({ level: "failed", message: ids });

    problems.push(...deliveryProblems(plan.changes));

    return problems;
  },
});
