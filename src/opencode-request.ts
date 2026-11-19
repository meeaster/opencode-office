import { join } from "node:path";

import { type Office, OfficeError, readEnvFile } from "./office.ts";
import { ports } from "./commands/compose.ts";

/** A JSON body to send, and how long to wait for the answer (10 seconds unless set). */
export type OpenCodeRequestOptions = { body?: unknown; timeoutMs?: number };

/** Contact the office's running OpenCode server on its configured or published address. */
export async function requestOpenCode(office: Office, method: "GET" | "POST" | "DELETE", path: string, options: OpenCodeRequestOptions = {}) {
  const server = office.opencode.url ?? `http://127.0.0.1:${ports().opencode}`;
  const secrets = join(office.state, "secrets.env");
  const password = readEnvFile(secrets).OPENCODE_PASSWORD;

  if (!password) throw new OfficeError(`no OPENCODE_PASSWORD in ${secrets}`);

  const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;

  let response;

  try {
    response = await fetch(new URL(path, server), {
      method,
      headers: options.body === undefined ? { authorization } : { authorization, "content-type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: "error",
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    });
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError" && options.timeoutMs !== undefined) {
      throw new OfficeError(`OpenCode at ${server} did not answer ${method} ${new URL(path, server).pathname} within ${Math.round(options.timeoutMs / 1000)}s`);
    }

    throw new OfficeError(`OpenCode isn't answering at ${server}${office.opencode.mode === "container" ? "; start it with office up" : ""}`);
  }

  if (response.status === 401 || response.status === 403) throw new OfficeError(`OpenCode at ${server} refused the office's password from secrets.env`);

  return { response, server };
}
