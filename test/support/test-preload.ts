import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const root = process.env.OFFICE_TEST_ROOT;

if (!root || tmpdir() !== root || homedir() !== join(root, "home")) throw new Error("Use ./bin/test [bun test arguments] so HOME is isolated before Bun starts");

const scratch = mkdtempSync(join(root, "worker-"));

Object.assign(process.env, {
  XDG_DATA_HOME: join(scratch, "data"), XDG_CONFIG_HOME: join(scratch, "config"),
  XDG_CACHE_HOME: join(scratch, "cache"), XDG_STATE_HOME: join(scratch, "state"),
  OFFICE_MACHINE_RECORD: join(scratch, "machine.json"), OFFICE_MISE_CONFIG_DIR: join(scratch, "mise-config"),
  OFFICE_MACHINE_DIR: join(scratch, "office-data"), OFFICE_SYSTEMD_USER_DIR: join(scratch, "systemd-user"), OFFICE_SYSTEM_PLATFORM: "",
});
