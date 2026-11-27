// `office pair`: a one-time link that connects the OpenCode desktop app or a browser to the
// office's OpenCode server. It asks the running server for a pairing code (POST /api/pair with the
// office's password) and prints the server's connect link. The same in both modes; it never
// changes the server's settings, and nothing listens beyond 127.0.0.1.
import * as v from "valibot";

import { type Office, OfficeError } from "../office.ts";
import { requestOpenCode } from "../features/opencode/opencode-request.ts";
import { check } from "../schema.ts";

const pairingSchema = v.object({ code: v.string(), expires_in: v.number() });

export async function pair(office: Office, origin: string | undefined): Promise<string> {
  const { response, server } = await requestOpenCode(office, "POST", "/api/pair");

  if (!response.ok) throw new OfficeError(`OpenCode at ${server} answered HTTP ${response.status} to a pairing request`);

  const pairing = check(v.safeParse(pairingSchema, await response.json()));

  if (!pairing.ok) throw new OfficeError(`OpenCode at ${server} answered a pairing request in an unexpected shape`);

  const link = new URL(`/auth/connect/${pairing.value.code}`, origin ?? server).href;
  const minutes = Math.round(pairing.value.expires_in / 60);

  return `Open this link in a browser, or paste it into the OpenCode app's server address. It works once and expires in ${minutes} minutes; the app keeps its sign-in until the office's OpenCode password changes.\n\n  ${link}`;
}
