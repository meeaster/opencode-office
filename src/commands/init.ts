// `office init <dir>`: a new office from the template, with one example desk, as a git repository
// on branch main. Its office.yaml starts at the tool's versions, which office.lock pins.
import { existsSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";

import { git } from "../git.ts";
import { loadOffice, OfficeError } from "../office.ts";
import { defaultPins, writeLock } from "../versions.ts";
import { copyTemplate, sync } from "./sync.ts";

export async function init(target: string, name: string | undefined) {
  const dir = resolve(target);
  const officeName = name ?? basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, "-");

  if (existsSync(dir) && readdirSync(dir).length > 0) throw new OfficeError(`${dir} is not empty`);

  copyTemplate("template/office", dir, {
    OFFICE: officeName,
    OPENCODE_VERSION: defaultPins.opencode.version,
    CLAUDE_VERSION: defaultPins.claude.version,
    EXECUTOR_VERSION: defaultPins.executor.version,
    MISE_VERSION: defaultPins.mise.version,
  });
  writeLock(dir, defaultPins);

  // Writes the tool's plugins, scaffolds the example desk and links the enabled skills.
  const changes = await sync(loadOffice(dir));

  // main whatever git's default branch is on this machine.
  if (!existsSync(resolve(dir, ".git"))) git(["init", "--quiet", "--initial-branch=main", dir]);

  return { dir, changes };
}
