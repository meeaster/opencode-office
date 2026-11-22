import * as v from "valibot";
import type { PackageCommand } from "../packages/office/package-context.ts";
import { check } from "./schema.ts";

// The core CLI owns these command families, including its non-public entrypoints. It matches its
// own commands by exact shape, so a package name under one of these words would otherwise run.
const reserved = new Set("help version init setup executor secrets sync skills packages seeds check refresh instructions context up down shell exec pin pair apps gui upgrade-tools update cron migrate-home env sfw-wrappers host-agent-cli-update".split(" "));
const route = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*$/, issue => `invalid route ${JSON.stringify(issue.input)}; expected lowercase command words separated by spaces`));

const registration = v.strictObject({
  name: route,
  aliases: v.optional(v.array(route), []),
  summary: v.pipe(v.string(), v.nonEmpty(), v.regex(/^[^\p{Cc}]+$/u, "expected a single-line command summary")),
  run: v.custom<PackageCommand["run"]>(value => v.is(v.function(), value), "expected a command handler"),
});

export type RegisteredCommand = v.InferOutput<typeof registration>;

/** Validate at registration, even for untyped JS authors; retain functions only in this process. */
export function commandRegistration(command: PackageCommand) {
  return check(v.safeParse(registration, command));
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

/** A name or alias that can't run: `name` is the offending name. */
export type NameProblem = { name: string; message: string };

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

      if (first === owner) problems.push({ name, message: `command ${name} claimed twice by package ${owner}` });
      else if (first) problems.push({ name, message: `command ${name} claimed by both package ${first} and package ${owner}` });
      else if (reservedWord(name.split(" ")[0]) || inspectRoute(name)) problems.push({ name, message: `package ${owner}: command ${name} is reserved` });
      owners.set(name, owner);
    }
  }

  return problems;
}
