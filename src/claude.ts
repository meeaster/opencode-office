import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { toolPath } from "./tool.ts";

const files = [
  { path: "bin/claude", mode: 0o755 },
  { path: "settings.json", mode: 0o644 },
];

/** The shell files are tool-owned; the root mise.toml that exposes them is not. */
export function claudeFiles(root: string, sync = false): string[] {
  const changes: string[] = [];

  for (const { path, mode } of files) {
    const name = `.office/claude/${path}`;
    const target = join(root, name);
    const current = lstatSync(target, { throwIfNoEntry: false });

    if (current !== undefined && !current.isFile()) {
      changes.push(`${sync ? "FAILED: " : ""}${name} is not a regular file; move it aside and run office sync`);
      continue;
    }

    const content = readFileSync(toolPath(`template/claude/${path}`), "utf8");
    const matches = current !== undefined && readFileSync(target, "utf8") === content;

    if (matches && (current.mode & 0o777) === mode) continue;

    if (sync) {
      if (!matches) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, content, { mode });
      }

      chmodSync(target, mode);
      changes.push(`wrote ${name}`);
    } else {
      changes.push(`${name} is missing or differs from this office executable's copy; run office sync`);
    }
  }

  return changes;
}
