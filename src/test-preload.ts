// Loaded before every test file (bunfig.toml): points the machine record and mise's global config
// folder, which a host-mode office's sync writes to, at a folder of this run's own. mise itself keeps
// its real config, so tools that tests run through its shims still resolve.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { machineRecordVariable, miseConfigVariable } from "./machine.ts";

const scratch = mkdtempSync(join(tmpdir(), "office-test-machine-"));

process.env[machineRecordVariable] = join(scratch, "machine.json");

process.env[miseConfigVariable] = join(scratch, "mise-config");
