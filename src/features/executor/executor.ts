// The office's connection to its Executor, which the runtime owns: the token and the OpenCode
// password are read here and never handed out. Core notifications use the connection directly;
// packages get `ExecutorAccess`, which keeps both secrets inside this module.
import { join } from "node:path";
import * as v from "valibot";

import type { ExecutorAccess, JsonValue, OpenCodeLink } from "../../../sdk/index.ts";
import { ports } from "../../lib/ports.ts";
import { executorEnvFile, type Office, OfficeError, readEnvFile } from "../../office.ts";
import { check } from "../../schema.ts";

export type Connection = { url: string; token: string };

/**
 * The token the runtime uses: EXECUTOR_TOKEN in the container, else the office's key from its
 * state. Undefined when neither has one, a blank one included, which is what "no Executor
 * configured" means.
 */
function token(office: Office): string | undefined {
  const found = process.env.EXECUTOR_TOKEN ?? readEnvFile(executorEnvFile(office)).EXECUTOR_TOKEN;

  return found?.trim() ? found : undefined;
}

/** Executor's address: OFFICE_EXECUTOR_URL in the container, else its published port. */
function executorUrl(): string {
  return process.env.OFFICE_EXECUTOR_URL ?? `http://localhost:${ports().executor}`;
}

/**
 * Executor's address and a token. In the container, OFFICE_EXECUTOR_URL and EXECUTOR_TOKEN are
 * set; on the host, Executor is on its published port and the token is the office's key, from its
 * state.
 */
export function connection(office: Office): Connection {
  const found = token(office);

  if (found === undefined) {
    // In the container the token comes from the environment, which the state file feeds.
    throw new OfficeError(`no Executor token: office setup saves the office's key in ${process.env.OFFICE_EXECUTOR_URL === undefined ? executorEnvFile(office) : "the office state's office-executor.env; then restart the container"}`);
  }

  return { url: executorUrl(), token: found };
}

/** Calls Executor's HTTP API; the caller names the shape of the JSON it expects back. */
export type Call = <Result = null>(method: string, path: string, body?: JsonValue, options?: { timeout?: number }) => Promise<Result>;

/** A request Executor answered with an error status, which `status` holds. */
class ExecutorHttpError extends OfficeError {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/**
 * Requests against the connection's Executor only: `path` must start with one `/` and stay on its
 * origin, and a redirect is refused rather than followed, so the token never goes elsewhere. An
 * error names the method, path, status and response, with the token masked, and carries the status.
 */
export function client({ url, token }: Connection): Call {
  const origin = new URL(url).origin;

  return async (method, path, body, { timeout = 300_000 } = {}) => {
    if (!path.startsWith("/") || path.startsWith("//")) throw new OfficeError(`${method} ${path}: an Executor request takes a path starting with /, not an address`);
    const target = new URL(`${url}${path}`);

    if (target.origin !== origin) throw new OfficeError(`${method} ${path}: the path leaves the office's Executor`);
    const authorization = `Bearer ${token}`;

    const response = await fetch(target, {
      method,
      headers: body === undefined ? { authorization } : { authorization, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "manual",
      signal: AbortSignal.timeout(timeout),
    });

    const text = await response.text();

    if (response.status >= 300 && response.status < 400) throw new ExecutorHttpError(`${method} ${path}: HTTP ${response.status}: Executor redirected the request, which is refused`, response.status);

    if (!response.ok) throw new ExecutorHttpError(`${method} ${path}: HTTP ${response.status} ${text.replaceAll(token, "***")}`, response.status);

    return text === "" ? null : JSON.parse(text);
  };
}

/** The credential host of the OpenCode server as Executor reaches it, such as opencode:4096. */
function opencodeHost(office: Office): string {
  return new URL(office.opencode.containerUrl).host;
}

/**
 * The host an OpenCode account was connected for, from its label. Accounts keep the hosts they were
 * connected with and Executor's API doesn't show them, so the label records it; a label without one
 * predates host mode, when every account was the opencode container's.
 */
function accountHost(label: string): string {
  return / at (\S+)\)$/.exec(label)?.[1] ?? "opencode:4096";
}

const appList = v.array(v.object({
  id: v.string(),
  slug: v.string(),
  requirements: v.nullish(v.object({ accounts: v.nullish(v.record(v.string(), v.object({ scope: v.nullish(v.string()) }))) })),
}));

const accountLinks = v.array(v.object({ requirement: v.string(), account: v.object({ id: v.string(), label: v.string() }) }));

function parsed<S extends v.GenericSchema>(schema: S, value: v.InferInput<S>): v.InferOutput<S> {
  const result = check(v.safeParse(schema, value));

  if (!result.ok) throw new OfficeError(`Executor: ${result.errors.join("; ")}`);

  return result.value;
}

/**
 * Links app `slug` to the OpenCode account for the server's current host when it declares an
 * `opencode` app account and isn't linked to one. An account another app already links for this
 * host is reused; one is created only when no app has one, through the same connection form a
 * browser would fill, with the office's server password, which never leaves this function.
 */
async function linkOpenCode(office: Office, call: Call, slug: string): Promise<OpenCodeLink> {
  const { organization } = await call<{ organization: string }>("GET", "/api/context");
  const base = `/api/organizations/${organization}`;
  const apps = parsed(appList, await call<v.InferInput<typeof appList>>("GET", `${base}/apps`));
  const app = apps.find((entry) => entry.slug === slug);

  if (app === undefined) throw new OfficeError(`no Executor app ${slug} to link to OpenCode`);

  if (app.requirements?.accounts?.opencode?.scope !== "app") return { outcome: "not-required" };
  const host = opencodeHost(office);
  const linked = async (id: string) => parsed(accountLinks, await call<v.InferInput<typeof accountLinks>>("GET", `${base}/apps/${id}/accounts/app`)).find((link) => link.requirement === "opencode" && accountHost(link.account.label) === host);
  const own = await linked(app.id);

  if (own !== undefined) return { outcome: "unchanged", account: own.account.id };

  for (const other of apps) {
    if (other.id === app.id || other.requirements?.accounts?.opencode?.scope !== "app") continue;
    const found = await linked(other.id);

    if (found === undefined) continue;
    await call("PUT", `${base}/apps/${app.id}/accounts/app/opencode/${found.account.id}`);

    return { outcome: "linked", account: found.account.id };
  }

  const password = process.env.OPENCODE_PASSWORD ?? readEnvFile(join(office.state, "secrets.env")).OPENCODE_PASSWORD;

  if (password === undefined) throw new OfficeError("OPENCODE_PASSWORD is missing from the office state's secrets.env");
  const started = await call<{ id: string }>("POST", `${base}/apps/${app.id}/accounts/app/opencode/connections`, {});
  let created: { id: string };

  try {
    created = await call<{ id: string }>("POST", `${base}/connections/${started.id}/submit`, {
      method: "password",
      label: `OpenCode (${office.name} office at ${host})`,
      fields: { password },
    });
  } catch (error) {
    // The response to a form carrying the password isn't repeated.
    const status = error instanceof ExecutorHttpError ? `: HTTP ${error.status}` : "";

    throw new OfficeError(`connecting ${slug}'s OpenCode account failed${status}`);
  }

  return { outcome: "connected", account: created.id };
}

/**
 * What a package's command, `up` or `check` gets to reach the office's Executor, or undefined when
 * the runtime has no Executor token. A check's access only reads: anything but GET throws.
 */
export function executorAccess(office: Office, { readOnly = false } = {}): ExecutorAccess | undefined {
  const found = token(office);

  if (found === undefined) return;
  const call = client({ url: executorUrl(), token: found });
  const refuse = (what: string) => new OfficeError(`${what}: a package's check only reports; it can't change Executor`);

  return {
    request: <Result>(method: string, path: string, body?: JsonValue, options?: { timeout?: number }) => {
      if (readOnly && method.toUpperCase() !== "GET") return Promise.reject(refuse(`${method} ${path}`));

      return call<Result>(method, path, body, options);
    },
    opencode: { url: office.opencode.containerUrl, directory: office.opencode.directory, mode: office.opencode.mode },
    linkOpenCode: (slug: string) => readOnly ? Promise.reject(refuse(`linking ${slug} to OpenCode`)) : linkOpenCode(office, call, slug),
  };
}
