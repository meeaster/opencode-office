// Packages' full-sync work (a definition's `fullSync`): only a full `office sync` runs it, after
// that same sync admitted and applied the package set whole. It runs in a reader bound to the
// generation this sync published, never another: a sync whose admission or application failed,
// or whose set another sync has replaced since, runs none. The reader reports each item as a JSON
// line on its result pipe; sync shows each as a part of its stage and turns a failed one into a
// FAILED line, which makes it exit 1 while every other item, and reference work, still completes.
import { closeSync, existsSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";

import type { ItemResult, SyncItem } from "../sdk/index.ts";
import { failure, type Change } from "./change.ts";
import { resultDescriptor } from "./command-stdout.ts";
import { gatherPackages, problemLines } from "./gather.ts";
import { officeInfo } from "./lifecycle-inputs.ts";
import type { Office } from "./office.ts";
import { managedDirectory, pinActive } from "./package-generation.ts";
import { selectionText, startReader } from "./package-operation.ts";
import type { Stage } from "./report/index.ts";

/** How many items run at once, across packages. */
const slots = 8;

const event = v.variant("type", [
  v.object({ type: v.literal("planned"), count: v.number() }),
  v.object({ type: v.literal("start"), id: v.number(), owner: v.string(), item: v.string() }),
  v.object({ type: v.literal("output"), id: v.number(), line: v.string() }),
  v.object({ type: v.literal("done"), id: v.number(), summary: v.optional(v.string()) }),
  v.object({ type: v.literal("failed"), id: v.number(), reason: v.string() }),
  v.object({ type: v.literal("problem"), text: v.string() }),
]);

type Event = v.InferOutput<typeof event>;

const itemResult = v.variant("ok", [
  v.object({ ok: v.literal(true), summary: v.optional(v.string()) }),
  v.object({ ok: v.literal(false), reason: v.pipe(v.string(), v.nonEmpty()) }),
]);

// The SDK types `run`; a package's code is checked to be a function and its result parsed.
const items = v.array(v.object({ item: v.pipe(v.string(), v.nonEmpty()), run: v.custom<SyncItem["run"]>(value => v.is(v.function(), value)) }));

type Planned = { owner: string; item: string; run: SyncItem["run"] };

/**
 * In a reader bound to `generation`: gathers the packages, asks each `fullSync` for its items and
 * runs them, reporting through `emit`. Refuses, running nothing, when office.yaml's selection is
 * no longer the one the generation was published with or a package doesn't load. `verbose` is
 * the sync's own, for items that can show more progress.
 */
export async function runFullSync(office: Office, generation: string, verbose: boolean, emit: (event: Event) => void) {
  const recorded = join(managedDirectory(office.dir, generation), "selection.json");

  if (!existsSync(recorded) || readFileSync(recorded, "utf8") !== selectionText(office)) {
    emit({ type: "problem", text: "office.yaml's packages changed after this sync applied its package set, so no package's full-sync work ran; run office sync again" });

    return;
  }

  const gathered = await gatherPackages(office, { machine: true });

  if (!gathered.complete) {
    const problems = [...problemLines(gathered.problems), ...[...gathered.unread].map(name => `package ${name} didn't load`)];

    emit({ type: "problem", text: `no package's full-sync work ran: ${problems.join("; ")}` });

    return;
  }

  const planned: Planned[] = [];

  for (const { entry: { name }, manifest, settings } of gathered.packages) {
    if (!manifest.fullSync) continue;

    try {
      const listed = v.safeParse(items, await manifest.fullSync({ office: officeInfo(office), settings: structuredClone(settings), verbose }));

      if (!listed.success) throw new Error("its fullSync must return a list of { item, run }");
      const seen = new Set<string>();

      for (const each of listed.output) {
        if (seen.has(each.item)) throw new Error(`its fullSync lists ${each.item} twice`);
        seen.add(each.item);
        planned.push({ owner: name, item: each.item, run: each.run });
      }
    } catch (error) {
      emit({ type: "problem", text: `package ${name}: ${error instanceof Error ? error.message.trim() : String(error)}` });
    }
  }

  emit({ type: "planned", count: planned.length });
  let next = 0;

  const work = async () => {
    for (let id = next++; id < planned.length; id = next++) {
      const { owner, item, run } = planned[id];

      emit({ type: "start", id, owner, item });

      try {
        const returned: ItemResult | Promise<ItemResult> = run((line) => emit({ type: "output", id, line }));
        const result = v.safeParse(itemResult, await returned);

        if (!result.success) emit({ type: "failed", id, reason: "its run returned something other than { ok: true } or { ok: false, reason }" });
        else if (result.output.ok) emit({ type: "done", id, summary: result.output.summary });
        else emit({ type: "failed", id, reason: result.output.reason });
      } catch (error) {
        emit({ type: "failed", id, reason: (error instanceof Error ? error.message.trim() : String(error)) || "it threw" });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(slots, planned.length) }, work));
}

/** In the reader: writes each event as a JSON line on the result pipe, which sync reads as it runs. */
export function emitEvent(event: Event) {
  writeSync(resultDescriptor, `${JSON.stringify(event)}\n`);
}

/** Reads JSON lines from a pipe as they arrive. */
async function* lines(fd: number) {
  const decoder = new TextDecoder();
  let pending = "";

  try {
    for await (const chunk of Bun.file(fd).stream()) {
      pending += decoder.decode(chunk, { stream: true });
      const parts = pending.split("\n");

      pending = parts.pop() ?? "";
      yield* parts.filter(Boolean);
    }

    if (pending) yield pending;
  } finally {
    closeSync(fd);
  }
}

/** A line the reader wrote, as an event; undefined when it isn't one. */
function readEvent(text: string): Event | undefined {
  try {
    const read = v.safeParse(event, JSON.parse(text));

    return read.success ? read.output : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Sync's step for packages' full-sync work: a reader bound to `generation`, the set this sync
 * published and applied, runs it, each item a part of `stage` after the `earlier` parts. Returns
 * one line per item that reported a summary and a FAILED line per failure: an item that failed, a
 * line from the reader that isn't an event, an item the reader started but never settled, and a
 * reader that didn't exit 0. Runs nothing when another sync has published since. `verbose` asks
 * the items for full progress.
 */
export async function fullSyncStep(office: Office, generation: string, stage: Stage, earlier: number, verbose = false): Promise<Change[]> {
  using active = pinActive(office.dir);

  if (active?.name !== generation) return [failure("FAILED packages' full-sync work: another sync replaced this sync's package set before it ran; run office sync again")];
  const child = startReader(office.dir, active, ["--full-sync", office.dir, generation, ...(verbose ? ["verbose"] : [])]);
  const changes: Change[] = [];
  const parts = new Map<number, { owner: string; item: string; part: ReturnType<Stage["part"]> }>();
  let unreadable = 0;
  let planned = 0;
  let begun = 0;

  const failed = (text: string) => {
    const line = failure(`FAILED ${text}`);

    stage.error(line.failure);
    changes.push(line);
  };

  for await (const text of lines(child.pipe)) {
    const each = readEvent(text);

    if (each === undefined) {
      unreadable++;
      continue;
    }

    if (each.type === "planned") {
      planned = each.count;

      if (each.count) stage.expect(earlier + each.count);
    } else if (each.type === "problem") {
      failed(each.text);
    } else if (each.type === "start") {
      begun++;
      parts.set(each.id, { owner: each.owner, item: each.item, part: stage.part(`${each.owner}: ${each.item}`, "syncing") });
    } else {
      const started = parts.get(each.id);

      if (!started) continue;

      if (each.type === "output") started.part.output(each.line);
      else if (each.type === "done") {
        parts.delete(each.id);
        started.part.done(each.summary);

        if (each.summary) changes.push(`package ${started.owner}: ${started.item}: ${each.summary}`);
      } else {
        parts.delete(each.id);
        started.part.fail(each.reason);
        changes.push(failure(`FAILED package ${started.owner}: ${started.item}: ${each.reason}`));
      }
    }
  }

  const status = await child.exited;

  if (unreadable) failed(`packages' full-sync work: the package reader sent ${unreadable === 1 ? "a line" : `${unreadable} lines`} sync can't read; run office sync again`);

  // Each item the reader started and never settled, however it ended.
  for (const { owner, item, part } of parts.values()) {
    const reason = "it stopped before it finished; run office sync again";

    part.fail(reason);
    changes.push(failure(`FAILED package ${owner}: ${item}: ${reason}`));
  }

  if (begun < planned) failed(`packages' full-sync work: ${planned - begun} of ${planned} items never started; run office sync again`);

  if (status !== 0) failed(`packages' full-sync work stopped (exit ${status}); run office sync again`);

  return changes;
}
