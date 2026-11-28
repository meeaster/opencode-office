// `office init <dir>`: a new office from the template, with the built-in
// knowledge and browser packages, as a git repository on branch main. Its office.yaml starts at the tool's
// versions, which office.lock pins.
import { changeText, isFailure } from "../lib/change.ts";
import { existsSync, readdirSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { git } from "../git.ts";
import { installHook } from "../features/machine/hook.ts";
import { loadOffice, OfficeError } from "../office.ts";
import { defaultPins, writeLock } from "../versions.ts";
import { copyTemplate, sync } from "./sync.ts";

/** What `office init` prints last: what a new office needs before it runs. */
export function nextSteps(dir: string): string {
  return `Next: review ${join(dir, "office.yaml")} (choose container or host mode, add a git identity, select packages such as repos),
then run office setup in ${dir}.`;
}

export async function init(target: string, name: string | undefined) {
  const dir = resolve(target);
  const officeName = name ?? basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, "-");

  if (existsSync(dir) && readdirSync(dir).length > 0) throw new OfficeError(`${dir} is not empty`);

  copyTemplate("template/office", dir, {
    OFFICE: officeName,
    OPENCODE_VERSION: defaultPins.opencode.version,
    CLAUDE_VERSION: defaultPins.claude.version,
    CODEX_VERSION: defaultPins.codex.version,
    EXECUTOR_VERSION: defaultPins.executor.version,
    MISE_VERSION: defaultPins.mise.version,
    SFW_VERSION: defaultPins.sfw.version,
  });
  writeLock(dir, defaultPins);

  // Installs the built-in office, knowledge and browser packages from this executable, writes the
  // browser package's mise tools and links the plugins they register.
  const changes = await sync(loadOffice(dir));
  const failures = changes.filter(isFailure).map(changeText);

  // main whatever git's default branch is on this machine.
  if (!existsSync(resolve(dir, ".git"))) git(["init", "--quiet", "--initial-branch=main", dir]);

  if (failures.length) throw new OfficeError(`${failures.join("\n")}\nInitial sync failed in ${dir}; fix the failures and run office sync.`);

  // The gitleaks hook guards the first commit too, when this machine already has the office's
  // pre-commit; otherwise office setup installs both.
  const hook = installHook(loadOffice(dir));

  return { dir, changes: hook === undefined ? changes.map(changeText) : [...changes.map(changeText), hook] };
}
