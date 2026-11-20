import type { CommandInputs } from "../../office/package-context.ts";

export function listReferences({ references }: CommandInputs): void {
  for (const entry of references) console.log(`${entry.name}\t${entry.url}${entry.ref ? ` @ ${entry.ref}` : ""}\t${entry.owner}${entry.stale ? " (stale)" : ""}`);
}

export const listing = {
  name: "references list",
  summary: "Show desired references and their claimants without fetching",
  run: listReferences,
};
