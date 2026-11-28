import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedSelection, selectionFile } from "../../../../src/loader/installed/paths.ts";
import { fullSyncStep, runFullSync } from "../../../../src/loader/lifecycle/full-sync.ts";
import { loadOffice } from "../../../../src/office.ts";
import { silentStage } from "../../../../src/report/index.ts";

test("full sync refuses work when the office selection differs from the installed set", async () => {
  const dir = mkdtempSync(join(tmpdir(), "office-full-sync-"));

  try {
    writeFileSync(join(dir, "office.yaml"), "name: test\npackages: [{name: skills}]\n");
    mkdirSync(join(dir, ".office"));
    writeFileSync(join(dir, ".office/selection.json"), "[]");
    const messages: string[] = [];

    await runFullSync(loadOffice(dir), false, event => {
      if (event.type === "problem") messages.push(event.text);
    });
    expect(messages).toEqual(["office.yaml's packages changed after this sync applied its package set, so no package's full-sync work ran; run office sync again"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("full sync starts no worker when another sync has installed a set under the same pins", async () => {
  const dir = mkdtempSync(join(tmpdir(), "office-full-sync-"));

  try {
    writeFileSync(join(dir, "office.yaml"), "name: test\n");
    mkdirSync(join(dir, ".office"));
    writeFileSync(selectionFile(dir), "[]");
    const applied = installedSelection(dir);

    if (applied === undefined) throw new Error("missing fixture selection");
    const incoming = join(dir, ".office/selection.new");
    writeFileSync(incoming, "[]");
    renameSync(incoming, selectionFile(dir));

    expect(await fullSyncStep(loadOffice(dir), applied, silentStage, 0)).toEqual([
      { failure: "FAILED packages' full-sync work: another sync replaced this sync's package set before it ran; run office sync again" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
