import * as v from "valibot";

import { type Office, OfficeError } from "../office.ts";
import { requestOpenCode } from "../features/opencode/opencode-request.ts";
import { check } from "../schema.ts";

const entries = v.object({ data: v.array(v.object({ key: v.string(), value: v.string() })) });

export async function sessionInstructions(office: Office, id: string): Promise<string> {
  if (!id.startsWith("ses_")) throw new OfficeError("expected an OpenCode session ID starting with ses_");

  const { response, server } = await requestOpenCode(office, "GET", `/api/experimental/session/${encodeURIComponent(id)}/instructions/entries`);

  if (response.status === 404) throw new OfficeError(`no instruction-entry endpoint or session ${id} at ${server}; check the session ID and server version`);

  if (!response.ok) throw new OfficeError(`OpenCode at ${server} answered HTTP ${response.status} when reading session instructions`);

  const result = check(v.safeParse(entries, await response.json().catch(() => null)));

  if (!result.ok) throw new OfficeError(`OpenCode at ${server} did not return session instruction entries`);

  if (!result.value.data.length) return `No stored instruction entries for ${id}.`;

  return result.value.data.map(entry => `## ${entry.key}\n\n${entry.value}`).join("\n\n");
}
