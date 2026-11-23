// The skills package's settings: its sources and the IDs it enables. office.yaml's entry is
// checked against `settingsSchema` before any of this package's code runs; `readSettings` turns
// the checked value into types.

/** A skill ID: lowercase letters and digits, joined by single dashes, as agent runtimes name skills. */
export const skillId = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const relativePath = "^(?!/)(?!(?:.*/)?\\.\\.(?:/|$))[^\\\\]+$";

/** A branch, or a tag pattern such as `v2.*`, that `office skills update` follows. */
const track = "^(?!/)(?!.*/$)(?!(?:.*/)?\\.\\.(?:/|$))[A-Za-z0-9._/*+-]+$";

export const settingsSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    sources: {
      description: "Where standalone skills come from, besides the folders packages offer: { folder } offers each skill folder directly inside an office folder; { repo, ref, track, skills } offers named folders of a Git repository at the full commit ref, which office skills update moves along track.",
      type: "array",
      default: [],
      items: {
        oneOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["folder"],
            properties: { folder: { type: "string", minLength: 1, pattern: relativePath, description: "An office folder whose child folders holding a SKILL.md are skills, by folder name" } },
          },
          {
            type: "object",
            additionalProperties: false,
            required: ["repo", "ref", "skills"],
            properties: {
              repo: { type: "string", minLength: 1, description: "The repository's URL, as git clones it" },
              ref: { type: "string", pattern: "^[0-9a-f]{40}$", description: "The full commit SHA sync uses; office skills update and office refresh move it along track" },
              track: { type: "string", pattern: track, description: "A branch, or a tag pattern such as v2.*, of which the highest stable version wins" },
              skills: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["name", "path"],
                  properties: { name: { type: "string", pattern: skillId.source }, path: { type: "string", minLength: 1, pattern: relativePath } },
                },
              },
            },
          },
        ],
      },
    },
    enabled: {
      description: "The IDs of the skills linked into the office root's .agents/skills/",
      type: "array",
      default: [],
      uniqueItems: true,
      items: { type: "string", pattern: skillId.source },
    },
  },
} as const;

export type FolderSource = { folder: string };

export type GitSkill = { name: string; path: string };

export type GitSource = { repo: string; ref: string; track?: string; skills: GitSkill[] };

export type Source = FolderSource | GitSource;

export type SkillSettings = { sources: Source[]; enabled: string[] };

type Value = null | boolean | number | string | readonly Value[] | { readonly [key: string]: Value | undefined };

function isObject(value: Value | undefined): value is { readonly [key: string]: Value | undefined } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: Value | undefined, where: string): string {
  if (typeof value !== "string") throw new Error(`${where} must be text`);

  return value;
}

function list(value: Value | undefined, where: string): readonly Value[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be a list`);

  return value;
}

function source(value: Value, index: number): Source {
  const where = `sources[${index}]`;

  if (!isObject(value)) throw new Error(`${where} must be a mapping`);

  if (value.folder !== undefined) return { folder: text(value.folder, `${where}.folder`) };

  const skills = list(value.skills, `${where}.skills`).map((skill, at) => {
    if (!isObject(skill)) throw new Error(`${where}.skills[${at}] must be a mapping`);

    return { name: text(skill.name, `${where}.skills[${at}].name`), path: text(skill.path, `${where}.skills[${at}].path`) };
  });

  const git: GitSource = { repo: text(value.repo, `${where}.repo`), ref: text(value.ref, `${where}.ref`), skills };

  if (value.track !== undefined) git.track = text(value.track, `${where}.track`);

  return git;
}

/** The settings as types, from the value office.yaml's entry gave after its schema check. */
export function readSettings(settings: { readonly [key: string]: Value | undefined }): SkillSettings {
  return {
    sources: list(settings.sources ?? [], "sources").map(source),
    enabled: list(settings.enabled ?? [], "enabled").map((id, index) => text(id, `enabled[${index}]`)),
  };
}

export function isGit(source: Source): source is GitSource {
  return "repo" in source;
}
