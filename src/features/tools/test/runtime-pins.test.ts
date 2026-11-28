import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadOffice } from "../../../office.ts";
import { defaultPins, editLock } from "../../../versions.ts";
import { wantedPins } from "../runtime-pins.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-runtime-pins-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("wanted pins refuse a lock with no runtime section", () => {
  editLock(dir, (sections) => {
    sections.tools.set("core:bun", { version: "1.4.4" });
  });
  writeFileSync(join(dir, "office.yaml"), `name: t\ntools:\n  opencode: ${defaultPins.opencode.version}\n`);

  expect(() => wantedPins(loadOffice(dir))).toThrow("office.yaml pins versions but office.lock holds no runtime pins: run office pin");
});
