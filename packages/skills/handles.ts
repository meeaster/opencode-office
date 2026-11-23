// What other packages import: `skills.add`, which a package's `setup` calls to offer one of its
// folders as a standalone skill. Offering it doesn't enable it: the office enables skills by ID in
// this package's settings.
import { posix } from "node:path";
import { Registry, type RegistryEntry, type SetupContext } from "@office/sdk";
import { skillId } from "./settings.ts";

/** A skill folder a package offers: a path inside the package, whose last part is the skill's ID. */
export type SkillFolder = { directory: string };

const portable = /^[a-zA-Z0-9_-][\w.-]*(?:\/[a-zA-Z0-9_-][\w.-]*)*$/;

function parse(input: RegistryEntry): SkillFolder {
  const { directory } = input;
  const unknown = Object.keys(input).filter(key => key !== "directory");

  if (unknown.length) throw new Error(`a skill offer: unknown key ${unknown.join(", ")}; it has only directory`);

  if (typeof directory !== "string" || !portable.test(directory)) throw new Error("a skill offer: directory must be a relative path inside the package, such as skills/review");

  if (!skillId.test(posix.basename(directory))) throw new Error(`a skill offer: ${directory} must end in a skill ID: lowercase letters and digits, joined by single dashes`);

  return { directory };
}

const offers = Registry.define<SkillFolder>({ id: "skills.offers", parse });

/** The offers registry, with `add`, which offers one skill folder from a package's `setup`. */
export const skills = {
  ...offers,
  add(ctx: Pick<SetupContext, "add">, offer: SkillFolder): void {
    ctx.add(offers, offer);
  },
};
