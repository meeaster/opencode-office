import { expect, test } from "bun:test";

import * as v from "valibot";
import { parse } from "yaml";

import { check, officeSchema } from "./schema.ts";

/** The schema's errors for an office.yaml named t with `rest` after its name. */
function errors(rest: string): string[] {
  const result = check(v.safeParse(officeSchema, parse(`name: t\n${rest}`)));

  return result.ok ? [] : result.errors;
}

test("a claude block says the gateway was removed", () => {
  expect(errors("claude:\n  credential: secrets/claude.enc.json\n  settings: claude/settings.json\n")).toEqual([
    "claude: was the Claude gateway, which office no longer has: delete the claude block from office.yaml",
  ]);
});
