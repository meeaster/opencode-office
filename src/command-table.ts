import type { PackageManifest } from "./schema.ts";

// The core CLI owns these command families, including its non-public entrypoints. It matches its
// own commands by exact shape, so a package name under one of these words would otherwise run.
const reserved = new Set("help version init setup executor secrets sync skills packages seeds check refresh instructions context up down shell exec pin pair apps gui upgrade-tools update cron env sfw-wrappers host-agent-cli-update".split(" "));

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
