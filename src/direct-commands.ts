// Package commands and their help: every run gathers each package office.yaml selects
// (src/gather.ts) and works from what the definitions declare and what their setups registered in
// this process. Runs only in a reader bound to the office's published package set.
import { commandNames } from "./command-table.ts";
import { gatherPackages, problemLines } from "./gather.ts";
import { loadOffice, OfficeError } from "./office.ts";

/** A reader process: the office it is bound to (`bindReader` recorded the set's rejected packages). */
export type Reader = { dir: string };

/** Help's lines for package commands: one per declared command, per problem and per naming problem. */
export async function commandHelp({ dir }: Reader): Promise<string[]> {
  const load = await gatherPackages(loadOffice(dir));

  return [
    ...load.commands.map(({ command }) => `  ${commandNames(command).join(" | ")}    ${command.summary}`),
    ...problemLines(load.problems).map(problem => `  ${problem}`),
    ...[...new Set(load.names.map(problem => problem.message))].map(message => `  ${message}`),
  ];
}

export type Dispatch =
  | { found: true }
  /** No loaded package provides the command; `failures` name the packages that failed to load. */
  | { found: false; failures: string[] };

/** Runs a package command: any package problem, or a naming problem of the requested command, fails it. */
export async function dispatchCommand({ dir }: Reader, words: string[]): Promise<Dispatch> {
  if (words.some(word => /\s/.test(word))) return { found: false, failures: [] };
  const requested = words.join(" ");
  const load = await gatherPackages(loadOffice(dir));

  // With the gate's problems, ownership conflicts too: no package loaded, so the command may be a typo.
  if (load.blocked) throw new OfficeError(`${requested}: unknown command, or a package command that can't run: no package loaded: ${problemLines(load.problems).join("; ")}`);
  const matches = load.commands.filter(({ command }) => commandNames(command).includes(requested));

  if (!matches.length) return { found: false, failures: problemLines(load.problems) };
  const claimed = new Set(matches.flatMap(({ command }) => commandNames(command)));
  const names = new Set(load.names.filter(problem => claimed.has(problem.name)).map(problem => problem.message));
  const problems = [...problemLines(load.problems), ...names];

  if (problems.length) throw new OfficeError(`${requested}: ${problems.join("; ")}`);
  const [{ command, settings = {} }] = matches;

  await command.run({ read: load.read, settings: structuredClone(settings) });

  return { found: true };
}
