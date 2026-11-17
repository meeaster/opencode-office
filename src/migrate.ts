// Moves an office from the layout earlier releases of `office` wrote to the one where every
// package, the tool's own `office` package included, reaches OpenCode through its plugin. `office
// sync` runs each step and lists what it changed; `office check` reports what is left. Each step
// changes nothing once done, so a second sync finds nothing to do.
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import * as v from "valibot";

import { editConfig, type Office, withoutItem, withoutKeys } from "./office.ts";
import { isToolRepository, localDir, localFolders, pulledDir, readRecord, sourceFile } from "./packages.ts";
import { check } from "./schema.ts";
import { builtinPackages } from "./tool.ts";

const oldPlugin = ".opencode/plugins/office";

/** A step that may edit office.yaml: the office as it now reads, and one line per change. */
export type Migrated = { office: Office; changes: string[] };

/**
 * Whether `.opencode/plugins/office` is a real folder: the copy of the tool's plugin earlier
 * releases wrote. office.yaml can't clone a plugin under that name, so nothing else puts one there.
 */
export function hasOldOfficePlugin(office: Office): boolean {
  try {
    return lstatSync(join(office.dir, oldPlugin)).isDirectory();
  } catch {
    return false;
  }
}

/** Removes that copy, so the office package's plugin can be linked in its place. */
function removeOldOfficePlugin(office: Office): string[] {
  if (!hasOldOfficePlugin(office)) return [];

  rmSync(join(office.dir, oldPlugin), { recursive: true });

  return [`removed ${oldPlugin}/, the copy of the tool's plugin earlier releases of office wrote; the office package's plugin replaces it`];
}

/**
 * The SHA-256 of every `skills/office/SKILL.md` the template of earlier releases wrote. Those
 * releases are fixed, so a copy matching one of them is the tool's, never the office's work.
 */
const shippedOfficeSkills = new Set([
  "e4f943c6fd5b7b34046dd66ed1f8142dcb0d833923b2f6b8cec8cdfd1199f743",
  "c07404d162315a07ec03d44be1ba9477c58616613afc35d9bf42bc2401ce1560",
  "bb4b82bb452dd838ffbaf85edf4e1e314224984ea46f0c4902929ceaa186cf3d",
  "108bcce5333bd89b892e016a000948f1ec5a23aa62a811654be475c8edafc233",
  "345a6c0a9a79fbc843d09e912a4cb55326f955625606651dc9aea3979809d51e",
  "e89d1df6166dcd3294bcd3c3778cdaef597afa040a79a7ba5ef1280cc8da7f2b",
  "f411591b74fae8a6ed6551aa51974f67d8c8c1073af5e6bc10c6b897d3c107a4",
  "f715bad2d5315e43e332083c401b9d374e74e9fa8ad52467f3589a692fd76aa8",
  "e187b467dd392ec7da1fc41f8e6e30817cbcefa80df6bd2d48c15cac46f696dc",
  "02192b01f08c8405a9285248b6c6265f2f950b3fcddce0bc76fe3aff5f510a3b",
  "cf5c95a15602a1d4afaf88b71858111633b22fb8746492740a268dac921c926a",
]);

/**
 * The library's `skills/office/`: absent, a copy an earlier release's template wrote (only its
 * SKILL.md, matching one of them), or the office's own work.
 */
export function officeSkillState(office: Office): "absent" | "shipped" | "edited" {
  const dir = join(office.dir, "skills/office");

  if (!existsSync(dir)) return "absent";

  if (readdirSync(dir).join() !== "SKILL.md") return "edited";

  return shippedOfficeSkills.has(new Bun.CryptoHasher("sha256").update(readFileSync(join(dir, "SKILL.md"))).digest("hex")) ? "shipped" : "edited";
}

/** What `office check` and `office sync` say about an edited `skills/office/`. */
export const editedOfficeSkill =
  "skills/office/ differs from every copy of the office skill earlier releases wrote, so office sync keeps it; the office package now gives every session that skill, so delete yours, or rename it to keep it beside the package's";

/**
 * Removes the library's copy of the office skill, which the office package now provides, and its
 * `skills.enabled` entry. An edited copy stays, and so does its entry.
 */
function removeOfficeSkill(office: Office): Migrated {
  const state = officeSkillState(office);

  if (state === "edited") return { office, changes: [editedOfficeSkill] };

  const changes: string[] = [];

  if (state === "shipped") {
    rmSync(join(office.dir, "skills/office"), { recursive: true });
    changes.push("removed skills/office/, the copy of the office skill earlier releases wrote; the office package provides it now");
  }

  if (!office.skills.enabled.includes("office")) return { office, changes };

  const updated = editConfig(office, (text) => withoutItem(text, ["skills", "enabled"], "office"));

  return { office: updated, changes: [...changes, "removed office from skills.enabled in office.yaml"] };
}

/** Entries that take a built-in package from the tool's own repository, as offices did before built-ins. */
export function toolRepositoryEntries(office: Office): string[] {
  const builtins = builtinPackages();

  return office.packages.flatMap((entry) => (entry.source !== undefined && builtins.includes(entry.name) && isToolRepository(entry.source.repo) ? [entry.name] : []));
}

/** Makes each of those a built-in entry by dropping `repo`, `path` and `ref`, keeping its settings and comments. */
function builtinEntries(office: Office): Migrated {
  const names = toolRepositoryEntries(office);

  if (names.length === 0) return { office, changes: [] };

  const updated = editConfig(office, (text) =>
    names.reduce((result, name) => withoutKeys(result, ["packages", office.packages.findIndex((entry) => entry.name === name)], ["repo", "path", "ref"]), text),
  );

  return { office: updated, changes: names.map((name) => `made ${name} a built-in package in office.yaml: dropped its repo, path and ref, so it follows this office executable`) };
}

/**
 * Folders in `packages/` that were pulled in from a repository: they have a `.source.json`, and
 * office.yaml doesn't list them as the office's own (an entry without `repo` naming no built-in).
 */
export function pulledLocalFolders(office: Office): string[] {
  const builtins = builtinPackages();

  return localFolders(office).filter((name) => {
    const entry = office.packages.find((candidate) => candidate.name === name);
    const own = entry !== undefined && entry.source === undefined && !builtins.includes(name);

    return !own && existsSync(join(localDir(office, name), sourceFile));
  });
}

/** Moves each of those to `.office/packages/`, where sync updates, restores or removes it. */
function movePulledPackages(office: Office): string[] {
  return pulledLocalFolders(office).map((name) => {
    const from = localDir(office, name);
    const to = pulledDir(office, name);

    if (existsSync(to)) return `FAILED ${relative(office.dir, from)}/ wasn't moved, because ${relative(office.dir, to)}/ exists too; delete the one office.yaml doesn't describe`;

    mkdirSync(join(office.dir, ".office/packages"), { recursive: true });
    renameSync(from, to);

    const record = readRecord(to);

    return `moved ${relative(office.dir, from)}/ to ${relative(office.dir, to)}/, where packages pulled into the office live${record !== undefined && "repo" in record ? ` (copied from ${record.repo})` : ""}`;
  });
}

// The office-executor MCP server as every earlier template wrote it into .opencode/opencode.jsonc;
// the office package's plugin registers it now.
const executorEntry = {
  type: "remote",
  url: "{env:OFFICE_EXECUTOR_URL}{file:office-executor.url}/mcp?elicitation_mode=browser",
  oauth: false,
  headers: { Authorization: "Bearer {env:OFFICE_EXECUTOR_TOKEN}{file:office-executor.token}" },
};

const opencodeConfig = ".opencode/opencode.jsonc";

// Only the fields the migration reads; OpenCode checks the rest.
const configSchema = v.looseObject({ mcp: v.optional(v.looseObject({ servers: v.optional(v.record(v.string(), v.unknown())) })) });

type ExecutorEntry = { state: "absent" | "template" | "differs" } | { state: "unreadable"; error: string };

function parseJsonc(text: string): { ok: true; value: v.InferOutput<typeof configSchema> } | { ok: false; error: string } {
  let document;

  try {
    document = Bun.JSONC.parse(text);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const read = check(v.safeParse(configSchema, document));

  return read.ok ? read : { ok: false, error: read.errors.join("; ") };
}

/** Whether the root's opencode.jsonc still declares office-executor, and whether as the template wrote it. */
export function executorEntryState(office: Office): ExecutorEntry {
  const path = join(office.dir, opencodeConfig);

  if (!existsSync(path)) return { state: "absent" };

  const read = parseJsonc(readFileSync(path, "utf8"));

  if (!read.ok) return { state: "unreadable", error: read.error };

  const entry = read.value.mcp?.servers?.["office-executor"];

  return { state: entry === undefined ? "absent" : Bun.deepEquals(entry, executorEntry) ? "template" : "differs" };
}

/**
 * Where the value starting at `open` (a `{`) ends, just past its `}`, skipping strings and
 * comments; undefined when it never closes.
 */
function objectEnd(text: string, open: number): number | undefined {
  let depth = 0;

  for (let at = open; at < text.length; at++) {
    const char = text[at];

    if (char === '"') {
      for (at++; at < text.length && text[at] !== '"'; at++) if (text[at] === "\\") at++;
    } else if (text.startsWith("//", at)) {
      at = text.indexOf("\n", at);

      if (at === -1) return undefined;
    } else if (text.startsWith("/*", at)) {
      at = text.indexOf("*/", at) + 1;

      if (at === 0) return undefined;
    } else if (char === "{") {
      depth++;
    } else if (char === "}" && --depth === 0) {
      return at + 1;
    }
  }

  return undefined;
}

/**
 * opencode.jsonc's text without the office-executor member: its lines, a trailing comma, and the
 * comment above it that the template wrote (it starts "The office's Executor"). Every other
 * character stays. Undefined when the member can't be found as one key, or the result wouldn't be
 * the same configuration without it.
 */
export function withoutExecutorEntry(text: string): string | undefined {
  const keys = [...text.matchAll(/"office-executor"\s*:\s*\{/g)];

  if (keys.length !== 1) return undefined;

  const [key] = keys;
  const close = objectEnd(text, key.index + key[0].length - 1);

  if (close === undefined) return undefined;

  const comma = /^[ \t]*,/.exec(text.slice(close));
  let end = close + (comma?.[0].length ?? 0);
  let start = key.index;
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;

  if (text.slice(lineStart, start).trim() === "") {
    start = lineStart;

    const rest = /^[ \t]*(\r?\n|$)/.exec(text.slice(end));

    if (rest !== null) end += rest[0].length;

    // The comment lines right above the member, removed only when they are the template's.
    let top = start;

    while (top > 0) {
      const previous = text.lastIndexOf("\n", top - 2) + 1;

      if (!text.slice(previous, top).trim().startsWith("//")) break;

      top = previous;
    }

    if (text.slice(top, start).trim().startsWith("// The office's Executor")) start = top;
  }

  const result = `${text.slice(0, start)}${text.slice(end)}`;
  const before = parseJsonc(text);
  const after = parseJsonc(result);

  if (!before.ok || !after.ok) return undefined;

  const expected = structuredClone(before.value);

  delete expected.mcp?.servers?.["office-executor"];

  return Bun.deepEquals(after.value, expected) ? result : undefined;
}

/** Removes office-executor from the root's opencode.jsonc when it is the template's entry. */
function removeExecutorEntry(office: Office): string[] {
  const entry = executorEntryState(office);

  if (entry.state === "absent") return [];

  if (entry.state === "unreadable") return [`FAILED ${opencodeConfig}: can't read it to remove the office-executor MCP server: ${entry.error}`];

  if (entry.state === "differs") return [`kept office-executor in ${opencodeConfig}, which differs from the entry office init wrote; the office package registers that server now, so remove the entry yourself`];

  const path = join(office.dir, opencodeConfig);
  const text = withoutExecutorEntry(readFileSync(path, "utf8"));

  if (text === undefined) return [`FAILED ${opencodeConfig}: couldn't remove the office-executor entry without changing anything else; remove it yourself, as the office package registers that server now`];

  writeFileSync(path, text);

  return [`removed the office-executor MCP server from ${opencodeConfig}; the office package registers it now`];
}

/** Runs every step, returning the office as office.yaml now describes it and one line per change. */
export function migrate(office: Office): Migrated {
  const changes: string[] = [];
  let current = office;

  for (const step of [builtinEntries, removeOfficeSkill]) {
    try {
      const result = step(current);

      current = result.office;
      changes.push(...result.changes);
    } catch (error) {
      changes.push(`FAILED ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  changes.push(...removeExecutorEntry(current), ...removeOldOfficePlugin(current), ...movePulledPackages(current));

  return { office: current, changes };
}
