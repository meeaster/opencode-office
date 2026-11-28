import * as v from "valibot";

import type { Parsed } from "./parse.ts";
import { version } from "./schema.ts";

const digest = v.pipe(v.string(), v.regex(/^sha256:[0-9a-f]{64}$/, "must be sha256:<64 hex digits>"));

/** The machines a host-mode office installs a pinned tool on: Linux and macOS, x64 and arm64, by Node's names. */
const hostPlatforms = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"] as const;

export type HostPlatform = (typeof hostPlatforms)[number];

/**
 * One locked pin: a version and the SHA-256 of what the image downloads (Executor: its image
 * digest). A tool the office also installs on a host-mode office's machine (sfw) adds the SHA-256
 * of each platform's release file.
 */
const lockEntry = v.strictObject({
  version,
  digest,
  platforms: v.optional(v.strictObject({ "linux-x64": digest, "linux-arm64": digest, "darwin-x64": digest, "darwin-arm64": digest }, "must map linux-x64, linux-arm64, darwin-x64 and darwin-arm64 to digests")),
});

const lockEntries = { opencode: lockEntry, claude: lockEntry, codex: lockEntry, executor: lockEntry, mise: lockEntry, sfw: lockEntry };

export const lockSchema = v.strictObject(lockEntries);

export type Lock = v.InferOutput<typeof lockSchema>;

/** A Git package as office.lock locks it: the source office.yaml selected, and the full commit its ref resolved to. */
const packageLockEntry = v.strictObject({
  repo: v.string(),
  path: v.string(),
  ref: v.string(),
  commit: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/, "must be a full 40-character commit SHA")),
});

export type LockedPackage = v.InferOutput<typeof packageLockEntry>;

/** office.lock's `packages:` section, keyed by package name. */
export type PackageLock = Map<string, LockedPackage>;

/**
 * A section of office.lock keyed by name, validated entry by entry into a Map: valibot's `record`
 * drops keys such as `constructor`, which are valid package names and paths.
 */
function parseKeyed<T>(section: string, value: unknown, entry: v.GenericSchema<unknown, T>, keyProblem: (key: string) => string | undefined = () => undefined): Parsed<Map<string, T>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, errors: [`${section}: must be a mapping`] };
  const parsed = new Map<string, T>();
  const errors: string[] = [];

  for (const [key, item] of Object.entries(value)) {
    const result = v.safeParse(entry, item);
    const problem = keyProblem(key);

    if (problem !== undefined) errors.push(`${section}.${key}: ${problem}`);
    else if (result.success) parsed.set(key, result.output);
    else errors.push(...result.issues.map((issue) => `${[section, key, ...(issue.path ?? []).map((part) => String(part.key))].join(".")}: ${issue.message}`));
  }

  return errors.length === 0 ? { ok: true, value: parsed } : { ok: false, errors };
}

/** office.lock's `packages:` section from a parsed document. */
export function parsePackageLock(value: unknown): Parsed<PackageLock> {
  return parseKeyed("packages", value, packageLockEntry);
}

/**
 * A mise-managed tool's desired release as office.lock records it, keyed by its backend-qualified
 * name: the exact version selected. Its artifact is verified by mise itself when it installs.
 */
const toolLockEntry = v.strictObject({
  version: v.pipe(v.string(), v.regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/, "must be an exact version")),
});

export type LockedTool = v.InferOutput<typeof toolLockEntry>;

/** office.lock's `tools:` section, keyed by canonical backend-qualified tool. */
export type ToolLock = Map<string, LockedTool>;

/** office.lock's `tools:` section from a parsed document. */
export function parseToolLock(value: unknown): Parsed<ToolLock> {
  return parseKeyed("tools", value, toolLockEntry, key => /^[A-Za-z0-9_.-]+:[^\s]+$/.test(key) ? undefined : "must be a backend-qualified tool, such as core:bun");
}
