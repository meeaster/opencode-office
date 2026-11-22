import type { Collection, CollectionEntry } from "@office/office/context";

export type Repository = { name: string; url: string; ref?: string; description?: string };

export function isRepository(input: CollectionEntry): input is Repository {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(input.name) || !Object.hasOwn(input, "url")) return false;

  return Object.entries(input).every(([field, value]) =>
    ["name", "url", "ref", "description"].includes(field) && typeof value === "string" && value.length > 0);
}

export const repositories = {
  id: "references.repository",
  parse(input: CollectionEntry) {
    if (!isRepository(input)) throw new Error("value.name: expected a repository name, nonempty URL and optional ref and description");

    return input;
  },
} satisfies Collection<Repository>;
