// `office pair`: a one-time link that connects the OpenCode desktop app or a browser to the
// office's OpenCode server. It asks the running server for a pairing code (POST /api/pair with the
// office's password) and prints the server's connect link. The same in both modes; it never
// changes the server's settings, and nothing listens beyond 127.0.0.1.
import { join } from "node:path";

import * as v from "valibot";

import { type Office, OfficeError, readEnvFile } from "../office.ts";
import { check } from "../schema.ts";
import { ports } from "./compose.ts";

const pairingSchema = v.object({ code: v.string(), expires_in: v.number() });

/** Where the user's machine reaches the server: the published port, or the host server's URL. */
function serverUrl(office: Office): string {
  return office.opencode.url ?? `http://127.0.0.1:${ports().opencode}`;
}

export async function pair(office: Office, origin: string | undefined): Promise<string> {
  const password = readEnvFile(join(office.state, "secrets.env")).OPENCODE_PASSWORD;

  if (password === undefined) throw new OfficeError(`no OPENCODE_PASSWORD in ${join(office.state, "secrets.env")}`);

  const server = serverUrl(office);
  let response;

  try {
    response = await fetch(new URL("/api/pair", server), {
      method: "POST",
      headers: { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new OfficeError(`OpenCode isn't answering at ${server}${office.opencode.mode === "container" ? "; start it with office up" : ""}`);
  }

  if (response.status === 401 || response.status === 403) throw new OfficeError(`OpenCode at ${server} refused the office's password from secrets.env`);

  if (!response.ok) throw new OfficeError(`OpenCode at ${server} answered HTTP ${response.status} to a pairing request`);

  const pairing = check(v.safeParse(pairingSchema, await response.json()));

  if (!pairing.ok) throw new OfficeError(`OpenCode at ${server} answered a pairing request in an unexpected shape`);

  const link = new URL(`/auth/connect/${pairing.value.code}`, origin ?? server).href;
  const minutes = Math.round(pairing.value.expires_in / 60);

  return `Open this link in a browser, or paste it into the OpenCode app's server address. It works once and expires in ${minutes} minutes; the app keeps its sign-in until the office's OpenCode password changes.\n\n  ${link}`;
}
