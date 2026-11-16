// The shape of office.yaml, shared by the CLI and the office plugin (which is bundled with it, so
// an office needs no packages). Parsing returns the checked config, or one error per problem,
// each naming the field and what it expected.
import * as v from "valibot";

const name = v.pipe(v.string("must be a name"), v.regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase letters, digits and dashes"));

const text = v.pipe(v.string("must be text"), v.nonEmpty("must not be empty"));

/** A release version such as 2.3.0 or 2.0.0-beta.49. YAML reads 2.3 as a number, so quote such a version. */
export const version = v.pipe(v.string("must be a version such as 2.3.0"), v.regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/, "must be a version such as 2.3.0"));

/** A minimum release age, as mise reads it: hours, days or weeks. */
export const age = v.pipe(v.string("must be an age such as 1d"), v.regex(/^\d+[hdw]$/, "must be an age such as 36h, 1d or 2w"));

function uniqueNames<Item extends { name: string }>(items: Item[]): boolean {
  return new Set(items.map((item) => item.name)).size === items.length;
}

const mapping = "must be a mapping of the fields this schema knows";

const repository = v.strictObject(
  {
    name,
    url: text,
    ref: v.optional(text),
    description: v.optional(text),
  },
  mapping,
);

const repositories = v.pipe(v.nullish(v.array(repository, "must be a list"), []), v.check(uniqueNames, "lists a name twice"));

const names = v.nullish(v.array(name, "must be a list"), []);

const desk = v.nullish(
  v.strictObject(
    {
      description: v.optional(text),
      repos: repositories,
      skills: names,
    },
    mapping,
  ),
  {},
);

// The tool's own plugins live under these names, so a cloned plugin there would fight `office sync`.
const reservedPlugins = ["office", "knowledge"];

const plugin = v.strictObject(
  {
    name: v.pipe(name, v.check((value) => !reservedPlugins.includes(value), "is one of the tool's own plugins")),
    repo: text,
    ref: v.optional(text),
  },
  mapping,
);

const opencode = v.nullish(
  v.union(
    [
      v.literal("container"),
      v.variant("mode", [
        v.strictObject({ mode: v.literal("container") }),
        v.strictObject({ mode: v.literal("host"), url: v.pipe(text, v.url("must be a URL such as http://127.0.0.1:49374")) }),
      ]),
    ],
    "must be container, or { mode: host, url: <the server's URL> }",
  ),
  "container",
);

/** The tools whose versions an office pins in office.yaml. */
export const pinnedTools = ["opencode", "claude", "executor", "mise"] as const;

export type PinnedTool = (typeof pinnedTools)[number];

const versions = v.optional(
  v.strictObject(
    {
      opencode: v.optional(version),
      claude: v.optional(version),
      executor: v.optional(version),
      mise: v.optional(version),
    },
    "must map opencode, claude, executor and mise to versions",
  ),
);

// `minimum_release_age` is the default for everything the upgrade job bumps; any other key is a
// tool (one of the pinned four, or a tool in a mise.toml) with its own age.
const upgrades = v.nullish(v.record(text, age, "must map minimum_release_age or a tool to an age such as 1d"), {});

const skills = v.nullish(
  v.strictObject(
    {
      enabled: names,
      copied: v.pipe(
        v.nullish(v.array(v.strictObject({ name, repo: text, ref: v.optional(text), path: text }, mapping), "must be a list"), []),
        v.check(uniqueNames, "lists a name twice"),
      ),
    },
    mapping,
  ),
  {},
);

// The office's commit identity, set as git defaults where the office runs git (repository config
// still overrides), and how HTTPS remotes authenticate: `gh` shares the host's gh login.
const git = v.optional(
  v.pipe(
    v.strictObject(
      {
        name: v.optional(text),
        email: v.optional(v.pipe(text, v.email("must be an email address"))),
        credentials: v.optional(v.literal("gh", "must be gh, the host's GitHub CLI login")),
      },
      "must be a mapping of name, email and credentials",
    ),
    v.check((value) => (value.name === undefined) === (value.email === undefined), "needs both name and email, or neither"),
  ),
);

// The office's own services that each get an Executor key of their own, which `office setup` keeps
// in `<state>/<name>-executor.env`. `opencode` is the opencode container's key, which every office has.
const executor = v.nullish(
  v.strictObject(
    {
      tokens: v.pipe(
        v.nullish(v.array(v.pipe(name, v.maxLength(63, "must be at most 63 characters"), v.check((value) => value !== "opencode", "is OpenCode's own key, which every office has")), "must be a list"), []),
        v.check((items) => new Set(items).size === items.length, "lists a name twice"),
      ),
    },
    "must be a mapping of tokens",
  ),
  { tokens: [] },
);

export const officeSchema = v.strictObject(
  {
    name,
    state: v.optional(text),
    opencode,
    git,
    executor,
    secrets: v.optional(v.strictObject({ executor_owner: v.optional(text) })),
    claude: v.optional(v.strictObject({ credential: text, settings: text })),
    versions,
    upgrades,
    references: repositories,
    desks: v.nullish(v.record(name, desk, "must map desk names to desks"), {}),
    skills,
    plugins: v.pipe(v.nullish(v.array(plugin, "must be a list"), []), v.check(uniqueNames, "lists a name twice")),
  },
  "must be a mapping of name, state, opencode, git, executor, secrets, claude, versions, upgrades, references, desks, skills and plugins",
);

export type OfficeConfig = v.InferOutput<typeof officeSchema>;

/** One locked pin: a version and the SHA-256 of what the image downloads (Executor: its image digest). */
const lockEntry = v.strictObject({ version, digest: v.pipe(v.string(), v.regex(/^sha256:[0-9a-f]{64}$/, "must be sha256:<64 hex digits>")) });

export const lockSchema = v.strictObject({
  opencode: lockEntry,
  claude: lockEntry,
  executor: lockEntry,
  mise: lockEntry,
});

export type Lock = v.InferOutput<typeof lockSchema>;

/** Where an issue is, such as `desks.assistant.repos[0].url`. */
function location(issue: v.BaseIssue<unknown>): string {
  let where = "";

  for (const item of issue.path ?? []) {
    const key = String(item.key);

    where = item.type === "array" ? `${where}[${key}]` : where === "" ? key : `${where}.${key}`;
  }

  return where === "" ? "the file" : where;
}

export type Parsed<Output> = { ok: true; value: Output } | { ok: false; errors: string[] };

/**
 * The outcome of `v.safeParse` at a boundary (a parsed YAML or JSON document), with each error
 * reading `<field>: <what it expected>`.
 */
export function check<Schema extends v.GenericSchema>(result: v.SafeParseResult<Schema>): Parsed<v.InferOutput<Schema>> {
  if (result.success) return { ok: true, value: result.output };

  return { ok: false, errors: result.issues.map((issue) => `${location(issue)}: ${issue.message}`) };
}
