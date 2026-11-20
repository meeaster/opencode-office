import * as v from "valibot";
import type { PackageCommand } from "../packages/office/package-context.ts";
import { check, settingValue } from "./schema.ts";

// The core CLI still owns these command families, including its non-public entrypoints.
const reserved = new Set("help version init setup executor secrets sync skills packages check refresh instructions context up down shell exec pin pair apps gui upgrade-tools update cron migrate-home env sfw-wrappers host-agent-cli-update".split(" "));
const route = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*$/, issue => `invalid route ${JSON.stringify(issue.input)}; expected lowercase command words separated by spaces`));

const metadata = {
  name: route,
  aliases: v.optional(v.array(route), []),
  summary: v.pipe(v.string(), v.nonEmpty(), v.regex(/^[^\p{Cc}]+$/u, "expected a single-line command summary")),
};

const registration = v.strictObject({ ...metadata, run: v.custom<PackageCommand["run"]>(value => v.is(v.function(), value), "expected a command handler") });

export type RegisteredCommand = v.InferOutput<typeof registration>;

export type CommandMetadata = Omit<RegisteredCommand, "run">;

export const commandTable = v.strictObject({
  routes: v.pipe(v.array(v.strictObject(metadata)), v.nonEmpty()),
  settings: v.record(v.string(), settingValue),
  files: v.optional(v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/))),
});

/** Validate at registration, even for untyped JS authors; retain functions only in this process. */
export function commandRegistration(command: PackageCommand) {
  return check(v.safeParse(registration, command));
}

type Owner = { name: string; commands?: v.InferOutput<typeof commandTable> };

export function commandConflicts(groups: Owner[]): string[] {
  const owners = new Map<string, string>();
  const errors: string[] = [];

  for (const owner of groups) {
    for (const command of owner.commands?.routes ?? []) {
      for (const name of [command.name, ...command.aliases]) {
        const first = owners.get(name);

        if (first) errors.push(`command ${name} claimed by both package ${first} and package ${owner.name}`);
        else if (reserved.has(name.split(" ")[0]) || (name === "references list" && owner.name !== "references")) errors.push(`package ${owner.name}: command ${name} is reserved`);
        owners.set(name, owner.name);
      }
    }
  }

  return errors;
}
