import type { CommandInputs } from "@office/sdk";
import { repositories } from "../repositories.ts";

/** One line per reference: its name, URL and ref, and who claims it. */
export function listReferences(inputs: CommandInputs): void {
  for (const { value, owner } of inputs.read(repositories)) console.log(`${value.name}\t${value.url}${value.ref ? ` @ ${value.ref}` : ""}\t${owner === "office.yaml" ? owner : `package ${owner}`}`);
}
