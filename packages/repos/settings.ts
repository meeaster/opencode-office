// The repos package's settings: the office's working repositories, each a checkout at
// `repos/<name>/`. office.yaml's entry is checked against `settingsSchema` before the definition
// runs; `readEntries` repeats every rule, and adds the one a schema can't state (each name once),
// because the access declaration gets office.yaml's settings unchecked, before any package set exists.

/** A checkout's folder name under `repos/`: one path component, never `.`, `..` or hidden. */
const checkoutName = "^[A-Za-z0-9][A-Za-z0-9._-]*$";

export const settingsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    entries: {
      description: "The office's working repositories, in the order sessions list them. Each is a checkout at repos/<name>/; one with a url is cloned when missing and fetched otherwise, one without is listed only.",
      type: "array",
      default: [],
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description"],
        dependentRequired: { ref: ["url"] },
        properties: {
          name: { type: "string", pattern: checkoutName, description: "Its folder under repos/: letters, digits, dots, dashes and underscores, starting with a letter or digit" },
          description: { type: "string", pattern: "\\S", description: "What it holds, for every session" },
          url: { type: "string", minLength: 1, description: "Its origin, as Git clones it; without one the checkout is the owner's to create" },
          ref: { type: "string", minLength: 1, description: "The branch or tag the first clone checks out; sync never switches an existing checkout" },
        },
      },
    },
  },
} as const;

/** A working repository: local-only without a URL. */
export type Entry = { name: string; description: string; url?: string; ref?: string };

type Field = string | number | boolean | null | Field[] | { [key: string]: Field };

const fields = new Set(["name", "description", "url", "ref"]);

/** `value` as a string when it is one, so the parser reads each field once. */
function text(value: Field | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/** One entry, or the problem naming it. */
function readEntry(value: Field, index: number): Entry {
  const where = `entries[${index}]`;

  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be a mapping of name, description, url and ref`);
  const name = text(value.name);
  const label = name === undefined ? where : `${where} (${name})`;
  const unknown = Object.keys(value).find(key => !fields.has(key));

  if (unknown !== undefined) throw new Error(`${label}: ${unknown} is not a field; use name, description, url and ref`);

  if (name === undefined || !new RegExp(checkoutName).test(name)) throw new Error(`${label}: name must be one folder name under repos/, starting with a letter or digit, such as notes`);
  const description = text(value.description);

  if (description === undefined || description.trim() === "") throw new Error(`${label}: description must not be blank`);
  const url = text(value.url);
  const ref = text(value.ref);

  if (value.url !== undefined && !url) throw new Error(`${label}: url must be a repository URL`);

  if (value.ref !== undefined && !ref) throw new Error(`${label}: ref must be a branch or tag`);

  if (ref !== undefined && url === undefined) throw new Error(`${label}: ref needs a url; a local-only checkout has no branch to clone`);

  const entry: Entry = { name, description: description.trim() };

  if (url !== undefined) entry.url = url;

  if (ref !== undefined) entry.ref = ref;

  return entry;
}

/** The entries of the package's settings, checked or not, in office.yaml's order; throws on the first one that is wrong, naming it. */
export function readEntries(settings: { readonly entries?: Field } | Readonly<Record<string, Field | undefined>>): Entry[] {
  const list = settings.entries ?? [];

  if (!Array.isArray(list)) throw new Error("entries must be a list");
  const entries = list.map(readEntry);
  const seen = new Set<string>();

  for (const [index, entry] of entries.entries()) {
    if (seen.has(entry.name)) throw new Error(`entries[${index}] (${entry.name}): name is listed twice; each checkout needs its own folder under repos/`);
    seen.add(entry.name);
  }

  return entries;
}
