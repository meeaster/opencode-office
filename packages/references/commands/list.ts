import type { CommandInputs } from "@office/sdk";
import { repositories } from "../repositories.ts";

/** One line per reference: its name, URL and ref, and who claims it. Takes no arguments. */
export function listReferences(inputs: CommandInputs): void {
  if (inputs.args.length) {
    console.error(`office references list takes no arguments, not ${inputs.args.join(" ")}`);
    process.exitCode = 1;

    return;
  }

  for (const { value, owner } of inputs.entries(repositories)) console.log(`${value.name}\t${value.url}${value.ref ? ` @ ${value.ref}` : ""}\t${owner === "office.yaml" ? owner : `package ${owner}`}`);
}
