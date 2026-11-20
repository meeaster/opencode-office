// The shape of office.yaml, shared by the CLI and the office plugin (which is bundled with it, so
// an office needs no packages). Parsing returns the checked config, or one error per problem,
// each naming the field and what it expected.
import * as v from "valibot";

import type { PackageContext, SettingValue } from "../packages/office/package-context.ts";
import { validSchedule } from "./cron/schedule.ts";

export type { SettingValue } from "../packages/office/package-context.ts";

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

// The bounds leave room for a qualified ID and office name in a systemd unit filename.
const jobName = v.pipe(name, v.maxLength(48, "must be at most 48 characters"));
const cronSchedule = v.pipe(text, v.check(validSchedule, "must be a valid five-field UTC cron schedule or a time macro such as @daily"));

const cronScript = v.pipe(
  text,
  v.regex(/^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*\.sh$/, "must be a relative .sh path, such as cron/update-references.sh"),
);

const cronFields = { schedule: cronSchedule, script: cronScript };

// Valibot's record parser skips prototype keys; refuse them instead of losing a job or override.
const noPrototypeKeys = v.rawCheck(({ dataset, addIssue }) => {
  const input = Object(dataset.value);

  if (["__proto__", "prototype", "constructor"].some((key) => Object.hasOwn(input, key))) {
    addIssue({ message: "constructor, prototype and __proto__ are reserved names" });
  }
});

const officeCron = v.optional(v.pipe(v.unknown(), noPrototypeKeys, v.record(jobName, v.strictObject(cronFields, mapping), "must map job names to schedules and scripts")), {});
const packageCron = v.optional(v.pipe(v.unknown(), noPrototypeKeys, v.record(jobName, v.strictObject({ ...cronFields, when: v.optional(v.picklist(["managed-host", "host", "container"])) }, mapping), "must map job names to schedules and scripts")), {});
const cronOverrides = v.optional(v.pipe(v.unknown(), noPrototypeKeys, v.record(jobName, v.strictObject({ schedule: v.optional(cronSchedule), enabled: v.optional(v.boolean("must be true or false")) }, mapping), "must map job names to schedule and enabled overrides")), {});

export const repository = v.strictObject(
  {
    name,
    url: text,
    ref: v.optional(text),
    description: v.optional(text),
  },
  mapping,
);

const repositories = v.pipe(v.nullish(v.array(repository, "must be a list"), []), v.check(uniqueNames, "lists a name twice"));

export const referenceContribution = v.strictObject({ registry: v.literal("references.repository"), value: repository });

const names = v.nullish(v.array(name, "must be a list"), []);

const desk = v.nullish(
  v.strictObject(
    {
      description: v.optional(text),
      repos: repositories,
      skills: names,
      // Whether the desk has its own Executor app at <desk>/executor-apps/<desk>/.
      app: v.optional(v.boolean("must be true or false"), true),
    },
    mapping,
  ),
  {},
);

// The office package's plugin is linked under this name, so a cloned plugin there would fight `office sync`.
const reservedPlugins = ["office"];

const plugin = v.strictObject(
  {
    name: v.pipe(name, v.check((value) => !reservedPlugins.includes(value), "is one of the tool's own plugins")),
    repo: text,
    ref: v.optional(text),
  },
  mapping,
);

export const serverVariable = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name"),
  v.check((key) => !reservedServerVariables.has(key) && !/^(OFFICE_|XDG_|SOPS_|LD_)/.test(key), "is reserved for server startup"),
);

export const managedAgentEnvironment = { OPENCODE_DISABLE_AUTOUPDATE: "1", DISABLE_AUTOUPDATER: "1" };

const reservedServerVariables = new Set(["PATH", "HOME", "SHELL", "ENV", "BASH_ENV", "ZDOTDIR", "IFS", "TMPDIR", "OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD", "OPENCODE_PTY_HANDOFF", ...Object.keys(managedAgentEnvironment)]);

const hostOpencode = v.pipe(
  v.strictObject({
    mode: v.literal("host"),
    url: v.pipe(text, v.url("must be a URL such as http://127.0.0.1:49374")),
    managed: v.optional(v.boolean("must be true or false"), false),
    listen_host: v.optional(v.literal("0.0.0.0")),
    env_commands: v.optional(v.record(serverVariable, text, "must map variable names to shell commands")),
  }),
  v.forward(v.check((host) => host.managed || host.env_commands === undefined, "requires opencode.managed: true"), ["env_commands"]),
  v.forward(v.check((host) => host.listen_host === undefined || host.managed, "requires opencode.managed: true"), ["listen_host"]),
  v.forward(v.check((host) => host.listen_host === undefined || new URL(host.url).hostname !== "[::1]", "an IPv4 listener needs an IPv4 loopback URL"), ["url"]),
  v.forward(v.check((host) => {
    if (!host.managed) return true;

    const url = new URL(host.url);

    return url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && url.href === `${url.origin}/`;
  }, "a managed server needs a loopback HTTP origin, such as http://127.0.0.1:49374"), ["url"]),
);

const opencode = v.nullish(
  v.union(
    [
      v.literal("container"),
      v.variant("mode", [
        v.strictObject({ mode: v.literal("container") }),
        hostOpencode,
      ]),
    ],
    "must be container, or { mode: host, url: <the server's URL> }",
  ),
  "container",
);

/**
 * The tools whose versions an office pins in office.yaml. sfw is Socket Firewall, which every
 * package download goes through (src/sfw.ts).
 */
export const pinnedTools = ["opencode", "claude", "codex", "executor", "mise", "sfw"] as const;

export type PinnedTool = (typeof pinnedTools)[number];

/** The minimum release age when office.yaml sets none: for package managers, mise, and every runtime without its own. */
export const defaultReleaseAge = "3d";

/** A plain YAML mapping, not a list or a scalar. */
function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Refuses a mapping key outside `allowed`, naming it; `explain` says what the key is instead. */
function onlyKeys(allowed: readonly string[], explain: (key: string) => string) {
  return v.rawCheck<Record<string, unknown>>(({ dataset, addIssue }) => {
    if (!dataset.typed) return;

    for (const key of Object.keys(dataset.value)) if (!allowed.includes(key)) addIssue({ message: explain(key) });
  });
}

/**
 * One runtime under `tools`: a version, or a mapping of `version` and `minimum_release_age` (sfw
 * also takes `enabled`). Both forms parse to the mapping.
 */
function runtimeEntry(tool: PinnedTool) {
  const keys = tool === "sfw" ? ["version", "minimum_release_age", "enabled"] : ["version", "minimum_release_age"];
  const described = tool === "sfw" ? "version, minimum_release_age and enabled" : "version and minimum_release_age";

  const entry = v.pipe(
    v.custom<Record<string, unknown>>(isMapping, `must be a version such as 2.3.0, or a mapping of ${described}`),
    onlyKeys(keys, (key) => (key === "enabled" ? "has enabled, which only sfw (Socket Firewall) has" : `has an unknown key ${key}: an entry maps ${described}`)),
    v.object({ version: v.optional(version), minimum_release_age: v.optional(age), enabled: v.optional(v.boolean("must be true or false")) }),
  );

  return v.lazy((input) => (typeof input === "string" ? v.pipe(version, v.transform((pinned): v.InferOutput<typeof entry> => ({ version: pinned }))) : entry));
}

const toolKeys = ["minimum_release_age", ...pinnedTools] as const;

/**
 * The tools an office runs and how old their releases must be. `minimum_release_age` (default
 * 3d) applies to package managers, mise and its tools, and every runtime without its own; each
 * runtime is a version or a mapping with its own age. It replaces `versions`, `upgrades` and
 * `socket_firewall`, which offices before it used and are still read (resolveTools).
 */
const tools = v.nullish(
  v.pipe(
    v.custom<Record<string, unknown>>(isMapping, "must be a mapping of minimum_release_age, opencode, claude, codex, executor, mise and sfw"),
    onlyKeys(toolKeys, (key) => `has an unknown key ${key}: tools maps minimum_release_age, opencode, claude, codex, executor, mise and sfw`),
    v.object({
      minimum_release_age: v.optional(age),
      opencode: v.optional(runtimeEntry("opencode")),
      claude: v.optional(runtimeEntry("claude")),
      codex: v.optional(runtimeEntry("codex")),
      executor: v.optional(runtimeEntry("executor")),
      mise: v.optional(runtimeEntry("mise")),
      sfw: v.optional(runtimeEntry("sfw")),
    }),
  ),
);

// Before `tools`: the versions an office pins, how old a release must be before upgrade-tools takes
// it (`minimum_release_age`, or a tool's own), and whether Socket Firewall is on.
const versions = v.optional(
  v.strictObject(
    {
      opencode: v.optional(version),
      claude: v.optional(version),
      codex: v.optional(version),
      executor: v.optional(version),
      mise: v.optional(version),
      sfw: v.optional(version),
    },
    "must map opencode, claude, codex, executor, mise and sfw to versions",
  ),
);

const upgrades = v.nullish(v.record(text, age, "must map minimum_release_age or a tool to an age such as 1d"));

/** The keys `tools` replaced. */
export const legacyToolKeys = ["versions", "upgrades", "socket_firewall"] as const;

/** A model as OpenCode writes it, `provider/model` with an optional `#variant`, such as openai/gpt-6-luna#low. */
export const modelReference = v.pipe(
  v.string("must be a model such as openai/gpt-6-luna#low"),
  v.regex(/^[^/#\s]+\/[^#\s]+(?:#[^#\s]+)?$/, "must be a model such as openai/gpt-6-luna#low: provider/model, with an optional #variant"),
);

/**
 * What a copied skill group or a package from a repository follows when `office skills update` or
 * `office packages update` advances its pin: a branch name, or a pattern of stable SemVer tags with
 * `*`, such as `v2.*`, of which the highest version wins.
 */
export const track = v.pipe(
  text,
  v.regex(/^[A-Za-z0-9._\/*+-]+$/, "must be a branch such as main, or a tag pattern such as v2.*"),
  v.check((value) => !value.split("/").includes("..") && !value.startsWith("/") && !value.endsWith("/"), "must be a branch such as main, or a tag pattern such as v2.*"),
);

/** A folder of a repository, relative to its root (or a group's base), without `..`. */
const repositoryPath = v.pipe(
  text,
  v.check((value) => !value.startsWith("/") && !value.split("/").includes(".."), "must be a relative path inside the repository, without .."),
);

const copiedSkill = v.strictObject({ name, repo: text, ref: v.optional(text), path: text }, mapping);

// A group of skills from one repository at one pinned ref: each skill is a name, copied from
// <base>/<name>, or { name, path } with path relative to base (the repository's root by default).
// Both forms parse to { name, path }.
const skillGroup = v.strictObject(
  {
    repo: text,
    ref: text,
    track: v.optional(track),
    base: v.optional(repositoryPath),
    skills: v.pipe(
      v.array(
        v.union([v.pipe(name, v.transform((skill) => ({ name: skill, path: skill }))), v.strictObject({ name, path: repositoryPath }, mapping)], "must be a skill name or { name, path }"),
        "must be a list",
      ),
      v.minLength(1, "must list at least one skill"),
    ),
  },
  mapping,
);

/** An entry of skills.copied: one skill, as offices have always listed them, or a group from one repository. */
const copiedEntry = v.lazy((input) => (v.is(v.object({ skills: v.unknown() }), input) ? skillGroup : copiedSkill));

type CopiedEntry = v.InferOutput<typeof copiedSkill> | v.InferOutput<typeof skillGroup>;

/** The library names the entries of skills.copied copy into, in order. */
export function copiedNames(entries: CopiedEntry[]): string[] {
  return entries.flatMap((entry) => ("skills" in entry ? entry.skills.map((skill) => skill.name) : [entry.name]));
}

const skills = v.nullish(
  v.strictObject(
    {
      enabled: names,
      copied: v.pipe(
        v.nullish(v.array(copiedEntry, "must be a list"), []),
        v.check((entries) => new Set(copiedNames(entries)).size === copiedNames(entries).length, "lists a skill name twice"),
      ),
    },
    mapping,
  ),
  {},
);

export const scalarSetting = v.union([v.string(), v.pipe(v.number(), v.finite()), v.boolean()], "must be text, a number or true/false");

/** YAML aliases may form cycles; only data that survives .settings.json belongs here. */
function jsonValue(value: unknown, ancestors = new Set<object>()): value is SettingValue {
  if (value === null || v.is(scalarSetting, value)) return true;

  if ((!Array.isArray(value) && !v.is(v.object({}), value)) || ancestors.has(value)) return false;

  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;

  ancestors.add(value);

  const valid = Object.values(value).every((item) => jsonValue(item, ancestors));

  ancestors.delete(value);

  return valid;
}

const settingValue = v.custom<SettingValue>((value) => jsonValue(value), "must be JSON-compatible YAML");

/** Names no package may have, for the mise fragment sync writes as `.office/mise/<name>.toml`. */
export const reservedPackageNames = ["machine", "config", "mise"];

// A package copied from a folder of another repository at a ref, or, without `repo`, one of the
// tool's built-in packages or a package authored in the office under packages/<name>/.
const packageEntry = v.pipe(
  v.strictObject(
    {
      // A package's mise setup goes in .office/mise/<name>.toml. mise loads mise/config.toml and mise.toml
      // in place below .office/, which would make config and mise project config there, and machine
      // would be read as the office's own machine.toml.
      name: v.pipe(
        name,
        v.check((value) => !reservedPackageNames.includes(value), "is reserved: machine.toml at the office root is the office's own machine-wide mise file, and mise would load .office/mise/config.toml or mise.toml by itself"),
      ),
      repo: v.optional(text),
      path: v.optional(text),
      ref: v.optional(text),
      // What `office packages update` moves ref to; without it, ref stays where it is.
      track: v.optional(track),
      settings: v.pipe(v.nullish(v.record(v.string(), settingValue, "must map setting names to values")), v.transform((settings) => settings ?? {})),
      cron: cronOverrides,
    },
    mapping,
  ),
  v.check((entry) => (entry.repo === undefined ? entry.path === undefined && entry.ref === undefined : entry.path !== undefined && entry.ref !== undefined), "needs repo, path and ref together, or none of them for a built-in package or one in packages/<name>/"),
  v.check((entry) => entry.track === undefined || entry.repo !== undefined, "track needs repo, path and ref: only a package from another repository follows a branch or tags"),
  v.check((entry) => entry.name !== "office" || entry.repo === undefined, "the required office package is built in: its entry can only configure settings and cron"),
  // The check above makes the three all present or all absent; `source` carries that as a type.
  v.transform(({ name: packageName, settings, cron, repo, path, ref, track: follows }) => ({
    name: packageName,
    settings,
    cron,
    source: repo !== undefined && path !== undefined && ref !== undefined ? { repo, path, ref, track: follows } : undefined,
  })),
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

export const officeSchema = v.pipe(v.strictObject(
  {
    name,
    state: v.optional(text),
    opencode,
    executor: v.optional(v.strictObject({
      catalog_apps: v.optional(v.pipe(v.array(name, "must be a list of Executor catalog IDs"), v.check((ids) => new Set(ids).size === ids.length, "lists a catalog ID twice")), []),
    }, mapping)),
    git,
    secrets: v.optional(v.strictObject({ executor_owner: v.optional(text), server: v.optional(text) })),
    // The Claude gateway (a credential and settings for Claude Code in the container) was removed;
    // an office.yaml that still has the block is told so instead of hearing of an unknown key.
    claude: v.optional(v.never("was the Claude gateway, which office no longer has: delete the claude block from office.yaml")),
    tools,
    versions,
    upgrades,
    cron: officeCron,
    socket_firewall: v.optional(v.boolean("must be true or false")),
    references: repositories,
    desks: v.nullish(v.record(v.pipe(name, v.check(key => key !== "executor-apps", "executor-apps is reserved for shared Executor app sources")), desk, "must map desk names to desks"), {}),
    skills,
    plugins: v.pipe(v.nullish(v.array(plugin, "must be a list"), []), v.check(uniqueNames, "lists a name twice")),
    packages: v.pipe(v.nullish(v.array(packageEntry, "must be a list"), []), v.check(uniqueNames, "lists a name twice")),
  },
  "must be a mapping of name, state, opencode, executor, git, secrets, tools, cron, references, desks, skills, plugins and packages",
), v.forward(v.check((config) => config.tools === undefined || config.tools === null || legacyKeys(config).length === 0, (issue) => `replaces versions, upgrades and socket_firewall, so office.yaml can't have both: remove ${legacyKeys(issue.input).join(" and ")}`), ["tools"]), v.forward(v.check(({ secrets, opencode }) => secrets?.server === undefined || (opencode !== "container" && opencode.mode === "host" && opencode.managed), "requires opencode.managed: true in host mode"), ["secrets", "server"]));

export type OfficeConfig = v.InferOutput<typeof officeSchema>;

/** The keys before `tools` that office.yaml sets. */
function legacyKeys(config: { versions?: unknown; upgrades?: unknown; socket_firewall?: unknown }): string[] {
  return legacyToolKeys.filter((key) => config[key] !== undefined && config[key] !== null);
}

/** A runtime as an office runs it: its version (undefined: the tool's default) and how old a release upgrade-tools takes must be. */
export type Runtime = { version: string | undefined; minimumReleaseAge: string };

/** `tools` from office.yaml, or the keys before it, in one shape. */
export type ResolvedTools = {
  /** The age for package managers, mise and mise tools, and each runtime without its own. */
  minimumReleaseAge: string;
  runtimes: Record<PinnedTool, Runtime>;
  /** Whether office.yaml pins versions, which office.lock then verifies; without, the tool's defaults run and upgrade-tools leaves them. */
  pinsVersions: boolean;
  /** Whether package downloads go through Socket Firewall: on unless sfw's `enabled` (or `socket_firewall`) is false. */
  socketFirewall: boolean;
  /** The keys before `tools` that office.yaml still uses, which `office check` asks to replace. */
  legacy: string[];
  /** Ages under `upgrades` for mise tools, which no longer apply: every mise tool takes `minimumReleaseAge`. */
  ignoredAges: string[];
};

/**
 * Reads `tools`, or `versions`, `upgrades` and `socket_firewall` from an office before it, into
 * one shape. In an old office.yaml `upgrades.minimum_release_age` was the upgrade job's age, so it
 * becomes the age of each runtime without its own; package managers and mise take the default.
 */
export function resolveTools(config: Pick<OfficeConfig, "tools" | "versions" | "upgrades" | "socket_firewall">): ResolvedTools {
  const legacy = legacyKeys(config);

  if ((config.tools !== undefined && config.tools !== null) || legacy.length === 0) {
    const entries = config.tools ?? {};
    const general = entries.minimum_release_age ?? defaultReleaseAge;
    const runtimes = Object.fromEntries(pinnedTools.map((tool) => [tool, { version: entries[tool]?.version, minimumReleaseAge: entries[tool]?.minimum_release_age ?? general }])) as Record<PinnedTool, Runtime>;

    return { minimumReleaseAge: general, runtimes, pinsVersions: pinnedTools.some((tool) => entries[tool]?.version !== undefined), socketFirewall: entries.sfw?.enabled ?? true, legacy: [], ignoredAges: [] };
  }

  const upgradeAges = config.upgrades ?? {};
  const runtimeAge = upgradeAges.minimum_release_age ?? defaultReleaseAge;
  const runtimes = Object.fromEntries(pinnedTools.map((tool) => [tool, { version: config.versions?.[tool], minimumReleaseAge: upgradeAges[tool] ?? runtimeAge }])) as Record<PinnedTool, Runtime>;
  const ignoredAges = Object.keys(upgradeAges).filter((key) => key !== "minimum_release_age" && !(pinnedTools as readonly string[]).includes(key));

  return { minimumReleaseAge: defaultReleaseAge, runtimes, pinsVersions: config.versions !== undefined, socketFirewall: config.socket_firewall ?? true, legacy, ignoredAges };
}

/** A setting a package accepts: what it means, and a default or `required: true`. */
const packageSetting = v.pipe(
  v.strictObject({ description: text, default: v.optional(scalarSetting), required: v.optional(v.literal(true, "must be true, or left out with a default")) }, mapping),
  v.check((setting) => (setting.default === undefined) !== (setting.required === undefined), "needs a default or required: true, not both"),
);

/**
 * How `office up` generates one of a package's secrets, once: `bytes` random bytes as `hex` or
 * `base64`, after an optional fixed `prefix`. The prefix is kept to characters an env file holds unquoted.
 */
const packageSecret = v.strictObject(
  {
    generate: v.picklist(["hex", "base64"], "must be hex or base64"),
    bytes: v.pipe(v.number("must be a number of bytes"), v.integer("must be a whole number"), v.minValue(16, "must be at least 16"), v.maxValue(1024, "must be at most 1024")),
    prefix: v.optional(v.pipe(v.string("must be text"), v.regex(/^[A-Za-z0-9._:/+=-]*$/, "may hold only letters, digits and . _ : / + = -"))),
  },
  mapping,
);

/** The prefix of every variable a package's compose file gets from office: its namespace in capitals, `-` as `_`. */
export function packageVariablePrefix(namespace: string): string {
  return `${namespace.toUpperCase().replaceAll("-", "_")}_`;
}

/** The variable a package setting reaches its compose file as, such as ARTIFACT_SHARE_URL. */
export function settingVariable(namespace: string, setting: string): string {
  return `${packageVariablePrefix(namespace)}${setting.toUpperCase().replaceAll(/[^A-Z0-9]/g, "_")}`;
}

/** A mise tool, as a mise.toml's [tools] table names it, such as `node` or `npm:agent-browser`. */
const miseTool = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_.:@/-]+$/, "must be a mise tool name such as node or npm:agent-browser"));

/** An exact version to start a mise tool at, such as 0.43.0: never a range, a prefix or `latest`. */
const miseVersion = v.pipe(v.string("must be an exact version such as 0.43.0"), v.regex(/^v?\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?$/, "must be an exact version such as 0.43.0"));

function isTrueOrFalse(value: string | number | boolean | undefined): value is boolean {
  return value === true || value === false;
}

const miseTools = v.nullish(v.record(miseTool, miseVersion, "must map mise tool names to exact versions"), {});

/**
 * Something a package installs once on the machine of a host-mode office, outside the office:
 * `script` (a Bun script in the package) creates `creates` (a path in the home folder) when it is
 * missing. It runs as the postinstall hook of the package's mise fragment, so `mise install` in
 * the office runs it, and as the task `<package>:install`. After that the file is its own: office
 * neither pins nor updates it. `creates` is an executable unless `executable: false` makes it a
 * regular file, such as a script a shell sources; the hook's test and `office check` follow it.
 */
const hostInstall = v.strictObject(
  {
    description: text,
    creates: v.pipe(v.string(), v.regex(/^~\/[A-Za-z0-9._/-]+$/, "must be a path in the home folder such as ~/.local/bin/tool")),
    script: v.pipe(v.string(), v.regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.ts$/, "must be a .ts script in the package, such as scripts/install.ts")),
    executable: v.optional(v.boolean("must be true or false"), true),
  },
  mapping,
);

/**
 * A folder a package puts on PATH in the office's environment file: `~/…` in the home folder, an
 * absolute path, or a path in the package's own folder. Letters, digits and `. _ @ + -` only, so
 * it holds no PATH separator and nothing a shell would expand.
 */
const hostPathEntry = v.pipe(
  v.string("must be a folder"),
  v.regex(/^(?:~\/|\/)?[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*\/?$/, "must be a folder such as ~/.local/bin, /opt/tool/bin or bin (in the package), with letters, digits and . _ @ + - only"),
  v.check((entry) => !entry.split("/").includes(".."), "must not climb out with .."),
);

/** Variables office's environment file sets itself, or that would change how a shell runs. */
export const reservedVariables = ["PATH", "HOME", "SHELL", "ENV", "BASH_ENV", "ZDOTDIR", "IFS", "NPM_CONFIG_MIN_RELEASE_AGE", "pnpm_config_minimum_release_age", "UV_EXCLUDE_NEWER", "PIP_UPLOADED_PRIOR_TO", "MISE_MINIMUM_RELEASE_AGE", ...Object.keys(managedAgentEnvironment)];

export const hostVariable = v.pipe(
  v.string(),
  v.regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "must be an environment variable name"),
  v.check((name) => !reservedVariables.includes(name) && !name.startsWith("OFFICE_"), "is set by office itself, or changes how a shell runs"),
);

/** A variable's value: one line of plain text, written single-quoted, so nothing in it is expanded. */
const hostValue = v.pipe(
  v.union([v.string(), v.number(), v.boolean()], "must be text, a number or true/false"),
  v.transform(String),
  v.regex(/^[^\u0000-\u001f\u007f]*$/, "must be one line of plain text"),
);

/**
 * What a package gives only an office in host mode, where OpenCode runs on the machine itself,
 * and, with `setting`, only while that boolean setting is true: more mise tools, a host install,
 * and folders and variables for the office's environment file (src/host-env.ts). No shell code.
 */
const hostBlock = v.strictObject(
  {
    setting: v.optional(v.string()),
    services: v.optional(v.record(jobName, v.strictObject({
      description: v.pipe(text, v.regex(/^[^\r\n\0]+$/, "must be one line")),
      script: cronScript,
      setting: v.optional(v.string()),
    }, mapping))),
    tools: miseTools,
    install: v.optional(hostInstall),
    path: v.nullish(v.array(hostPathEntry, "must be a list of folders"), []),
    env: v.nullish(v.record(hostVariable, hostValue, "must map variable names to values"), {}),
  },
  mapping,
);

/**
 * The Executor app a package ships in its `executor-app/` folder, which `office apps deploy`
 * deploys under the package's namespace, and, with `setting`, only while that boolean setting is
 * true.
 */
const executorAppBlock = v.strictObject({ setting: v.optional(v.string()) }, mapping);

/** A file in the package, by a relative path without `..`. */
function packageFile(extension: string, example: string) {
  return v.pipe(v.string(), v.regex(new RegExp(`^[A-Za-z0-9._-]+(?:/[A-Za-z0-9._-]+)*\\.${extension}$`), `must be a .${extension} file in the package, such as ${example}`), v.check((path) => !path.split("/").includes(".."), "must not climb out with .."));
}

/**
 * A machine a system block supports, as `<os-release ID>-<VERSION_ID>-<dpkg architecture>`, with
 * `-wsl` when it must be WSL: `ubuntu-24.04-amd64-wsl`.
 */
const systemPlatform = v.pipe(v.string(), v.regex(/^[a-z0-9]+-[0-9.]+-[a-z0-9]+(?:-wsl)?$/, "must be a platform such as ubuntu-24.04-amd64-wsl"));

/**
 * What a package sets up in a host-mode office's machine with its operating system's package
 * manager, only while `setting` (which defaults to false) is on and the machine is one of
 * `platforms`: mise `[bootstrap]` tables (`bootstrap`, a TOML file in the package) and a `prepare`
 * script that runs as their `pre-packages` hook, both written to the package's mise fragment; and
 * variables for the office's environment file. `office setup` offers to apply it from the user's
 * terminal (src/system-setup.ts); nothing else does. `prepare --check` must only say whether a run
 * would change anything (exit 0 for nothing, 100 with a line per change). `ready` lists the
 * absolute paths whose presence shows it was applied, for `office check`, and `verify`, a bash
 * script setup runs once the tools are installed, proves it works from the environment file.
 */
const systemBlock = v.strictObject(
  {
    setting: v.string(),
    description: text,
    platforms: v.pipe(v.array(systemPlatform, "must be a list of platforms"), v.minLength(1, "must name at least one platform")),
    prepare: v.optional(packageFile("sh", "scripts/prepare.sh")),
    verify: v.optional(packageFile("sh", "scripts/verify.sh")),
    bootstrap: packageFile("toml", "system/bootstrap.toml"),
    ready: v.pipe(v.array(v.pipe(v.string(), v.regex(/^\/[A-Za-z0-9._@+/-]+$/, "must be an absolute path")), "must be a list of absolute paths"), v.minLength(1, "must name at least one path")),
    env: v.nullish(v.record(hostVariable, hostValue, "must map variable names to values"), {}),
  },
  mapping,
);

/** The one variable a `spawns` label may hold, which office replaces with the office's name. */
export const spawnsOfficeName = "${OFFICE_NAME}";

/**
 * The Docker label a package's services put on the containers, networks and volumes they create
 * through the Docker socket, as `key=value`. The value holds `${OFFICE_NAME}` and nothing else to
 * interpolate, so each office's label is its own; the package's namespace has to be one of its
 * parts too (manifest check below). Keys under com.docker. are Docker's and Compose's own.
 */
const spawnsBlock = v.strictObject(
  {
    label: v.pipe(
      v.string("must be a label such as tool_namespace=office-${OFFICE_NAME}-tool"),
      v.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*=[A-Za-z0-9._${}-]+$/, "must be one key=value label of letters, digits and . _ -, such as tool_namespace=office-${OFFICE_NAME}-tool"),
      v.check((label) => !label.startsWith("com.docker."), "must not use a com.docker. key, which Docker and Compose set themselves"),
      v.check((label) => label.split(spawnsOfficeName).length === 2 && !/[${}]/.test(label.replace(spawnsOfficeName, "")), "its value must hold ${OFFICE_NAME} once and nothing else to interpolate, so it names only this office's resources"),
    ),
  },
  mapping,
);

/** Whether `namespace` is one of the `-`, `_` or `.` separated parts of a spawns label's value. */
function spawnsNamesNamespace(label: string, namespace: string): boolean {
  const value = label.slice(label.indexOf("=") + 1).replace(spawnsOfficeName, "\0");

  // A namespace is lowercase letters, digits and dashes, so it needs no escaping.
  return new RegExp(`(?:^|[-_.\\0])${namespace}(?:$|[-_.\\0])`).test(value);
}

/** A package's package.yaml: what can't be discovered from its folders. */
export const packageManifestSchema = v.pipe(
  v.strictObject(
    {
      name,
      // What its services, volumes and variables are named after, when that isn't its name.
      namespace: v.optional(name),
      description: text,
      setup: v.optional(v.custom<(ctx: PackageContext) => void | Promise<void>>(value => v.is(v.function(), value), "must be a function in office.ts")),
      settings: v.optional(v.record(v.string(), packageSetting, "must map setting names to settings")),
      settings_schema: v.optional(v.union([v.boolean(), v.record(v.string(), settingValue)])),
      secrets: v.nullish(v.record(v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9_]*$/, "must be an environment variable name in capitals")), packageSecret, "must map variable names to how each is generated"), {}),
      // mise tools the package needs, each at the version it was tested with: `office sync` writes
      // them to the office's machine.packages.toml at that version, whose versions are the office's
      // from then on, and raises one only to keep it at or above what a package declares.
      tools: miseTools,
      host: v.optional(hostBlock),
      system: v.optional(systemBlock),
      cron: packageCron,
      executor_app: v.optional(executorAppBlock),
      // The label on Docker resources its services create themselves, which `office down` removes.
      spawns: v.optional(spawnsBlock),
    },
    "must be a mapping of name, namespace, description, settings or settings_schema, secrets, tools, host, system, cron, executor_app and spawns",
  ),
  v.check((manifest) => manifest.settings === undefined || manifest.settings_schema === undefined, "choose settings or settings_schema, not both"),
  v.transform((manifest) => ({ ...manifest, settings: manifest.settings ?? {}, namespace: manifest.namespace ?? manifest.name })),
  v.forward(
    v.check((manifest) => manifest.settings_schema !== undefined || manifest.host?.setting === undefined || isTrueOrFalse(manifest.settings[manifest.host.setting]?.default), "must name one of the package's settings whose default is true or false"),
    ["host", "setting"],
  ),
  v.forward(
    v.check((manifest) => manifest.settings_schema !== undefined || manifest.executor_app?.setting === undefined || isTrueOrFalse(manifest.settings[manifest.executor_app.setting]?.default), "must name one of the package's settings whose default is true or false"),
    ["executor_app", "setting"],
  ),
  // A system setup runs as root on the user's machine, so a package offers it and the office opts in.
  v.forward(
    v.check((manifest) => manifest.settings_schema !== undefined || manifest.system === undefined || manifest.settings[manifest.system.setting]?.default === false, "must name one of the package's settings whose default is false: an office opts in"),
    ["system", "setting"],
  ),
  v.forward(
    v.check((manifest) => manifest.system === undefined || manifest.host === undefined || Object.keys(manifest.system.env).every((name) => !Object.hasOwn(manifest.host?.env ?? {}, name)), "sets a variable the host block also sets"),
    ["system", "env"],
  ),
  // Every compose file of the office is interpolated with the same process environment, which wins
  // over a package's own values, so a package's secrets carry its namespace.
  v.forward(
    v.check((manifest) => Object.keys(manifest.secrets).every((key) => key.startsWith(packageVariablePrefix(manifest.namespace))), "each name must start with the package's namespace (its name unless it sets namespace:) in capitals and _ for -, such as DOOP_"),
    ["secrets"],
  ),
  v.forward(
    v.check((manifest) => Object.keys(manifest.settings).every((setting) => manifest.secrets[settingVariable(manifest.namespace, setting)] === undefined), "a name is also the variable of one of the package's settings"),
    ["secrets"],
  ),
  // Two packages of an office can't share a label: namespaces are unique.
  v.forward(
    v.check((manifest) => manifest.spawns === undefined || spawnsNamesNamespace(manifest.spawns.label, manifest.namespace), "its value must name the package's namespace (its name unless it sets namespace:) as a part between - _ or ., such as office-${OFFICE_NAME}-tool"),
    ["spawns", "label"],
  ),
);

/**
 * A published port, read as whether it binds only 127.0.0.1: the short syntax binds every
 * interface unless it starts with a host address (`127.0.0.1:8080:80`), the long syntax unless its
 * `host_ip` is one.
 */
const composePort = v.union(
  [
    v.pipe(
      v.string(),
      v.transform((port) => ({ loopback: port.startsWith("127.0.0.1:") })),
    ),
    v.pipe(
      v.number(),
      v.transform(() => ({ loopback: false })),
    ),
    v.pipe(
      v.looseObject({ host_ip: v.optional(v.string()) }),
      v.transform((port) => ({ loopback: port.host_ip === "127.0.0.1" })),
    ),
  ],
  "must be a port",
);

/** The parts of a Compose file office checks in a package's compose.yaml; anything else passes through to Compose. */
export const composeFileSchema = v.looseObject(
  {
    services: v.nullish(v.record(v.string(), v.looseObject({ ports: v.optional(v.array(composePort)), network_mode: v.optional(v.string()) }, "must be a service")), {}),
    volumes: v.nullish(v.record(v.string(), v.nullable(v.looseObject({ name: v.optional(v.string()), external: v.optional(v.boolean()) }, "must be a volume"))), {}),
    networks: v.nullish(v.record(v.string(), v.nullable(v.looseObject({}))), {}),
    configs: v.nullish(v.record(v.string(), v.nullable(v.looseObject({}))), {}),
    secrets: v.nullish(v.record(v.string(), v.nullable(v.looseObject({}))), {}),
  },
  "must be a Compose file",
);

export type ComposeFile = v.InferOutput<typeof composeFileSchema>;

export type PackageManifest = v.InferOutput<typeof packageManifestSchema>;


const digest = v.pipe(v.string(), v.regex(/^sha256:[0-9a-f]{64}$/, "must be sha256:<64 hex digits>"));

/** The machines a host-mode office installs a pinned tool on: Linux and macOS, x64 and arm64, by Node's names. */
export const hostPlatforms = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"] as const;

export type HostPlatform = (typeof hostPlatforms)[number];

/**
 * One locked pin: a version and the SHA-256 of what the image downloads (Executor: its image
 * digest). A tool the office also installs on a host-mode office's machine (sfw) adds the SHA-256
 * of each platform's release file.
 */
const lockEntry = v.strictObject({
  version,
  digest,
  platforms: v.optional(v.strictObject({ "linux-x64": digest, "linux-arm64": digest, "darwin-x64": digest, "darwin-arm64": digest }, "must map linux-x64, linux-arm64, darwin-x64 and darwin-arm64 to digests")),
});

const lockEntries = { opencode: lockEntry, claude: lockEntry, codex: lockEntry, executor: lockEntry, mise: lockEntry, sfw: lockEntry };

export const lockSchema = v.strictObject(lockEntries);

/** office.lock and applied.json as stored: those written before sfw was pinned lack it, and the tool's default fills it in. */
export const storedLockSchema = v.strictObject({ ...lockEntries, sfw: v.optional(lockEntry), codex: v.optional(lockEntry) });

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
