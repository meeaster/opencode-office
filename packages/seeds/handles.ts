// What other packages import: the seeds registry and its `add` helper. A package declares each
// seed in its `setup` with `seeds.add(ctx, { destination, source })` or `{ destination, text }`.
import { Registry, type RegistryEntry, type SetupContext } from "@office/sdk";

/**
 * A seed as declared: `destination` relative to the office, and either `source`, a file or folder
 * in the declaring package (a folder lays down every file under it, below `destination`), or `text`.
 */
export type Seed = { destination: string; source: string } | { destination: string; text: string };

/** What `seeds.add` takes: exactly one of `source` and `text`, so giving both or neither doesn't compile. */
export type SeedDeclaration = { destination: string; source: string; text?: never } | { destination: string; text: string; source?: never };

const fields = new Set(["destination", "source", "text"]);

/** Checks a declaration's shape only: its paths are checked at sync, against the package's folder and the office. */
function parse(input: RegistryEntry): Seed {
  const { destination, source, text } = input;
  const named = typeof destination === "string" ? `seed ${destination}` : "a seed";
  const unknown = Object.keys(input).filter(key => !fields.has(key));

  if (typeof destination !== "string" || destination === "") throw new Error(`${named}: destination must be a path relative to the office`);

  if (unknown.length) throw new Error(`${named}: unknown key ${unknown.join(", ")}; a seed has destination and one of source and text`);

  if ((source === undefined) === (text === undefined)) throw new Error(`${named}: give exactly one of source and text`);

  if (source !== undefined) {
    if (typeof source !== "string" || source === "") throw new Error(`${named}: source must be a path in the package`);

    return { destination, source };
  }

  if (typeof text !== "string") throw new Error(`${named}: text must be text`);

  return { destination, text };
}

const registry = Registry.define<Seed>({ id: "seeds.seed", parse });

/** The seeds registry, with `add`, which declares one seed from a package's `setup`. */
export const seeds = {
  ...registry,
  add(ctx: Pick<SetupContext, "add">, seed: SeedDeclaration): void {
    ctx.add(registry, seed);
  },
};
