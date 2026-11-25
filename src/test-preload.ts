// Loaded before every test file (bunfig.toml): points the machine record and mise's global config
// folder, which a host-mode office's sync writes to, at a folder of this run's own. mise itself keeps
// its real config, so tools that tests run through its shims still resolve.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { machineDirVariable } from "./host-env.ts";
import { unitDirVariable } from "./host-server.ts";
import { machineRecordVariable, miseConfigVariable } from "./machine.ts";
import { systemPlatformVariable } from "./package-system.ts";
import { pinnedMise } from "./test-package.ts";

const scratch = mkdtempSync(join(tmpdir(), "office-test-machine-"));

process.env[machineRecordVariable] = join(scratch, "machine.json");

process.env[miseConfigVariable] = join(scratch, "mise-config");

process.env[machineDirVariable] = join(scratch, "office-data");

process.env[unitDirVariable] = join(scratch, "systemd-user");

// No package system setup applies to the machine running the tests unless a test names its platform.
process.env[systemPlatformVariable] = "";

// The shared tools run only the mise version an office pins, and the tests' offices pin the
// release's default: a stand-in for it comes first on PATH (pinnedMise).
const machineMise = Bun.which("mise");

if (machineMise !== null) {
  pinnedMise(join(scratch, "pinned-mise"), machineMise);
  process.env.PATH = `${join(scratch, "pinned-mise")}:${process.env.PATH ?? ""}`;
}
