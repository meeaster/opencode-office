import type { CommandInputs } from "../../office/package-context.ts";
import { repositories } from "../repositories.ts";

export function listReferences(inputs: CommandInputs): void {
  for (const { value, owner, stale } of inputs.read(repositories)) console.log(`${value.name}\t${value.url}${value.ref ? ` @ ${value.ref}` : ""}\t${owner}${stale ? " (stale)" : ""}`);
}

export const listing = {
  name: "references list",
  summary: "Show desired references and their claimants without fetching",
  run: listReferences,
};
