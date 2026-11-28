import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";

export const stagingFolder = ".office/tmp";

type Node = { kind: "folder" } | { kind: "file"; mode: number } | { kind: "other" };

function tree(root: string, source: boolean) {
  const nodes = new Map<string, Node>();

  function visit(path: string) {
    const absolute = join(root, path);
    const info = lstatSync(absolute, { throwIfNoEntry: false });

    if (info?.isDirectory()) {
      nodes.set(path, { kind: "folder" });

      for (const name of readdirSync(absolute).sort()) visit(join(path, name));
    } else if (info?.isFile() && path !== "") {
      nodes.set(path, { kind: "file", mode: info.mode & 0o7777 });
    } else if (source) {
      throw new Error(`cannot copy ${absolute}: ${info?.isSymbolicLink() ? "symbolic link" : path === "" ? "expected a real folder" : "expected a regular file"}`);
    } else if (info) {
      nodes.set(path, { kind: "other" });
    }
  }

  visit("");

  return nodes;
}

function directory(office: string, path: string, create = false) {
  let folder = office;

  for (const part of relative(office, path).split(sep)) {
    if (!part) continue;
    folder = join(folder, part);
    const info = lstatSync(folder, { throwIfNoEntry: false });

    if (info?.isDirectory()) continue;

    if (!info && create) mkdirSync(folder);
    else throw new Error(`cannot deliver copy through ${folder}: expected a real folder`);
  }
}

/** Checks the future directory's ignore rules before claiming it, even when replacing a link. */
export function excludeCopy(office: string, path: string, exclude: (path: string) => readonly string[]): readonly string[] {
  const target = join(office, path);
  const folder = `${path}/`;

  if (!lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) return exclude(folder);

  // Git cannot check a directory path through an existing link. Keep the link itself for rollback.
  const lines = [...exclude(path)];
  const staging = join(office, stagingFolder);

  directory(office, staging, true);
  directory(office, dirname(target));
  const previous = join(staging, `link-${randomUUID()}`);

  renameSync(target, previous);

  try {
    lines.push(...exclude(folder));
  } catch (error) {
    directory(office, dirname(target));

    if (lstatSync(target, { throwIfNoEntry: false })) throw new Error(`${path} appeared during sync; the previous link is at ${previous}`, { cause: error });
    renameSync(previous, target);
    throw error;
  }

  unlinkSync(previous);

  return lines;
}

export function copyExcludePath(office: string, path: string) {
  return lstatSync(join(office, path), { throwIfNoEntry: false })?.isSymbolicLink() ? path : `${path}/`;
}

/** Compares a source with an already-owned or vacant destination, without following links in either tree. */
export function planCopy(source: string, destination: string, last?: (source: string) => ReadonlySet<string>) {
  const incoming = tree(source, true);
  const existing = tree(destination, false);
  const delayed = last?.(source);
  const folders: string[] = [];
  const files: { path: string; mode: number }[] = [];
  const entrypoints = new Map<string, number>();
  const blockers = new Set<string>();
  const stale: string[] = [];
  const differences: string[] = [];

  for (const [path, node] of incoming) {
    const current = existing.get(path);

    if (node.kind === "folder") {
      if (current?.kind === "folder") continue;
      folders.push(path);
    } else if (node.kind === "file") {
      if (current?.kind === "file" && node.mode === current.mode && readFileSync(join(source, path)).equals(readFileSync(join(destination, path)))) continue;

      if (delayed?.has(path)) entrypoints.set(path, node.mode);
      else files.push({ path, mode: node.mode });
    }

    if (current && current.kind !== node.kind) blockers.add(path);
    differences.push(path);
  }

  // Children must go before their folders. A folder blocking an incoming file is removed
  // immediately before that file; everything else obsolete stays until the writes finish.
  for (const path of [...existing.keys()].reverse()) {
    if (incoming.has(path)) continue;
    let parent = dirname(path);

    while (parent !== "." && incoming.get(parent)?.kind !== "file") parent = dirname(parent);

    if (parent === ".") stale.push(path);
    differences.push(path);
  }

  for (const path of delayed ?? []) {
    const mode = entrypoints.get(path);

    if (mode !== undefined) files.push({ path, mode });
  }

  return {
    differences,
    write(office: string) {
      const staging = join(office, stagingFolder);

      if (files.length) directory(office, staging, true);
      directory(office, dirname(destination), true);

      for (const path of folders) {
        const target = join(destination, path);

        directory(office, dirname(target));

        if (blockers.has(path)) rmSync(target, { force: true });
        mkdirSync(target);
      }

      for (const { path, mode } of files) {
        const target = join(destination, path);
        const staged = join(staging, `copy-${randomUUID()}`);

        try {
          writeFileSync(staged, readFileSync(join(source, path)), { flag: "wx", mode: 0o600 });
          chmodSync(staged, mode);

          directory(office, dirname(target));

          if (existing.get(path)?.kind === "folder") rmSync(target, { recursive: true });
          renameSync(staged, target);
        } finally {
          rmSync(staged, { force: true });
        }
      }

      for (const path of stale) {
        const target = join(destination, path);

        directory(office, dirname(target));

        if (existing.get(path)?.kind === "folder") rmdirSync(target);
        else unlinkSync(target);
      }
    },
  };
}
