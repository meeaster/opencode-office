import { expect, test } from "bun:test";
import { commandConflicts, commandRegistration } from "./command-table.ts";

const run = () => {};
const owner = (name: string, route: string, aliases: string[] = []) => ({ name, commands: { routes: [{ name: route, aliases, summary: "Summary" }], settings: {} } });

test("an alias can neither take another package's command, a core command, nor a flag", () => {
  for (const alias of ["sync --packages", "--help"]) {
    const read = commandRegistration({ name: "draft show", aliases: [alias], summary: "Draft", run });

    expect(read.ok).toBe(false);
    expect(read.ok ? "" : read.errors.join("\n")).toContain(`invalid route ${JSON.stringify(alias)}`);
  }

  expect(commandRegistration({ name: "draft show", aliases: ["draft read"], summary: "Draft", run }).ok).toBe(true);

  const press = owner("press", "issue read");

  expect(commandConflicts([press, owner("ink", "draft show", ["issue read"])], "publish")).toEqual(["command issue read claimed by both package press and package ink"]);
  expect(commandConflicts([press, owner("ink", "draft show", ["sync"])], "publish")).toEqual(["package ink: command sync is reserved"]);
  expect(commandConflicts([press, owner("ink", "draft show", ["draft read"])], "publish")).toEqual([]);
});
