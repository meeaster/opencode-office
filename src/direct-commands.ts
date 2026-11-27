// Package commands and their help: every run gathers each package office.yaml selects
// (src/gather.ts) and works from what the definitions declare and what their setups registered in
// this process. Runs only in a reader bound to the office's published package set. What package
// code prints while gathering goes to standard error (src/command-stdout.ts).
import { commandNames } from "./command-table.ts";
import { divertStdout, writeResult } from "./command-stdout.ts";
import { type DeclaredCommand, gatherPackages, problemLines } from "./gather.ts";
import { executorAccess } from "./executor.ts";
import { officeInfo } from "./lifecycle-inputs.ts";
import { updateExcluded } from "./exclude-plumbing.ts";
import { loadOffice, OfficeError, replacePackageSetting } from "./office.ts";
import { schemaSettings } from "./packages.ts";
import { relative } from "node:path";
import * as v from "valibot";

/** A reader process: the office it is bound to (`bindReader` recorded the set's rejected packages). */
export type Reader = { dir: string };

/** Help's lines for package commands: one per declared command, per problem and per naming problem. */
export async function commandHelp({ dir }: Reader): Promise<string[]> {
  const office = loadOffice(dir);
  const restore = divertStdout();
  const load = await gatherPackages(office);
  restore();

  return [
    ...load.commands.map(({ command }) => `  ${commandNames(command).map(name => command.usage === undefined ? name : `${name} ${command.usage}`).join(" | ")}    ${command.summary}`),
    ...problemLines(load.problems).map(problem => `  ${problem}`),
    ...[...new Set(load.names.map(problem => problem.message))].map(message => `  ${message}`),
  ];
}

export type Dispatch =
  | { found: true }
  /** No loaded package provides the command; `failures` name the packages that failed to load. */
  | { found: false; failures: string[] };

/**
 * The declared name or alias that starts `words` with the most words, and every command declaring
 * it; the words after it are its arguments. Undefined when no name starts them.
 */
function longestMatch(commands: readonly DeclaredCommand[], words: readonly string[]) {
  let best: { name: string; length: number } | undefined;

  for (const { command } of commands) {
    for (const name of commandNames(command)) {
      const parts = name.split(" ");

      if (parts.length > words.length || parts.some((part, index) => part !== words[index])) continue;

      if (!best || parts.length > best.length) best = { name, length: parts.length };
    }
  }

  if (!best) return;
  const { name, length } = best;

  return { name, matches: commands.filter(({ command }) => commandNames(command).includes(name)), args: words.slice(length) };
}

/**
 * Runs a package command from the words given, exactly as typed: the longest declared name that
 * starts them runs, with the rest as its arguments. Any package problem, or a naming problem of the
 * matched command, fails it. A `run` handler gets standard output back; a `result` handler's text
 * is all the command writes there, and nothing when it fails.
 */
export async function dispatchCommand({ dir }: Reader, words: string[]): Promise<Dispatch> {
  const requested = words.join(" ");
  const office = loadOffice(dir);
  const restore = divertStdout();
  const load = await gatherPackages(office);

  // With the gate's problems, ownership conflicts too: no package loaded, so the command may be a typo.
  if (load.blocked) throw new OfficeError(`${requested}: unknown command, or a package command that can't run: no package loaded: ${problemLines(load.problems).join("; ")}`);
  const match = longestMatch(load.commands, words);

  if (!match) return { found: false, failures: problemLines(load.problems) };
  const claimed = new Set(match.matches.flatMap(({ command }) => commandNames(command)));
  const names = new Set(load.names.filter(problem => claimed.has(problem.name)).map(problem => problem.message));
  const problems = [...problemLines(load.problems), ...names];

  if (problems.length) throw new OfficeError(`${match.name}: ${problems.join("; ")}`);
  const [{ owner, command, settings = {} }] = match.matches;
  const item = load.inventory.installed.find(each => each.entry.name === owner);

  // Only the owner's own settings entry, validated by its own schema before anything is written.
  const replaceSetting = (path: readonly (string | number)[], value: string | number | boolean) => {
    if (item === undefined) throw new OfficeError(`${match.name}: package ${owner} did not read, so its settings can't be changed`);

    return replacePackageSetting(loadOffice(dir), owner, path, value, entry => schemaSettings({ entry }, item.manifest, `${relative(dir, item.dir)}/package.json`));
  };

  const inputs = { office: officeInfo(office), entries: load.entries, settings: structuredClone(settings), args: match.args, executor: executorAccess(office), replaceSetting, updateExcluded: (change: { add?: readonly string[]; remove?: readonly string[] }) => updateExcluded(office, change) };

  if (command.result) {
    // An untyped definition's handler can return anything.
    const text = v.safeParse(v.string(), await command.result(inputs));

    if (!text.success) throw new OfficeError(`${match.name}: its result must be text: ${text.issues[0].message}`);
    writeResult(text.output);
  } else if (command.run) {
    restore();
    await command.run(inputs);
  }

  return { found: true };
}
