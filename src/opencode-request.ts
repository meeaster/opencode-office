import { join } from "node:path";

import { type Office, OfficeError, readEnvFile } from "./office.ts";
import { ports } from "./commands/compose.ts";

/** Contact the office's running OpenCode server on its configured or published address. */
export async function requestOpenCode(office: Office, method: "GET" | "POST", path: string) {
  const server = office.opencode.url ?? `http://127.0.0.1:${ports().opencode}`;
  const secrets = join(office.state, "secrets.env");
  const password = readEnvFile(secrets).OPENCODE_PASSWORD;

  if (!password) throw new OfficeError(`no OPENCODE_PASSWORD in ${secrets}`);

  let response;

  try {
    response = await fetch(new URL(path, server), {
      method,
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new OfficeError(`OpenCode isn't answering at ${server}${office.opencode.mode === "container" ? "; start it with office up" : ""}`);
  }

  if (response.status === 401 || response.status === 403) throw new OfficeError(`OpenCode at ${server} refused the office's password from secrets.env`);

  return { response, server };
}
