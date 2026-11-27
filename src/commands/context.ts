// `office context`: how many tokens the office adds to the first request of a session started in a
// folder, measured with real requests on the office's running OpenCode server. Each model gets a
// baseline probe in an empty folder outside the office and a probe in the folder; the difference is
// what the office adds.
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as v from "valibot";

import { type Office, OfficeError } from "../office.ts";
import { requestOpenCode } from "../opencode-request.ts";
import { check, modelReference, type Parsed } from "../schema.ts";

/** Every probe session's title. A run first deletes sessions with exactly this title, left by a crashed run. */
export const probeTitle = "office context probe";

const prompt = "Reply with exactly: OK";

// A model answers a one-line prompt in seconds, but a cold provider can take much longer.
const answerTimeoutMs = 300_000;

export type Model = { providerID: string; id: string; variant?: string };

/** `provider/model#variant`, as OpenCode writes a model, split into what its API takes. */
export function parseModel(text: string): Model {
  if (!v.is(modelReference, text)) throw new OfficeError(`${text} is not a model such as openai/gpt-6-luna#low: provider/model, with an optional #variant`);

  const slash = text.indexOf("/");
  const hash = text.indexOf("#");
  const id = text.slice(slash + 1, hash === -1 ? undefined : hash);

  return hash === -1 ? { providerID: text.slice(0, slash), id } : { providerID: text.slice(0, slash), id, variant: text.slice(hash + 1) };
}

const created = v.object({ data: v.object({ id: v.string() }) });

const sessionList = v.object({
  data: v.array(v.object({ id: v.string(), title: v.optional(v.string()) })),
  cursor: v.nullish(v.object({ next: v.nullish(v.string()) })),
});

const tokens = v.object({ input: v.number(), output: v.number(), reasoning: v.optional(v.number()), cache: v.object({ read: v.number(), write: v.number() }) });

const messages = v.object({
  data: v.array(v.looseObject({
    type: v.string(),
    finish: v.optional(v.string()),
    tokens: v.optional(tokens),
    error: v.optional(v.looseObject({ message: v.optional(v.string()), status: v.optional(v.number()) })),
    time: v.optional(v.looseObject({ created: v.optional(v.number()) })),
  })),
});

const entries = v.object({ data: v.array(v.object({ key: v.string(), value: v.string() })) });

type Entry = { key: string; value: string };

/** One probe's outcome: the first request's tokens (input and cache), or why it failed. */
type Probe = { ok: true; total: number; entries?: Entry[] } | { ok: false; error: string };

/** A JSON answer checked against `schema`; an answer that isn't JSON fails the check. */
async function parse<Schema extends v.GenericSchema>(schema: Schema, response: Response): Promise<Parsed<v.InferOutput<Schema>>> {
  return check(v.safeParse(schema, await response.json().catch(() => null)));
}

/** What a failed answer says, briefly, for a one-line report. */
async function failure(what: string, response: Response): Promise<string> {
  const text = (await response.text().catch(() => "")).replace(/\s+/g, " ").trim();

  return `${what} answered HTTP ${response.status}${text === "" ? "" : `: ${text.slice(0, 200)}`}`;
}

/** Deletes sessions titled exactly `probeTitle`, which a crashed earlier run left. Returns how many. */
export async function removeStrayProbes(office: Office): Promise<number> {
  const strays: string[] = [];
  let cursor: string | undefined;

  // The server's search is fuzzy; only an exact title match is a probe. A cursor carries the search.
  for (let page = 0; page < 50; page++) {
    const query = cursor === undefined ? `search=${encodeURIComponent(probeTitle)}&limit=100` : `cursor=${encodeURIComponent(cursor)}&limit=100`;
    const { response, server } = await requestOpenCode(office, "GET", `/api/session?${query}`);

    if (!response.ok) throw new OfficeError(`${await failure(`OpenCode at ${server}`, response)} when listing sessions`);

    const result = await parse(sessionList, response);

    if (!result.ok) throw new OfficeError(`OpenCode at ${server} did not return a session list`);

    strays.push(...result.value.data.filter((session) => session.title === probeTitle).map((session) => session.id));
    cursor = result.value.cursor?.next ?? undefined;

    if (result.value.data.length === 0 || cursor === undefined) break;
  }

  for (const id of new Set(strays)) await deleteSession(office, id);

  return new Set(strays).size;
}

async function deleteSession(office: Office, id: string): Promise<void> {
  const { response, server } = await requestOpenCode(office, "DELETE", `/api/session/${encodeURIComponent(id)}`);

  if (!response.ok && response.status !== 404) throw new OfficeError(`${await failure(`OpenCode at ${server}`, response)} when deleting probe session ${id}`);
}

/** The first assistant message, once the server has recorded how its request ended. */
async function firstAnswer(office: Office, id: string) {
  for (let attempt = 0; ; attempt++) {
    const { response, server } = await requestOpenCode(office, "GET", `/api/session/${encodeURIComponent(id)}/message`);

    if (!response.ok) return { error: await failure("reading the session's messages", response) };

    const result = await parse(messages, response);

    if (!result.ok) return { error: `OpenCode at ${server} did not return session messages` };

    const answers = result.value.data.filter((message) => message.type === "assistant");
    const first = answers.reduce<(typeof answers)[number] | undefined>((earliest, message) => earliest === undefined || (message.time?.created ?? 0) < (earliest.time?.created ?? 0) ? message : earliest, undefined);

    if (first !== undefined && (first.finish !== undefined || first.error !== undefined || first.tokens !== undefined)) return { message: first };

    if (attempt >= 10) return { error: first === undefined ? "the session has no answer" : "the answer never finished" };

    await Bun.sleep(500);
  }
}

/** One session in `directory` with `model`: one prompt, its first request's tokens, then the session deleted. */
async function probe(office: Office, directory: string, model: Model, withEntries: boolean): Promise<Probe> {
  const { response, server } = await requestOpenCode(office, "POST", "/api/session", { body: { title: probeTitle, location: { directory }, model } });

  if (!response.ok) return { ok: false, error: await failure("creating the session", response) };

  const session = await parse(created, response);

  if (!session.ok) return { ok: false, error: `OpenCode at ${server} did not return the created session` };

  const id = session.value.data.id;
  const path = `/api/session/${encodeURIComponent(id)}`;

  try {
    const prompted = await requestOpenCode(office, "POST", `${path}/prompt`, { body: { text: prompt }, timeoutMs: answerTimeoutMs });

    if (!prompted.response.ok) return { ok: false, error: await failure("the prompt", prompted.response) };

    const waited = await requestOpenCode(office, "POST", `/api/experimental/session/${encodeURIComponent(id)}/wait`, { timeoutMs: answerTimeoutMs });

    if (!waited.response.ok) return { ok: false, error: await failure("waiting for the answer", waited.response) };

    const answer = await firstAnswer(office, id);

    if (answer.message === undefined) return { ok: false, error: answer.error };

    const { message } = answer;

    if (message.finish === "error" || message.error !== undefined) {
      const status = message.error?.status === undefined ? "" : ` (HTTP ${message.error.status})`;

      return { ok: false, error: `${message.error?.message ?? "the request failed"}${status}` };
    }

    if (message.tokens === undefined) return { ok: false, error: "the answer has no token counts" };

    const total = message.tokens.input + message.tokens.cache.read + message.tokens.cache.write;

    if (!withEntries) return { ok: true, total };

    const listed = await requestOpenCode(office, "GET", `/api/experimental/session/${encodeURIComponent(id)}/instructions/entries`);

    if (!listed.response.ok) return { ok: true, total };

    const result = await parse(entries, listed.response);

    return result.ok ? { ok: true, total, entries: result.value.data } : { ok: true, total };
  } finally {
    await deleteSession(office, id);
  }
}

function count(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * Probes each model in an empty folder and in `folder`, and reports what the office adds. `failed`
 * is true when any model's request failed; the others are still measured.
 */
export async function contextReport(office: Office, folder: string, models: string[]): Promise<{ text: string; failed: boolean }> {
  if (office.opencode.mode === "container") {
    throw new OfficeError("office context works only with a host-mode OpenCode server for now: its baseline needs an empty folder where the server runs, which it doesn't create inside the container");
  }

  if (models.length === 0) {
    throw new OfficeError("pass --model <provider/model#variant> to select a model to measure");
  }

  const parsed = models.map((text) => ({ text, model: parseModel(text) }));

  if (!statSync(folder, { throwIfNoEntry: false })?.isDirectory()) throw new OfficeError(`${folder} is not a folder`);

  const lines: string[] = [];
  const removed = await removeStrayProbes(office);

  if (removed > 0) lines.push(`Removed ${removed} probe session${removed === 1 ? "" : "s"} left by an earlier run.`, "");

  const baseline = mkdtempSync(join(tmpdir(), "office-context-"));
  const width = Math.max(...models.map((text) => text.length));
  const rows: string[] = [];
  let failed = false;
  let listed: Entry[] | undefined;

  try {
    for (const { text, model } of parsed) {
      const empty = await probe(office, baseline, model, false);
      const here = empty.ok ? await probe(office, folder, model, listed === undefined) : empty;

      if (!empty.ok || !here.ok) {
        failed = true;
        rows.push(`${text.padEnd(width)}  failed: ${!empty.ok ? empty.error : !here.ok ? here.error : ""}`);
        continue;
      }

      listed ??= here.entries;
      rows.push(`${text.padEnd(width)}  baseline ${count(empty.total).padStart(7)}  folder ${count(here.total).padStart(7)}  office adds ${`${here.total >= empty.total ? "+" : ""}${count(here.total - empty.total)}`.padStart(7)}`);
    }
  } finally {
    rmSync(baseline, { recursive: true, force: true });
  }

  lines.push(`Tokens in the first request of a session in ${folder}, against an empty folder:`, ...rows.map((row) => `  ${row}`));

  if (listed !== undefined) {
    const keyWidth = Math.max(0, ...listed.map((entry) => entry.key.length));

    lines.push("", listed.length === 0 ? "No plugin instruction entries in the folder's session." : "Plugin instruction entries in the folder's session (characters):");

    for (const entry of listed) lines.push(`  ${entry.key.padEnd(keyWidth)}  ${count(entry.value.length).padStart(7)}`);
  }

  return { text: lines.join("\n"), failed };
}
