import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginGeneration, publishGeneration } from "../../../../src/loader/generation/storage.ts";
import { fullSyncStep } from "../../../../src/loader/lifecycle/full-sync.ts";
import { loadOffice } from "../../../../src/office.ts";
import { silentStage } from "../../../../src/report/index.ts";

test("full sync refuses work for a generation another sync already replaced", async () => {
  const dir = mkdtempSync(join(tmpdir(), "office-full-sync-"));

  try {
    writeFileSync(join(dir, "office.yaml"), "name: test\n");
    using next = beginGeneration(dir);
    const { previous, original } = next.transaction;

    publishGeneration(next.transaction, original, new Map());
    expect(await fullSyncStep(loadOffice(dir), previous, silentStage, 0)).toEqual([
      { failure: "FAILED packages' full-sync work: another sync replaced this sync's package set before it ran; run office sync again" },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
