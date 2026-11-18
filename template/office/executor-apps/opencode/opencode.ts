// The office's OpenCode server, as Executor app code reaches it. Desk apps carry identical copies
// of this file and office.ts: the provider's ID comes from its definition, so one OpenCode account
// links to every app that declares it. Its address follows the office's mode through office.ts.
import {
  array,
  boolean,
  decodeJson,
  defineProvider,
  json,
  object,
  ProviderError,
  record,
  ResponseStatusError,
  secrets,
  string,
  type Infer,
} from "apps";

import { host, origin } from "./office.js";

export { officeDirectory } from "./office.js";

export interface Client {
  readonly fetch: typeof fetch;
  readonly signal?: AbortSignal | undefined;
  readonly password: string;
}

export const Start = object({
  directory: string({ minLength: 1 }),
  prompt: string({ minLength: 1 }),
  agent: string().optional(),
  // Without a model, sessions use OpenCode's default, which may be a free model.
  model: object({ providerID: string(), id: string(), variant: string().optional() }).optional(),
  title: string().optional(),
});

// Opus through the Claude agent provider.
export const defaultModel = { providerID: "claude-agent", id: "opus", variant: "medium" };

export const SessionRef = object({ sessionID: string() });

export const Result = object({
  sessionID: string(),
  running: boolean(),
  outcome: string().optional(),
  error: string().optional(),
  reply: string().optional(),
});

const Info = object({ version: string() });
const Created = object({ data: object({ id: string() }) });
const Active = object({ data: record(json()) });

const Messages = object({
  data: array(
    object({
      type: string(),
      outcome: string().optional(),
      error: object({ message: string() }).optional(),
      content: array(object({ type: string(), text: string().optional() })).optional(),
    }),
  ),
});

function basic(password: string): string {
  // Executor swaps the password handle inside a Basic header for the real value.
  return `Basic ${btoa(`opencode:${password}`)}`;
}

type SessionCreate = {
  location: { directory: string };
  model: { providerID: string; id: string; variant?: string | undefined };
  agent?: string;
  title?: string;
};

type RequestBody = SessionCreate | { text: string };

type RequestHeaders = { authorization: string; "content-type"?: string };

// Result is read-only once built, so a finished result is assembled as this first.
type Finished = { sessionID: string; running: false; outcome?: string; error?: string; reply?: string };

function request(client: Client, method: string, path: string, body?: RequestBody) {
  const headers: RequestHeaders = { authorization: basic(client.password) };
  const init: RequestInit = { method, headers };

  if (client.signal !== undefined) init.signal = client.signal;

  if (body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  return client.fetch(`${origin}${path}`, init);
}

export async function info(client: Client) {
  return decodeJson(await request(client, "GET", "/api/info"), Info);
}

export const opencode = defineProvider({
  name: "OpenCode",
  hosts: [host],
  auth: {
    password: secrets({
      label: "Service password",
      fields: object({ password: string({ minLength: 1 }) }),
    }),
  },
  async health({ account, fetch, signal }) {
    try {
      await info({ fetch, signal, password: account.fields.password });
    } catch (error) {
      if (error instanceof ResponseStatusError && error.status === 401)
        throw new ProviderError({ reason: "unauthorized", status: 401 });

      throw error;
    }
  },
});

export async function startSession(client: Client, input: Infer<typeof Start>) {
  const session: SessionCreate = { location: { directory: input.directory }, model: input.model ?? defaultModel };

  if (input.agent !== undefined) session.agent = input.agent;

  if (input.title !== undefined) session.title = input.title;

  const created = await decodeJson(await request(client, "POST", "/api/session", session), Created);

  const sessionID = created.data.id;

  const prompted = await request(client, "POST", `/api/session/${sessionID}/prompt`, {
    text: input.prompt,
  });

  if (!prompted.ok) throw new Error(`OpenCode refused the prompt with status ${prompted.status}`);

  return { sessionID };
}

// OpenCode ends every turn with an `idle` message carrying its outcome and any error, so a
// session is finished once it is no longer active and its newest message is that marker.
export async function sessionResult(client: Client, sessionID: string): Promise<Infer<typeof Result>> {
  const [active, messages] = await Promise.all([
    request(client, "GET", "/api/session/active").then((response) => decodeJson(response, Active)),
    request(client, "GET", `/api/session/${sessionID}/message?limit=10&order=desc`).then((response) =>
      decodeJson(response, Messages),
    ),
  ]);

  const idle = messages.data[0]?.type === "idle" ? messages.data[0] : undefined;

  if (sessionID in active.data || idle === undefined) return { sessionID, running: true };

  const reply = messages.data
    .find((message) => message.type === "assistant")
    ?.content?.flatMap((part) => (part.type === "text" && part.text !== undefined ? [part.text] : []))
    .join("\n\n");

  const result: Finished = { sessionID, running: false };

  if (idle.outcome !== undefined) result.outcome = idle.outcome;

  if (idle.error !== undefined) result.error = idle.error.message;

  if (reply !== undefined && reply !== "") result.reply = reply;

  return result;
}
