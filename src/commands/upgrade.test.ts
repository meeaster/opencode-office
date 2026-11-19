import { expect, test } from "bun:test";

import * as v from "valibot";
import { parse } from "yaml";

import { check, officeSchema, resolveTools } from "../schema.ts";
import { setVersions } from "./upgrade.ts";

/** The runtimes' versions an office.yaml asks for, read back through the schema. */
function versionsOf(text: string) {
  const result = check(v.safeParse(officeSchema, parse(text)));

  if (!result.ok) throw new Error(result.errors.join("\n"));

  return Object.fromEntries(Object.entries(resolveTools(result.value).runtimes).map(([tool, runtime]) => [tool, runtime.version]));
}

test("upgrade-tools changes only the version of each form of a tools entry, keeping comments, quotes and layout", () => {
  const text = `name: t
# The tools.
tools:
  minimum_release_age: 3d   # everything
  opencode: { version: 2.3.2, minimum_release_age: 0d }  # flow
  claude: '2.1.327'  # short, quoted
  executor:
    # Betas almost daily.
    minimum_release_age: 7d
    version: "2.0.0-beta.49"
  mise: 2026.11.9
  sfw: { enabled: false }
  codex:
    minimum_release_age: 1d
# After tools.
cron: {}
`;

  const result = setVersions(text, [
    { tool: "opencode", to: "2.3.5" },
    { tool: "claude", to: "2.1.330" },
    { tool: "executor", to: "2.0.0-beta.52" },
    { tool: "mise", to: "2026.11.10" },
    { tool: "sfw", to: "1.17.0" },
    { tool: "codex", to: "0.171.0" },
  ]);

  expect(result).toBe(`name: t
# The tools.
tools:
  minimum_release_age: 3d   # everything
  opencode: { version: 2.3.5, minimum_release_age: 0d }  # flow
  claude: '2.1.330'  # short, quoted
  executor:
    # Betas almost daily.
    minimum_release_age: 7d
    version: "2.0.0-beta.52"
  mise: 2026.11.10
  sfw: { version: 1.17.0, enabled: false }
  codex:
    version: 0.171.0
    minimum_release_age: 1d
# After tools.
cron: {}
`);
  expect(versionsOf(result)).toEqual({ opencode: "2.3.5", claude: "2.1.330", codex: "0.171.0", executor: "2.0.0-beta.52", mise: "2026.11.10", sfw: "1.17.0" });
});

test("a runtime tools doesn't list is added after its last entry, in the short form", () => {
  const text = "name: t\ntools:\n  minimum_release_age: 3d\n  executor:\n    version: 2.0.0-beta.49\n    minimum_release_age: 7d\n# Next.\ncron: {}\n";

  expect(setVersions(text, [{ tool: "claude", to: "2.1.330" }])).toBe("name: t\ntools:\n  minimum_release_age: 3d\n  executor:\n    version: 2.0.0-beta.49\n    minimum_release_age: 7d\n  claude: 2.1.330\n# Next.\ncron: {}\n");
  expect(setVersions("name: t\ntools:\n    opencode: 2.3.2", [{ tool: "sfw", to: "1.17.0" }])).toBe("name: t\ntools:\n    opencode: 2.3.2\n    sfw: 1.17.0\n");
});

test("an office.yaml from before tools keeps its versions block, and a tool it lacks is added there", () => {
  const text = "name: t\n# The versions.\nversions:\n  opencode: 2.3.2  # pinned\n  sfw: 1.16.0\n# After.\nupgrades:\n  minimum_release_age: 1d\n";
  const result = setVersions(text, [{ tool: "opencode", to: "2.3.5" }, { tool: "codex", to: "0.171.0" }]);

  expect(result).toBe("name: t\n# The versions.\nversions:\n  opencode: 2.3.5  # pinned\n  sfw: 1.16.0\n  codex: 0.171.0\n# After.\nupgrades:\n  minimum_release_age: 1d\n");
  expect(result).not.toContain("tools:");
});

test("a tools block the writer can't edit safely is left for the user", () => {
  expect(() => setVersions("name: t\ntools: { opencode: 2.3.2 }\n", [{ tool: "sfw", to: "1.17.0" }])).toThrow("set tools.sfw to 1.17.0 in office.yaml by hand");
});
