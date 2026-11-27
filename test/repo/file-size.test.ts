import { test } from "bun:test";
import { readFileSync } from "node:fs";
import { toolPath } from "../../src/tool.ts";

const warning = 800;
const limit = 1500;
const ceilings = new Map<string, number>();

test("production source files stay small", () => {
  const problems: string[] = [];
  const remaining = new Set(ceilings.keys());
  const files = new Bun.Glob("src/**/*.ts");

  for (const path of files.scanSync({ cwd: toolPath("."), dot: true })) {
    if (/^src\/features\/[^/]+\/test\//.test(path) || /\.(test|fixture)\.ts$/.test(path)) continue;

    const text = readFileSync(toolPath(path), "utf8");
    const lines = text.split("\n").length - Number(text === "" || text.endsWith("\n"));
    const ceiling = ceilings.get(path);

    if (lines > warning) console.warn(`${path}: ${lines} lines (warn above ${warning})`);

    if (ceiling !== undefined) remaining.delete(path);

    if (lines > (ceiling ?? limit)) problems.push(`${path}: ${lines} lines (limit ${ceiling ?? limit})`);
    else if (ceiling !== undefined) {
      if (lines <= limit) problems.push(`${path}: remove the stale exception`);
      else if (lines < ceiling) problems.push(`${path}: lower the exception ceiling from ${ceiling} to ${lines}`);
    }
  }

  for (const path of remaining) problems.push(`${path}: remove the stale exception`);

  if (problems.length > 0) throw new Error(problems.sort().join("\n"));
});
