import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { excludeCopy, planCopy } from "@office/sdk/copy-tree";
import { linkFolder } from "./catalog.ts";
import { stateFolder } from "./git.ts";
import { skillId } from "./settings.ts";

export const receiptFile = `${stateFolder}/links.json`;

export type Receipt = { links: Map<string, string>; copies: Set<string> };

const skillPath = (path: string) => path.startsWith(`${linkFolder}/`) && skillId.test(path.slice(linkFolder.length + 1));

function receiptPath(office: string) {
  for (const parent of [".office", stateFolder]) {
    const info = lstatSync(join(office, parent), { throwIfNoEntry: false });

    if (info && !info.isDirectory()) throw new Error(`cannot use ${receiptFile}: ${parent} isn't a real folder`);
  }

  return join(office, receiptFile);
}

export function readReceipt(office: string): Receipt {
  const path = receiptPath(office);
  const info = lstatSync(path, { throwIfNoEntry: false });
  const aside = "move it aside, and the deliveries it recorded count as the owner's";
  const links = new Map<string, string>();
  const copies = new Set<string>();

  if (info === undefined) return { links, copies };

  if (!info.isFile()) throw new Error(`${receiptFile} isn't a file; ${aside}`);
  let text: string;

  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`${receiptFile} can't be read (${error instanceof Error ? error.message : String(error)}); ${aside}`, { cause: error });
  }

  const invalid = new Error(`${receiptFile} isn't a record of skill links and copies in ${linkFolder}/; ${aside}`);
  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid;
  }

  if (typeof parsed !== "object" || parsed === null || !("links" in parsed) || typeof parsed.links !== "object" || parsed.links === null || Array.isArray(parsed.links)) throw invalid;

  for (const [link, target] of Object.entries(parsed.links)) {
    if (typeof target !== "string" || !skillPath(link)) throw invalid;
    links.set(link, target);
  }

  if ("copies" in parsed) {
    if (!Array.isArray(parsed.copies)) throw invalid;

    for (const copy of parsed.copies) {
      if (typeof copy !== "string" || !skillPath(copy) || links.has(copy)) throw invalid;
      copies.add(copy);
    }
  }

  return { links, copies };
}

/** The recorded links that are no longer what the package placed: gone, or changed since, so the owner's. */
export function lostLinks(office: string, receipt: Receipt): string[] {
  return [...receipt.links].flatMap(([path, target]) => linkAt(office, path) === target ? [] : [path]);
}

export function ownedPaths(receipt: Receipt): string[] {
  return [...receipt.links.keys(), ...receipt.copies];
}

function writeReceipt(office: string, receipt: Receipt) {
  const path = receiptPath(office);
  const temporary = `${path}.${randomUUID()}`;
  const links = Object.fromEntries([...receipt.links].sort(([a], [b]) => a.localeCompare(b)));
  const copies = [...receipt.copies].sort();

  mkdirSync(dirname(path), { recursive: true });

  try {
    writeFileSync(temporary, `${JSON.stringify(copies.length ? { links, copies } : { links }, null, 2)}\n`, { flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** A link's target text, or undefined when nothing is there; `false` for an entry that isn't a link. */
function linkAt(office: string, path: string): string | false | undefined {
  const info = lstatSync(join(office, path), { throwIfNoEntry: false });

  if (info === undefined) return undefined;

  return info.isSymbolicLink() ? readlinkSync(join(office, path)) : false;
}

export type Delivery =
  | { kind: "link"; target: string; label: string }
  | { kind: "copy"; source: string; label: string };

type Change =
  | { kind: "link"; path: string; target: string; label: string }
  | { kind: "relink"; path: string; from: string; target: string; label: string }
  | { kind: "unlink"; path: string; from: string }
  | { kind: "copy"; path: string; from?: string; plan: ReturnType<typeof planCopy>; label: string }
  | { kind: "remove copy"; path: string }
  | { kind: "release"; path: string; why: string };

export function planDelivery(office: string, wanted: ReadonlyMap<string, Delivery>, receipt: Receipt) {
  const changes: Change[] = [];
  const problems: string[] = [];

  for (const folder of [dirname(linkFolder), linkFolder]) {
    const info = lstatSync(join(office, folder), { throwIfNoEntry: false });

    if (info !== undefined && !info.isDirectory()) problems.push(`${folder} isn't a folder of the office (it is a link or a file), so no skill is delivered through it`);
  }

  if (problems.length) return { changes, problems };

  for (const [path, delivery] of wanted) {
    const current = linkAt(office, path);
    const recorded = receipt.links.get(path);
    const copied = receipt.copies.has(path);

    if (!copied && current !== undefined && (recorded === undefined || current !== recorded)) {
      problems.push(`${path} is already there and isn't a delivery this package recorded; move it aside or disable that skill`);
      continue;
    }

    const { label } = delivery;

    if (delivery.kind === "copy") {
      try {
        const plan = planCopy(delivery.source, join(office, path), () => new Set(["SKILL.md"]));

        if (plan.differences.length || !copied) changes.push({ kind: "copy", path, from: current === recorded ? recorded : undefined, plan, label });
      } catch (error) {
        problems.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
      }

      continue;
    }

    const { target } = delivery;

    if (copied) changes.push({ kind: "remove copy", path });

    if (copied || current === undefined) changes.push({ kind: "link", path, target, label });
    else if (recorded !== undefined && current === recorded && current !== target) changes.push({ kind: "relink", path, from: recorded, target, label });
  }

  for (const [path, recorded] of receipt.links) {
    if (wanted.has(path)) continue;
    const current = linkAt(office, path);

    if (current === undefined) changes.push({ kind: "release", path, why: "it is gone" });
    else if (current === recorded) changes.push({ kind: "unlink", path, from: recorded });
    else changes.push({ kind: "release", path, why: "it changed since this package linked it, so it is the owner's" });
  }

  for (const path of receipt.copies) {
    if (!wanted.has(path)) changes.push({ kind: "remove copy", path });
  }

  return { changes, problems };
}

/** Places a link through a staged one renamed into place, so a replaced link is never missing. */
function place(office: string, path: string, target: string) {
  const staged = join(office, stateFolder, `link-${randomUUID()}`);

  mkdirSync(dirname(staged), { recursive: true });
  mkdirSync(dirname(join(office, path)), { recursive: true });
  symlinkSync(target, staged);

  try {
    renameSync(staged, join(office, path));
  } finally {
    rmSync(staged, { force: true });
  }
}

export function applyDelivery(office: string, changes: readonly Change[], receipt: Receipt, exclude: (path: string) => readonly string[]): string[] {
  const held = { links: new Map(receipt.links), copies: new Set(receipt.copies) };
  const lines: string[] = [];

  for (const change of changes) {
    const { path } = change;

    // Checked again just before: an edit since the plan is the owner's.
    if (change.kind === "link") {
      if (linkAt(office, path) !== undefined) throw new Error(`${path} appeared during sync; left as it is`);
      place(office, path, change.target);
      held.links.set(path, change.target);
      lines.push(`linked ${path} (${change.label})`);
    } else if (change.kind === "relink") {
      if (linkAt(office, path) !== change.from) throw new Error(`${path} changed during sync; left as it is`);
      place(office, path, change.target);
      held.links.set(path, change.target);
      lines.push(`relinked ${path} (${change.label})`);
    } else if (change.kind === "unlink") {
      if (linkAt(office, path) !== change.from) throw new Error(`${path} changed during sync; left as it is`);
      unlinkSync(join(office, path));
      held.links.delete(path);
      lines.push(`unlinked ${path}`);
    } else if (change.kind === "copy") {
      const recorded = held.copies.has(path);

      if (!recorded && linkAt(office, path) !== change.from) throw new Error(`${path} changed during sync; left as it is`);
      lines.push(...excludeCopy(office, path, exclude));

      if (!recorded) {
        held.links.delete(path);
        held.copies.add(path);
        writeReceipt(office, held);
      }

      change.plan.write(office);
      lines.push(`copied skill ${path} (${change.label})`);
      continue;
    } else if (change.kind === "remove copy") {
      rmSync(join(office, path), { recursive: true, force: true });
      held.copies.delete(path);
      lines.push(`removed skill copy ${path}`);
    } else {
      held.links.delete(path);
      lines.push(`stopped managing ${path}: ${change.why}`);
    }

    writeReceipt(office, held);
  }

  return lines;
}

export function deliveryProblems(changes: readonly Change[]) {
  return changes.map(change => {
    const path = change.path;

    switch (change.kind) {
      case "link": return { level: "failed", message: `${path} isn't linked (office sync links it)` } as const;
      case "relink": return { level: "failed", message: `${path} links to ${change.from}, not ${change.target} (office sync relinks it)` } as const;
      case "copy": return { level: "failed", message: `${path} differs from its skill source (${change.plan.differences.map(file => join(path, file)).join(", ")}); office sync copies it` } as const;
      case "remove copy":
      case "unlink": return { level: "failed", message: `${path} should no longer be ${change.kind === "unlink" ? "linked" : "a copy"} (office sync reconciles it)` } as const;
      case "release": return { level: "warning", message: `${path}: ${change.why}; office sync stops managing it` } as const;
    }
  });
}
