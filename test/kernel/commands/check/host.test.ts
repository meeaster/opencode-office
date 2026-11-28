import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { toolsNotes } from "../../../../src/commands/check/host.ts";
import { loadOffice } from "../../../../src/office.ts";

test("a mise minimum_release_age setting in machine.toml or mise.toml other than the office's is noted, since the environment wins", () => {
  const dir = mkdtempSync(join(tmpdir(), "office-check-"));

  try {
    writeFileSync(join(dir, "office.yaml"), "name: t\nminimum_release_age: 1d\n");
    writeFileSync(join(dir, "machine.toml"), '[settings]\nminimum_release_age = "24h"\n');
    writeFileSync(join(dir, "mise.toml"), '[tools]\nnode = "26.13.1"\n');
    const office = loadOffice(dir);

    expect(toolsNotes(office)).toEqual([]);

    writeFileSync(join(dir, "mise.toml"), '[settings]\nminimum_release_age = "7d"\n');
    expect(toolsNotes(office)).toEqual([
      `mise.toml sets minimum_release_age = "7d" under [settings], but the office's environment sets MISE_MINIMUM_RELEASE_AGE=1d (minimum_release_age in office.yaml), which wins wherever it is loaded; remove the setting or change the office's age`,
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
