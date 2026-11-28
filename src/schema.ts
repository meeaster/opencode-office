// The shape of office.yaml, shared by the CLI and the office plugin (which is bundled with it, so
// an office needs no packages). Parsing returns the checked config, or one error per problem,
// each naming the field and what it expected.
import * as v from "valibot";

import type { SettingValue } from "../sdk/index.ts";

export type { SettingValue } from "../sdk/index.ts";

export const name = v.pipe(v.string("must be a name"), v.regex(/^[a-z0-9][a-z0-9-]*$/, "must be lowercase letters, digits and dashes"));

export const text = v.pipe(v.string("must be text"), v.nonEmpty("must not be empty"));

/** A release version such as 2.3.0 or 2.0.0-beta.49. YAML reads 2.3 as a number, so quote such a version. */
export const version = v.pipe(v.string("must be a version such as 2.3.0"), v.regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/, "must be a version such as 2.3.0"));

/** A minimum release age, as mise reads it: hours, days or weeks. */
export const age = v.pipe(v.string("must be an age such as 1d"), v.regex(/^\d+[hdw]$/, "must be an age such as 36h, 1d or 2w"));

function uniqueNames<Item extends { name: string }>(items: Item[]): boolean {
  return new Set(items.map((item) => item.name)).size === items.length;
}

export const mapping = "must be a mapping of the fields this schema knows";

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
 * package download goes through (src/features/tools/sfw.ts).
 */
export const pinnedTools = ["opencode", "claude", "codex", "executor", "mise", "sfw"] as const;

export type PinnedTool = (typeof pinnedTools)[number];

/** The minimum release age when office.yaml sets none: for package managers, mise, and every runtime without its own. */
export const defaultReleaseAge = "3d";

/** Check the YAML boundary before parsing a mapping's typed fields; preserve per-key diagnostics. */
function mappingKeys(message: string, allowed: readonly string[], explain: (key: string) => string) {
  return v.pipe(v.unknown(), v.rawCheck(({ dataset, addIssue }) => {
    if (!v.is(v.object({}), dataset.value) || Array.isArray(dataset.value)) addIssue({ message });
    else for (const key of Object.keys(dataset.value)) if (!allowed.includes(key)) addIssue({ message: explain(key) });
  }));
}

/**
 * One runtime under `tools`: a version, or a mapping of `version` and `minimum_release_age` (sfw
 * also takes `enabled`). Both forms parse to the mapping.
 */
function runtimeEntry(tool: PinnedTool) {
  const keys = tool === "sfw" ? ["version", "minimum_release_age", "enabled"] : ["version", "minimum_release_age"];
  const described = tool === "sfw" ? "version, minimum_release_age and enabled" : "version and minimum_release_age";

  const entry = v.pipe(
    mappingKeys(`must be a version such as 2.3.0, or a mapping of ${described}`, keys, (key) => (key === "enabled" ? "has enabled, which only sfw (Socket Firewall) has" : `has an unknown key ${key}: an entry maps ${described}`)),
    v.object({ version: v.optional(version), minimum_release_age: v.optional(age), enabled: v.optional(v.boolean("must be true or false")) }),
  );

  return v.lazy((input) => (v.is(v.string(), input) ? v.pipe(version, v.transform((pinned): v.InferOutput<typeof entry> => ({ version: pinned }))) : entry));
}

const toolKeys = pinnedTools;

/**
 * The runtimes an office runs: each a version or a mapping with its own release age, which
 * otherwise is the office's `minimum_release_age` (default 3d).
 */
const tools = v.nullish(
  v.pipe(
    mappingKeys("must be a mapping of opencode, claude, codex, executor, mise and sfw", toolKeys, (key) => `has an unknown key ${key}: tools maps opencode, claude, codex, executor, mise and sfw`),
    v.object({
      opencode: v.optional(runtimeEntry("opencode")),
      claude: v.optional(runtimeEntry("claude")),
      codex: v.optional(runtimeEntry("codex")),
      executor: v.optional(runtimeEntry("executor")),
      mise: v.optional(runtimeEntry("mise")),
      sfw: v.optional(runtimeEntry("sfw")),
    }),
  ),
);

/**
 * What a package from a repository follows when `office packages update` advances its pin: a
 * branch name, or a pattern of stable SemVer tags with `*`, such as `v2.*`, of which the highest
 * version wins.
 */
const track = v.pipe(
  text,
  v.regex(/^[A-Za-z0-9._\/*+-]+$/, "must be a branch such as main, or a tag pattern such as v2.*"),
  v.check((value) => !value.split("/").includes("..") && !value.startsWith("/") && !value.endsWith("/"), "must be a branch such as main, or a tag pattern such as v2.*"),
);

export const scalarSetting = v.union([v.string(), v.pipe(v.number(), v.finite()), v.boolean()], "must be text, a number or true/false");

/** YAML aliases may form cycles; only data that survives the applied settings snapshot's JSON belongs here. */
export function jsonValue(value: unknown, ancestors = new Set<object>()): value is SettingValue {
  if (value === null || v.is(scalarSetting, value)) return true;

  if ((!Array.isArray(value) && !v.is(v.object({}), value)) || ancestors.has(value)) return false;

  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;

  ancestors.add(value);

  const valid = Object.values(value).every((item) => jsonValue(item, ancestors));

  ancestors.delete(value);

  return valid;
}

export const settingValue = v.custom<SettingValue>((value) => jsonValue(value), "must be JSON-compatible YAML");

/** Names no package may have, for the mise fragment sync writes as `.office/mise/<name>.toml`. */
const reservedPackageNames = ["machine", "config", "mise"];

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
      // The owner's release age for the tools this package requires, in place of the office's.
      minimum_release_age: v.optional(age),
    },
    mapping,
  ),
  v.check((entry) => (entry.repo === undefined ? entry.path === undefined && entry.ref === undefined : entry.path !== undefined && entry.ref !== undefined), "needs repo, path and ref together, or none of them for a built-in package or one in packages/<name>/"),
  v.check((entry) => entry.track === undefined || entry.repo !== undefined, "track needs repo, path and ref: only a package from another repository follows a branch or tags"),
  v.check((entry) => entry.name !== "office" || entry.repo === undefined, "the required office package is built in: its entry can only configure settings"),
  // The check above makes the three all present or all absent; `source` carries that as a type.
  v.transform(({ name: packageName, settings, repo, path, ref, track: follows, minimum_release_age: releaseAge }) => ({
    name: packageName,
    settings,
    source: repo !== undefined && path !== undefined && ref !== undefined ? { repo, path, ref, track: follows } : undefined,
    ...(releaseAge === undefined ? {} : { minimumReleaseAge: releaseAge }),
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

export const packageEntries = v.pipe(v.nullish(v.array(packageEntry, "must be a list"), []), v.check(uniqueNames, "lists a name twice"));

export const officeSchema = v.pipe(v.strictObject(
  {
    name,
    state: v.optional(text),
    opencode,
    executor: v.optional(v.strictObject({
      // The app whose `notifications.send` gets the office's own job notifications, by slug.
      notifications: v.optional(name),
    }, mapping)),
    git,
    secrets: v.optional(v.strictObject({ executor_owner: v.optional(text), server: v.optional(text) })),
    // How old a release must be before anything takes it: package managers, mise and its tools, and
    // each runtime under tools without an age of its own.
    minimum_release_age: v.optional(age),
    tools,
    references: repositories,
    plugins: v.pipe(v.nullish(v.array(plugin, "must be a list"), []), v.check(uniqueNames, "lists a name twice")),
    packages: packageEntries,
  },
  "must be a mapping of name, state, opencode, executor, git, secrets, minimum_release_age, tools, references, plugins and packages",
), v.forward(v.check(({ secrets, opencode }) => secrets?.server === undefined || (opencode !== "container" && opencode.mode === "host" && opencode.managed), "requires opencode.managed: true in host mode"), ["secrets", "server"]));

export type OfficeConfig = v.InferOutput<typeof officeSchema>;

/** A runtime as an office runs it: its version (undefined: the tool's default) and how old a release upgrade-tools takes must be. */
type Runtime = { version: string | undefined; minimumReleaseAge: string };

/** `tools` from office.yaml, with its defaults. */
export type ResolvedTools = {
  /** The age for package managers, mise and mise tools, and each runtime without its own. */
  minimumReleaseAge: string;
  runtimes: Record<PinnedTool, Runtime>;
  /** Whether office.yaml pins versions, which office.lock then verifies; without, the tool's defaults run and upgrade-tools leaves them. */
  pinsVersions: boolean;
  /** Whether package downloads go through Socket Firewall: on unless sfw's `enabled` is false. */
  socketFirewall: boolean;
};

/** Reads `minimum_release_age` and `tools` into one shape, with the default age where office.yaml gives none. */
export function resolveTools(config: Pick<OfficeConfig, "tools" | "minimum_release_age">): ResolvedTools {
  const entries = config.tools ?? {};
  const general = config.minimum_release_age ?? defaultReleaseAge;
  // SAFETY: each PinnedTool appears exactly once in pinnedTools, the source of this record's keys.
  const runtimes = Object.fromEntries(pinnedTools.map((tool) => [tool, { version: entries[tool]?.version, minimumReleaseAge: entries[tool]?.minimum_release_age ?? general }])) as Record<PinnedTool, Runtime>;

  return { minimumReleaseAge: general, runtimes, pinsVersions: pinnedTools.some((tool) => entries[tool]?.version !== undefined), socketFirewall: entries.sfw?.enabled ?? true };
}
