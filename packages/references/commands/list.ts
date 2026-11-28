import type { CommandInputs } from "@office/sdk";
import { redactUrl } from "@office/sdk/redact-url";
import { repositories } from "../repositories.ts";

/** One line per reference: its name, URL and ref, and who claims it. Takes no arguments. */
export function listReferences(inputs: CommandInputs): string {
  if (inputs.args.length) throw new Error(`office references list takes no arguments, not ${inputs.args.join(" ")}`);

  return inputs.entries(repositories).map(({ value, owner }) => `${value.name}\t${redactUrl(value.url)}${value.ref ? ` @ ${value.ref}` : ""}\t${owner === "office.yaml" ? owner : `package ${owner}`}`).join("\n");
}
