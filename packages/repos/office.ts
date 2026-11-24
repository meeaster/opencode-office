// The repos package: the office's working repositories, declared under its settings, each a
// checkout at `repos/<name>/`. A full `office sync` clones a missing one with a URL and fetches
// the others without advancing them, one item each, so one unavailable remote stops no other work;
// `office sync --packages` and `office packages update` touch none. Every session gets the
// inventory, missing checkouts included. Withdrawing an entry, or the package, leaves its checkout.
import { join } from "node:path";
import { Package, type Problem } from "@office/sdk";
import { checkoutPath, checkoutRoot, type Found, inspect, originProblem, syncCheckout } from "./checkouts.ts";
import { type Entry, readEntries, settingsSchema } from "./settings.ts";

/** What is at an entry's folder, as sync, check and sessions all classify it. */
function found(office: string, entry: Entry): Found {
  return inspect(office, entry.name, entry.url !== undefined);
}

/** The session text: every entry, in office.yaml's order, with whether its checkout is here. */
function inventory(office: string, entries: readonly Entry[]): string {
  if (entries.length === 0) return "";

  return [
    "# Working repositories",
    "",
    `The office's working repositories, declared under the \`repos\` package's \`settings.entries\` in \`office.yaml\`: checkouts under \`${checkoutRoot}/\` to edit, commit and push in. Paths are relative to the office root. Full \`office sync\` clones a missing one that has a URL and fetches the others without changing their branch, index or files; one without a URL is the owner's to create. A checkout's own instructions apply in sessions started inside it.`,
    "",
    ...entries.map(entry => {
      const here = found(office, entry);
      const notes = [entry.url === undefined ? "local only" : "", here.kind === "missing" ? "missing here" : here.kind === "other" ? `not a checkout here: ${here.problem}` : ""].filter(Boolean);

      return `- \`${checkoutPath(entry.name)}\`: ${entry.description}${notes.length ? ` (${notes.join(", ")})` : ""}`;
    }),
  ].join("\n");
}

export default Package.define({
  settings: settingsSchema,
  // The rule the schema can't state (each name once) fails the sync's admission, naming the entry:
  // no package set is published, so no checkout's Git runs and sessions keep the last inventory.
  setup({ settings }) {
    readEntries(settings);
  },
  fullSync: ({ office, settings, verbose }) => readEntries(settings).flatMap(entry => {
    const { url } = entry;

    return url === undefined ? [] : [{ item: checkoutPath(entry.name), run: (output: (line: string) => void) => syncCheckout(office.dir, { ...entry, url }, output, verbose) }];
  }),
  session({ office, settings }) {
    try {
      return inventory(office.dir, readEntries(settings));
    } catch (error) {
      return `# Working repositories\n\nThe \`repos\` package's settings in \`office.yaml\` are wrong, so this session has no inventory: ${error instanceof Error ? error.message : String(error)}`;
    }
  },
  check({ office, settings }) {
    let entries: Entry[];

    try {
      entries = readEntries(settings);
    } catch (error) {
      return [{ level: "failed", message: error instanceof Error ? error.message : String(error) }];
    }

    return entries.flatMap((entry): Problem[] => {
      const here = found(office.dir, entry);
      const where = checkoutPath(entry.name);

      if (here.kind === "missing") return [{ level: "warning", message: entry.url === undefined ? `${where} is missing; it is local only, so sync doesn't create it` : `${where} is missing; office sync clones it` }];

      if (entry.url === undefined) return here.kind === "other" ? [{ level: "warning", message: `${where} ${here.problem}` }] : [];
      const problem = here.kind === "other" ? here.problem : originProblem(office.dir, join(office.dir, checkoutRoot, entry.name), entry.url);

      return problem === undefined ? [] : [{ level: "failed", message: `${where} ${problem}; sync won't fetch it` }];
    });
  },
});
