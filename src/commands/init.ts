// `office init <dir>`: a new office from the template, with one example desk and the knowledge
// package, as a git repository on branch main. Its office.yaml starts at the tool's versions, which
// office.lock pins.
import { existsSync, readdirSync } from "node:fs";
import { basename, resolve } from "node:path";

import { git } from "../git.ts";
import { loadOffice, OfficeError } from "../office.ts";
import { copyToolPackage, toolPackageSource } from "../packages.ts";
import { buildCommit } from "../tool.ts";
import { defaultPins, writeLock } from "../versions.ts";
import { copyTemplate, sync } from "./sync.ts";

export async function init(target: string, name: string | undefined) {
  const dir = resolve(target);
  const officeName = name ?? basename(dir).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  const knowledge = toolPackageSource("knowledge");

  if (existsSync(dir) && readdirSync(dir).length > 0) throw new OfficeError(`${dir} is not empty`);

  copyTemplate("template/office", dir, {
    OFFICE: officeName,
    OPENCODE_VERSION: defaultPins.opencode.version,
    CLAUDE_VERSION: defaultPins.claude.version,
    EXECUTOR_VERSION: defaultPins.executor.version,
    MISE_VERSION: defaultPins.mise.version,
    KNOWLEDGE_REPO: knowledge.repo,
    KNOWLEDGE_REF: knowledge.ref,
  });
  writeLock(dir, defaultPins);

  // From this executable's own files, recorded as the tool's repository at its build commit, so
  // the sync below finds it installed and fetches nothing.
  copyToolPackage(dir, "knowledge");

  // Writes the tool's plugin, scaffolds the example desk, sets up the knowledge package and links
  // the enabled skills.
  const changes = await sync(loadOffice(dir));

  if (buildCommit().dirty) {
    changes.push(`note: this office executable was built with uncommitted changes, so packages/knowledge/ may differ from its files at ref ${knowledge.ref}; moving the ref replaces it`);
  }

  // main whatever git's default branch is on this machine.
  if (!existsSync(resolve(dir, ".git"))) git(["init", "--quiet", "--initial-branch=main", dir]);

  return { dir, changes };
}
