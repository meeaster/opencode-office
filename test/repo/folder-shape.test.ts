import { test } from "bun:test";
import { readdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { toolPath } from "../../src/tool.ts";

const breadthWarning = 40;
const breadthLimit = 60;
const breadthCeilings = new Map<string, number>();

const familyCeilings = new Map([
  ["src/loader/package", 12],
]);

function checkCeilings(
  violations: Map<string, number>,
  ceilings: ReadonlyMap<string, number>,
  describe: (path: string, count: number) => string,
): string[] {
  const problems: string[] = [];

  for (const [path, count] of violations) {
    const ceiling = ceilings.get(path);

    if (ceiling === undefined) problems.push(describe(path, count));
    else if (count > ceiling) problems.push(`${describe(path, count)} (exception ceiling: ${ceiling})`);
    else if (count < ceiling) problems.push(`${path}: lower the exception ceiling from ${ceiling} to ${count}`);
  }

  for (const path of ceilings.keys()) {
    if (!violations.has(path)) problems.push(`${path}: remove the stale exception`);
  }

  return problems;
}

test("source folders stay small and keep related files together", () => {
  const broadFolders = new Map<string, number>();
  const prefixFamilies = new Map<string, number>();

  function inspect(folder: string): void {
    const stems = new Set<string>();
    const subfolders = new Set<string>();

    for (const entry of readdirSync(toolPath(folder), { withFileTypes: true })) {
      const path = `${folder}/${entry.name}`;

      if (entry.isDirectory() && !/^src\/features\/[^/]+\/test$/.test(path)) subfolders.add(entry.name);

      if (entry.isFile() && entry.name.endsWith(".ts") && !/\.(test|fixture)\.ts$/.test(entry.name)) {
        stems.add(entry.name.slice(0, -3));
      }
    }

    if (stems.size > breadthWarning) console.warn(`${folder}: ${stems.size} production .ts files (warn above ${breadthWarning})`);

    if (stems.size > breadthLimit) broadFolders.set(folder, stems.size);

    const prefixes = new Map<string, number>();

    for (const name of stems) {
      for (let end = name.indexOf("-"); end > 0; end = name.indexOf("-", end + 1)) {
        const prefix = name.slice(0, end);

        prefixes.set(prefix, (prefixes.get(prefix) ?? 0) + 1);
      }
    }

    for (const [prefix, count] of prefixes) {
      const minimum = stems.has(prefix) || subfolders.has(prefix) ? 2 : 3;

      if (count >= minimum) prefixFamilies.set(`${folder}/${prefix}`, count);
    }

    for (const name of subfolders) inspect(`${folder}/${name}`);
  }

  inspect("src");

  const problems = [
    ...checkCeilings(broadFolders, breadthCeilings, (folder, count) => `${folder}: ${count} production .ts files (limit ${breadthLimit})`),
    ...checkCeilings(prefixFamilies, familyCeilings, (path, count) => {
      const prefix = basename(path);

      return `${dirname(path)}: ${count} ${prefix}-*.ts siblings; move into ${prefix}/`;
    }),
  ];

  if (problems.length > 0) throw new Error(problems.sort().join("\n"));
});
