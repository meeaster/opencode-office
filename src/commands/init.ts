// `office init <dir>`: a new office from the template, with one example desk, as a git repository.
import { existsSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";

import { git } from "../git.ts";
import { loadOffice, OfficeError } from "../office.ts";
import { copyTemplate, sync } from "./sync.ts";

export function init(target: string, name: string | undefined) {
  const dir = resolve(target);
  const officeName = name ?? basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, "-");

  if (existsSync(dir) && readdirSync(dir).length > 0) throw new OfficeError(`${dir} is not empty`);

  copyTemplate("template/office", dir, { OFFICE: officeName });

  // Writes the tool's plugins, scaffolds the example desk and links the enabled skills.
  const changes = sync(loadOffice(dir));

  if (!existsSync(resolve(dir, ".git"))) git(["init", "--quiet", dir]);

  return { dir, changes };
}
