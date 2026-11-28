// Starting pins and the whole-file editor for office.lock.
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

import * as v from "valibot";
import { parse, stringify } from "yaml";

import { openCheckoutLease, publicationLease } from "./checkout-lease.ts";
import { atomicWrite } from "./lib/atomic-write.ts";
import { type Lock, type LockedPackage, lockSchema, type PackageLock, parsePackageLock, parseToolLock, type ToolLock } from "./lock-schema.ts";
import { OfficeError } from "./office.ts";
import { check } from "./parse.ts";
import { type PinnedTool, pinnedTools } from "./schema.ts";

export type Pin = Lock[PinnedTool];

/** What a new office starts at, and what a runtime office.yaml gives no version runs. */
export const defaultPins: Lock = {
  opencode: { version: "2.3.0", digest: "sha256:fc0f81522aceeabac47693d88389efa2bc517ce74c2c38fd6967819fcc6e4d3b" },
  claude: { version: "2.1.322", digest: "sha256:3d2bc5ae54d4d4cd63510e9fcca5b6d48d2b18806708df8c8f691aa486c5dca8" },
  codex: { version: "0.170.0", digest: "sha256:a77ff87be7ba809d715728270a78f5ce3527dc07529416d1ef8929b90b8475eb" },
  executor: { version: "2.0.0-beta.49", digest: "sha256:cc693691db13635ad5abb456fa132634816ec7acc73f04bd6b8932e0a8c45038" },
  mise: { version: "2026.11.7", digest: "sha256:8f5426d9971eaf713b37509749174ca69cf2f08b8b25e389168dcfcab9cd1a4d" },
  sfw: {
    version: "1.16.0",
    digest: "sha256:1f24d2628aeb3995f1f2651509e37641c7c41d07749ac68594ecb5bb2dd44d8a",
    platforms: {
      "linux-x64": "sha256:1f24d2628aeb3995f1f2651509e37641c7c41d07749ac68594ecb5bb2dd44d8a",
      "linux-arm64": "sha256:474cdb684e42d33d4b697dedd7d90c159d71380be0e53c496f0e7097c3617a6c",
      "darwin-x64": "sha256:b574931bc2b3c36a9bf07ac07b9c07894f8cd314efc91bc5e4fe1c371b56adca",
      "darwin-arm64": "sha256:29df049df2ef705a8ce726c6c41fe73a6034f6b1cd0d87f3f15a780d074b6d83",
    },
  },
};

/** Compares two versions by semver precedence: numbers numerically, a pre-release before its release. */
export function compareVersions(left: string, right: string): number {
  const [leftCore = "", leftPre] = splitPrerelease(left);
  const [rightCore = "", rightPre] = splitPrerelease(right);
  const core = compareParts(leftCore.split("."), rightCore.split("."));

  if (core !== 0) return core;

  if (leftPre === undefined || rightPre === undefined) return leftPre === rightPre ? 0 : leftPre === undefined ? 1 : -1;

  return compareParts(leftPre.split("."), rightPre.split("."));
}

function splitPrerelease(value: string): [string, string | undefined] {
  const dash = value.indexOf("-");

  return dash === -1 ? [value, undefined] : [value.slice(0, dash), value.slice(dash + 1)];
}

function compareParts(left: string[], right: string[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const [a, b] = [left[index], right[index]];

    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;

    const order = /^\d+$/.test(a) && /^\d+$/.test(b) ? Number(a) - Number(b) : a.localeCompare(b);

    if (order !== 0) return Math.sign(order);
  }

  return 0;
}

export const lockFile = "office.lock";

function invalidLock(fix: string, errors: string[]): OfficeError {
  return new OfficeError(`${lockFile} is not valid (${fix}):\n${errors.map((line) => `  ${line}`).join("\n")}`);
}

/** office.lock's sections: runtime pins (undefined: none), Git packages and mise-managed tools' desired releases. */
export type Sections = { runtime: Lock | undefined; packages: PackageLock; tools: ToolLock };

/**
 * Each section of office.lock as read, or why it can't be: each section is read on its own.
 * `unknown` is a top-level key that is neither a runtime pin nor a section: with one, every section
 * fails with it and nothing may rewrite the file.
 */
type SectionReads = { [Key in keyof Sections]: { ok: true; value: Sections[Key] } | { ok: false; error: OfficeError } };

export type ReadSections = SectionReads & { unknown?: OfficeError };

const knownKeys = new Set<string>([...pinnedTools, "packages", "tools"]);

/** The remedy each section's error names. */
const fixes: Record<keyof Sections, string> = {
  runtime: "run office pin to rewrite it",
  packages: "restore it from Git, or remove its packages: section for office sync to rewrite",
  tools: "restore it from Git, or remove its tools: section and run office bump",
};

/** office.lock's text, or null when the office has none. */
export function readLockText(dir: string): string | null {
  const path = join(dir, lockFile);

  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** office.lock's text (null: no office.lock) read into its sections, parsing the YAML once. */
export function lockSections(text: string | null): ReadSections {
  const document: unknown = text === null ? {} : parse(text) ?? {};
  const fail = (key: keyof Sections, errors: string[]) => ({ ok: false as const, error: invalidLock(fixes[key], errors) });

  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return { runtime: fail("runtime", ["the file: must be a mapping"]), packages: fail("packages", ["the file: must be a mapping"]), tools: fail("tools", ["the file: must be a mapping"]) };
  }

  // SAFETY: checked above to be a mapping; each section is validated below.
  const { packages, tools, ...pins } = document as Record<string, unknown>;
  const unknownKeys = Object.keys(document).filter(key => !knownKeys.has(key));

  if (unknownKeys.length) {
    const unknown = new OfficeError(`${lockFile} has a top-level key office doesn't know: ${unknownKeys.join(", ")}. Nothing was read from it or written; remove the key (an earlier release's adoption step may move it), then run the command again`);
    const refused = { ok: false as const, error: unknown };

    return { runtime: refused, packages: refused, tools: refused, unknown };
  }

  const runtime = Object.keys(pins).length === 0 ? { ok: true as const, value: undefined } : check(v.safeParse(lockSchema, pins));

  const locked = packages === undefined ? { ok: true as const, value: new Map() } : parsePackageLock(packages);
  const desired = tools === undefined ? { ok: true as const, value: new Map() } : parseToolLock(tools);

  return {
    runtime: runtime.ok ? runtime : fail("runtime", runtime.errors),
    packages: locked.ok ? locked : fail("packages", locked.errors),
    tools: desired.ok ? desired : fail("tools", desired.errors),
  };
}

/** Throws when the office's office.lock has a top-level key office doesn't know; a missing or otherwise unreadable lock passes. */
export function requireKnownLockKeys(dir: string): void {
  const { unknown } = lockSections(readLockText(dir));

  if (unknown) throw unknown;
}

/** One section of office.lock in the office at `dir`; throws, naming its remedy, when it can't be read. */
export function readLockSection<Key extends keyof Sections>(dir: string, key: Key): Sections[Key] {
  const read: SectionReads[Key] = lockSections(readLockText(dir))[key];

  if (!read.ok) throw read.error;

  return read.value;
}

const runtimeHeader = [
  "# Written by `office pin` from office.yaml's versions; don't edit. For each tool, the SHA-256 of",
  "# the release file the image downloads (Executor: the image's digest), and for sfw, which a",
  "# host-mode office also installs on its machine, that of each platform's release file.",
];

const packagesHeader = [
  "# Written by `office sync` and `office packages update`; don't edit. For each package from a Git",
  "# repository, the commit its ref resolved to, which sync installs on every machine while the",
  "# package's repo, path and ref in office.yaml match.",
];

const toolsHeader = [
  "# Written by `office bump`; don't edit. The exact release selected for each mise tool the",
  "# packages require, by its backend; mise verifies its artifact when office up installs it. A",
  "# selection installs nothing; machine.toml's exact pins are held.",
];

function byKey<T>(entries: Iterable<[string, T]>): [string, T][] {
  return [...entries].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

function sortedPackages(packages: PackageLock): [string, LockedPackage][] {
  return byKey(packages).map(([name, { repo, path, ref, commit }]) => [name, { repo, path, ref, commit }]);
}

/** A canonical form of a `packages:` section, equal for equal sections however they were written. */
export function packageSectionKey(packages: PackageLock): string {
  return JSON.stringify(sortedPackages(packages));
}

/** office.lock's text for its sections, or null when all are empty. Entries are sorted by key. */
function renderLock({ runtime: pins, packages, tools }: Sections): string | null {
  const runtime = pins === undefined ? [] : [
    ...runtimeHeader,
    ...pinnedTools.flatMap((tool) => {
      const pin = pins[tool];

      if (pin === undefined) return [];
      const { version: pinned, digest, platforms } = pin;

      return [`${tool}:`, `  version: ${pinned}`, `  digest: ${digest}`, ...(platforms === undefined ? [] : ["  platforms:", ...Object.entries(platforms).map(([platform, value]) => `    ${platform}: ${value}`)])];
    }),
  ];

  // Object.fromEntries defines own keys, so every package name survives.
  const section = packages.size === 0 ? [] : [...packagesHeader, stringify({ packages: Object.fromEntries(sortedPackages(packages)) }, { lineWidth: 0 }).trimEnd()];
  const desired = tools.size === 0 ? [] : [...toolsHeader, stringify({ tools: Object.fromEntries(byKey(tools)) }, { lineWidth: 0 }).trimEnd()];
  const parts = [runtime, section, desired].filter((part) => part.length > 0);

  if (parts.length === 0) return null;

  return [...parts.flatMap((part, index) => (index === 0 ? part : ["", ...part])), ""].join("\n");
}

/** Why a package publication or office.lock writer can't take the publication lease. */
export const publicationBusy = "another office command is changing packages or office.lock; retry when it finishes";

/**
 * Edits office.lock: reads its sections, lets `edit` change them in place, and replaces the file
 * whole when they changed (removing it when all are empty), keeping each unedited section's
 * entries. Every section must be readable, so it throws, naming the remedy, before calling `edit`;
 * `replacing` names a section `edit` sets whole, which may be unreadable. The edit runs under the
 * lease package publication holds, so a runtime pin writer and a publication never
 * put back each other's stale section; `leased` says the caller holds it already (it is exclusive
 * and not reentrant).
 */
export function editLock<T>(dir: string, edit: (sections: Sections) => T, { leased = false, replacing }: { leased?: boolean; replacing?: keyof Sections } = {}): T {
  using lease = leased ? undefined : openCheckoutLease(dir, publicationLease);
  lease?.acquire(publicationBusy);

  const read = lockSections(readLockText(dir));

  // A key office doesn't know would be lost by any rewrite, so no edit replaces the file around it.
  if (read.unknown) throw read.unknown;

  // An unreadable section is refused, or starts empty when `edit` replaces it.
  const unreadable = <Value>(key: keyof Sections, empty: Value): Value => {
    const section = read[key];

    if (key !== replacing && !section.ok) throw section.error;

    return empty;
  };

  const sections: Sections = {
    runtime: read.runtime.ok ? read.runtime.value : unreadable("runtime", undefined),
    packages: read.packages.ok ? read.packages.value : unreadable("packages", new Map()),
    tools: read.tools.ok ? read.tools.value : unreadable("tools", new Map()),
  };

  const before = renderLock(sections);
  const result = edit(sections);
  const after = renderLock(sections);

  if (after !== before || (replacing !== undefined && !read[replacing].ok)) {
    if (after === null) rmSync(join(dir, lockFile), { force: true });
    else atomicWrite(join(dir, lockFile), after, (statSync(join(dir, lockFile), { throwIfNoEntry: false })?.mode ?? 0o644) & 0o777);
  }

  return result;
}

/** One line per package whose office.lock entry a publication adds, moves or removes. */
export function packageLockChanges(before: PackageLock, after: PackageLock): string[] {
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();

  return names.flatMap((name) => {
    const [from, to] = [before.get(name), after.get(name)];

    if (to === undefined) return [`${lockFile}: removed ${name}`];

    if (from !== undefined && packageSectionKey(new Map([[name, from]])) === packageSectionKey(new Map([[name, to]]))) return [];

    return [`${lockFile}: locked ${name} at ${to.commit.slice(0, 12)}`];
  });
}

/** office.lock's runtime pins, or undefined when the office has none. */
export function readLock(dir: string): Lock | undefined {
  return readLockSection(dir, "runtime");
}

/** Writes office.lock's runtime pins, keeping its other sections; refuses, with that section's message, when one can't be read. */
export function writeLock(dir: string, lock: Lock): void {
  editLock(dir, (sections) => {
    sections.runtime = lock;
  }, { replacing: "runtime" });
}
