// The text packages add to every session (a definition's `session`), which `office instructions
// --packages` prints in a reader bound to the published package set. Both agent runtimes ask for it
// as a session starts: the office package's OpenCode plugin, and its Claude Code plugin's
// SessionStart hook. The packages are the published set's selection, each function getting the
// settings the last sync applied: a package office.yaml selects but no sync has applied adds
// nothing (and blocks no other's text), and a deselected one's text is gone after the sync that
// withdraws it. What a package says of files is read as the session starts.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";

import { readAppliedSnapshot } from "../../sdk/applied-settings.ts";
import { installedPackages } from "../layout.ts";
import { officeInfo } from "../lifecycle-inputs.ts";
import type { Office } from "../office.ts";
import { managedDirectory } from "./package-generation.ts";
import { importEdges, readPackageJson } from "./package-manifest.ts";
import { type PackageProblem, problemLine, type ResolvedPackage, resolvePackages } from "./packages.ts";
import { packageEntries } from "../schema.ts";

/**
 * The packages `blocked` names and every package that imports one of them, directly or through
 * another, by the import edges each readable package.json declares (an unreadable one is blocked
 * itself): what a reader must leave unloaded for the rest to load without them.
 */
function withImporters(blocked: readonly PackageProblem[], packages: readonly ResolvedPackage[]): Set<string> {
  const left = new Set(blocked.flatMap(problem => problem.packages));
  const selected = new Set(packages.map(pkg => pkg.entry.name));
  const edges = new Map<string, string[]>();

  for (const pkg of packages) {
    const json = existsSync(pkg.dir) ? readPackageJson(pkg.dir, pkg.entry.name, pkg.kind) : undefined;

    if (json?.ok) edges.set(pkg.entry.name, importEdges(json.value, selected));
    else left.add(pkg.entry.name);
  }

  for (let grew = true; grew;) {
    grew = false;

    for (const [name, imports] of edges) {
      if (!left.has(name) && imports.some(other => left.has(other))) {
        left.add(name);
        grew = true;
      }
    }
  }

  return left;
}

/**
 * Each package's session text, in load order, separated by blank lines. A package that doesn't
 * load or whose `session` fails adds nothing and is named on standard error, so one broken package
 * doesn't take the others' text from a session: one the definition gate refuses (a missing or
 * rejected copy, say) is left unloaded with the packages that import it, as sync's admission
 * leaves a package it couldn't fetch, and the rest load past the same gate.
 */
export async function packageSessionText(office: Office, generation: string): Promise<string> {
  const selection = v.parse(packageEntries, JSON.parse(readFileSync(join(managedDirectory(office.dir, generation), "selection.json"), "utf8")));
  const view = { ...office, packages: selection };
  let installed = installedPackages(view);

  if (installed.blocked?.length) {
    const left = withImporters(installed.blocked, resolvePackages(view).packages);

    const named = new Set(installed.blocked.flatMap(problem => problem.packages));

    for (const problem of installed.blocked) console.error(`office: no session text from ${problemLine(problem)}`);
    for (const name of left) if (!named.has(name)) console.error(`office: no session text from package ${name}: it imports a package that doesn't load`);
    installed = installedPackages(view, left);

    if (installed.blocked?.length) {
      console.error(`office: no package's session text: ${installed.blocked.map(problemLine).join("; ")}`);

      return "";
    }
  }

  for (const problem of installed.problems) console.error(`office: no session text from ${problemLine(problem)}`);
  const withText = installed.installed.filter(item => item.manifest.session);

  if (withText.length === 0) return "";
  let applied;

  try {
    applied = readAppliedSnapshot(office.dir);
  } catch (error) {
    console.error(`office: no package's session text: ${error instanceof Error ? error.message : String(error)}`);

    return "";
  }

  const texts: string[] = [];

  for (const { entry: { name }, manifest } of withText) {
    const settings = applied.get(name);

    if (settings === undefined || !manifest.session) continue;

    try {
      const text = v.parse(v.string(), await manifest.session({ office: officeInfo(office), settings }));

      if (text.trim()) texts.push(text.trim());
    } catch (error) {
      console.error(`office: package ${name}: its session text failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return texts.join("\n\n");
}
