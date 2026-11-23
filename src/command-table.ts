import { OfficeError } from "./office.ts";
import type { PackageManifest } from "./schema.ts";

// The core CLI owns these command families, including its non-public entrypoints. It matches its
// own commands by exact shape, so a package name under one of these words would otherwise run.
const reserved = new Set("help version init setup executor secrets sync packages check refresh instructions context up down shell exec pin pair apps gui upgrade-tools update env sfw-wrappers host-agent-cli-update".split(" "));

/** A command a package declares, with its name; the definition's schema checked it. */
export type RegisteredCommand = PackageManifest["commands"][string] & { name: string };

/** The commands a definition declares, in order. */
export function declaredCommands(manifest: Pick<PackageManifest, "commands">): RegisteredCommand[] {
  return Object.entries(manifest.commands).map(([name, command]) => ({ name, ...command }));
}

/** Whether `word` is a first word the CLI keeps for its own commands, so no package command starts with it. */
export function reservedWord(word: string) {
  return reserved.has(word);
}

export function inspectRoute(name: string) {
  return name === "opencode inspect" || name.startsWith("opencode inspect ");
}

/** A command's name followed by its aliases. */
export function commandNames(command: Pick<RegisteredCommand, "name" | "aliases">) {
  return [command.name, ...command.aliases];
}

/** A command a package registered in this run. */
export type OwnedCommand = { owner: string; command: Pick<RegisteredCommand, "name" | "aliases"> };

/** A name or alias that can't run: `name` is the offending name, `owners` the packages that claim it. */
export type NameProblem = { name: string; owners: string[]; message: string };

/**
 * The naming rule for the commands registered in one run: each name or alias has one owner, and
 * none takes a first word of the CLI's own commands, nor `opencode inspect` or a name under it.
 */
export function nameProblems(commands: OwnedCommand[]): NameProblem[] {
  const owners = new Map<string, string>();
  const problems: NameProblem[] = [];

  for (const { owner, command } of commands) {
    for (const name of commandNames(command)) {
      const first = owners.get(name);

      if (first === owner) problems.push({ name, owners: [owner], message: `command ${name} claimed twice by package ${owner}` });
      else if (first) problems.push({ name, owners: [first, owner], message: `command ${name} claimed by both package ${first} and package ${owner}` });
      else if (reservedWord(name.split(" ")[0]) || inspectRoute(name)) problems.push({ name, owners: [owner], message: `package ${owner}: command ${name} is reserved` });
      owners.set(name, owner);
    }
  }

  return problems;
}

/**
 * A package command's words, when the first word isn't one of the CLI's own commands: the tokens as
 * given, with `--office <dir>` taken out, before any parsing. Only tokens before `--` are the CLI's:
 * `--` and every token after it reach the package as they are. Undefined for the CLI's own
 * commands, for `opencode inspect`, and when `--help`, `-h` or `--version` is given before `--`,
 * which stay the CLI's. Throws for `--office` before `--` without a value or with one that starts
 * with a dash, which the CLI's option parser refuses too, whatever the command (`--office=<dir>`
 * takes any).
 */
export function packageRoute(args: readonly string[]): { office?: string; words: string[] } | undefined {
  const words: string[] = [];
  let office: string | undefined;
  let problem: string | undefined;
  let index = 0;

  for (; index < args.length && args[index] !== "--"; index++) {
    const token = args[index];
    const value = args[index + 1];

    if (token.startsWith("--office=")) office = token.slice("--office=".length);
    else if (token !== "--office") words.push(token);
    else if (value === undefined) problem ??= "option --office needs a folder: --office <dir>";
    else if (value.startsWith("-")) problem ??= `option --office is ambiguous: ${value} starts with a dash; to name such a folder, use --office=${value}`;
    else office = args[++index];
  }

  if (problem !== undefined) throw new OfficeError(problem);
  const [first, second] = words;

  if (first === undefined || first.startsWith("-") || reservedWord(first) || (first === "opencode" && second === "inspect")) return;

  if (words.some(word => word === "--help" || word === "-h" || word === "--version")) return;

  return { office, words: [...words, ...args.slice(index)] };
}
