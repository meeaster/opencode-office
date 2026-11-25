import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { officeInstructions } from "../plugin/instructions.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-instructions-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("sessions are told the office's minimum release age while Socket Firewall is on", () => {
  writeFileSync(join(dir, "office.yaml"), "name: t\n");
  expect(officeInstructions(dir)).toContain("Package managers take only releases at least 3d old (`minimum_release_age` in `office.yaml`)");

  writeFileSync(join(dir, "office.yaml"), "name: t\nminimum_release_age: 36h\n");
  expect(officeInstructions(dir)).toContain("at least 36h old");

  writeFileSync(join(dir, "office.yaml"), "name: t\nminimum_release_age: 0d\n");
  expect(officeInstructions(dir)).toContain("Package managers take new releases as soon as they're published.");

  writeFileSync(join(dir, "office.yaml"), "name: t\ntools:\n  sfw: { enabled: false }\n");
  expect(officeInstructions(dir)).not.toContain("Socket Firewall");
});
