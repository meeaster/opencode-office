// A systemd user manager in memory, for tests of what office asks of it (src/features/systemd/user-units.ts).
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { unitDir } from "../../src/features/systemd/systemd.ts";
import type { UnitManager, UnitState } from "../../src/features/systemd/user-units.ts";

/**
 * A user manager in memory: what each unit's file held at the last daemon-reload is what a start
 * runs, so a test sees whether a reload preceded activation. As the real manager does (seen on
 * Office-Test, systemd 259), a unit needs a reload (`stale`) after its file changed on disk or after
 * `enable --no-reload`; `enable` and `disable` without it reload implicitly.
 */
export function fakeManager() {
  type Unit = { active: string; enabled: string; pid: number; invocation: string; ran?: string };

  const units = new Map<string, Unit>();
  const loaded = new Map<string, string>();
  const calls: string[] = [];
  const overrides = new Map<string, Partial<UnitState>>();
  const marked = new Set<string>();
  let next = 100;

  const unit = (name: string): Unit => {
    const found = units.get(name) ?? { active: "inactive", enabled: "disabled", pid: 0, invocation: "" };

    units.set(name, found);

    return found;
  };

  const reload = () => {
    loaded.clear();
    marked.clear();

    for (const file of [...units.keys(), ...overrides.keys()]) {
      const path = join(unitDir(), file);

      if (existsSync(path)) loaded.set(file, readFileSync(path, "utf8"));
    }
  };

  const launch = (name: string) => {
    const text = loaded.get(name);
    const found = unit(name);

    if (text === undefined) throw new Error(`Unit ${name} not found.`);
    next += 1;
    Object.assign(found, { active: "active", pid: next, invocation: `run-${next}`, ran: text });
  };

  const manager: UnitManager = {
    run(args) {
      calls.push(args.join(" "));
      const name = args.at(-1) ?? "";

      if (args[0] === "daemon-reload") reload();
      else if (args[0] === "start" || args[0] === "restart") launch(name);
      else if (args[0] === "enable") {
        unit(name).enabled = "enabled";

        if (args.includes("--no-reload")) marked.add(name);
        else reload();
      } else if (args[0] === "stop") Object.assign(unit(name), { active: "inactive", pid: 0 });
      else if (args[0] === "disable") {
        Object.assign(unit(name), { enabled: "disabled", active: "inactive", pid: 0 });
        reload();
      }

      return "";
    },
    state(name) {
      const found = unit(name);
      const path = join(unitDir(), name);

      if (!loaded.has(name) && existsSync(path)) loaded.set(name, readFileSync(path, "utf8"));

      const changed = loaded.has(name) && existsSync(path) && readFileSync(path, "utf8") !== loaded.get(name);

      return { fragment: loaded.has(name) ? path : "", dropIns: "", active: found.active, enabled: found.enabled, pid: found.pid, invocation: found.invocation, stale: marked.has(name) || changed, ...overrides.get(name) };
    },
  };

  return { manager, units, calls, overrides, reset: () => void calls.splice(0) };
}
