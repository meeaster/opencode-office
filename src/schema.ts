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
      // Whether the desk has its own Executor app at <desk>/executor/apps/<desk>/.
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

/**
 * The tools whose versions an office pins in office.yaml. sfw is Socket Firewall, which every
 * package download goes through (src/sfw.ts).
 */
export const pinnedTools = ["opencode", "claude", "executor", "mise", "sfw"] as const;

export type PinnedTool = (typeof pinnedTools)[number];

const versions = v.optional(
  v.strictObject(
    {
      opencode: v.optional(version),
      claude: v.optional(version),
      executor: v.optional(version),
      mise: v.optional(version),
      sfw: v.optional(version),
    },
    "must map opencode, claude, executor, mise and sfw to versions",
  ),
);

// `minimum_release_age` is the default for everything the upgrade job bumps; any other key is a
// tool (one of the pinned five, or a tool in a mise.toml) with its own age.
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

/** A package setting's value; settings are written to JSON for the package's scripts. */
const settingValue = v.union([v.string(), v.number(), v.boolean()], "must be text, a number or true/false");

/** Names no package may have, for the mise fragment sync writes as `.office/mise/<name>.toml`. */
export const reservedPackageNames = ["machine", "config", "mise"];

// A package copied from a folder of another repository at a ref, or, without `repo`, one of the
// tool's built-in packages or a package authored in the office under packages/<name>/.
const packageEntry = v.pipe(
  v.strictObject(
    {
      // A package's tools go in .office/mise/<name>.toml. mise loads mise/config.toml and mise.toml
      // in place below .office/, which would make config and mise project config there, and machine
      // would be read as the office's own machine.toml.
      name: v.pipe(
        name,
        v.check((value) => !reservedPackageNames.includes(value), "is reserved: machine.toml at the office root is the office's own machine-wide mise file, and mise would load .office/mise/config.toml or mise.toml by itself"),
      ),
      repo: v.optional(text),
      path: v.optional(text),
      ref: v.optional(text),
      settings: v.nullish(v.record(v.string(), settingValue, "must map setting names to values"), {}),
    },
    mapping,
  ),
  v.check((entry) => (entry.repo === undefined ? entry.path === undefined && entry.ref === undefined : entry.path !== undefined && entry.ref !== undefined), "needs repo, path and ref together, or none of them for a built-in package or one in packages/<name>/"),
  // The check above makes the three all present or all absent; `source` carries that as a type.
  v.transform(({ name: packageName, settings, repo, path, ref }) => ({
    name: packageName,
    settings,
    source: repo !== undefined && path !== undefined && ref !== undefined ? { repo, path, ref } : undefined,
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

export const officeSchema = v.strictObject(
  {
    name,
    state: v.optional(text),
    opencode,
    git,
    secrets: v.optional(v.strictObject({ executor_owner: v.optional(text) })),
    // The Claude gateway (a credential and settings for Claude Code in the container) was removed;
    // an office.yaml that still has the block is told so instead of hearing of an unknown key.
    claude: v.optional(v.never("was the Claude gateway, which office no longer has: delete the claude block from office.yaml")),
    versions,
    upgrades,
    // Whether package downloads (npm, pnpm, pip, uv, cargo and mise installs) go through Socket
    // Firewall, in the container and, in host mode, on the machine. On unless set to false.
    socket_firewall: v.optional(v.boolean("must be true or false"), true),
    references: repositories,
    desks: v.nullish(v.record(name, desk, "must map desk names to desks"), {}),
    skills,
    plugins: v.pipe(v.nullish(v.array(plugin, "must be a list"), []), v.check(uniqueNames, "lists a name twice")),
    packages: v.pipe(v.nullish(v.array(packageEntry, "must be a list"), []), v.check(uniqueNames, "lists a name twice")),
  },
  "must be a mapping of name, state, opencode, git, secrets, versions, upgrades, socket_firewall, references, desks, skills, plugins and packages",
);

export type OfficeConfig = v.InferOutput<typeof officeSchema>;

/** A setting a package accepts: what it means, and a default or `required: true`. */
const packageSetting = v.pipe(
  v.strictObject({ description: text, default: v.optional(settingValue), required: v.optional(v.literal(true, "must be true, or left out with a default")) }, mapping),
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
 * neither pins nor updates it.
 */
const hostInstall = v.strictObject(
  {
    description: text,
    creates: v.pipe(v.string(), v.regex(/^~\/[A-Za-z0-9._/-]+$/, "must be a path in the home folder such as ~/.local/bin/tool")),
    script: v.pipe(v.string(), v.regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*\.ts$/, "must be a .ts script in the package, such as scripts/install.ts")),
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
export const reservedVariables = ["PATH", "HOME", "SHELL", "ENV", "BASH_ENV", "ZDOTDIR", "IFS", "NPM_CONFIG_MIN_RELEASE_AGE", "pnpm_config_minimum_release_age", "UV_EXCLUDE_NEWER", "PIP_UPLOADED_PRIOR_TO"];

const hostVariable = v.pipe(
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
    tools: miseTools,
    install: v.optional(hostInstall),
    path: v.nullish(v.array(hostPathEntry, "must be a list of folders"), []),
    env: v.nullish(v.record(hostVariable, hostValue, "must map variable names to values"), {}),
  },
  mapping,
);

/** A package's package.yaml: what can't be discovered from its folders. */
export const packageManifestSchema = v.pipe(
  v.strictObject(
    {
      name,
      // What its services, volumes and variables are named after, when that isn't its name.
      namespace: v.optional(name),
      description: text,
      settings: v.nullish(v.record(v.string(), packageSetting, "must map setting names to settings"), {}),
      secrets: v.nullish(v.record(v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9_]*$/, "must be an environment variable name in capitals")), packageSecret, "must map variable names to how each is generated"), {}),
      // mise tools the package needs, each at the version an office starts at; `office sync` writes
      // them to the office's .office/mise/<name>.toml, whose versions are the office's from then on.
      tools: miseTools,
      host: v.optional(hostBlock),
    },
    "must be a mapping of name, namespace, description, settings, secrets, tools and host",
  ),
  v.transform((manifest) => ({ ...manifest, namespace: manifest.namespace ?? manifest.name })),
  v.forward(
    v.check((manifest) => manifest.host?.setting === undefined || isTrueOrFalse(manifest.settings[manifest.host.setting]?.default), "must name one of the package's settings whose default is true or false"),
    ["host", "setting"],
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

export type SettingValue = v.InferOutput<typeof settingValue>;

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

const lockEntries = { opencode: lockEntry, claude: lockEntry, executor: lockEntry, mise: lockEntry, sfw: lockEntry };

export const lockSchema = v.strictObject(lockEntries);

/** office.lock and applied.json as stored: those written before sfw was pinned lack it, and the tool's default fills it in. */
export const storedLockSchema = v.strictObject({ ...lockEntries, sfw: v.optional(lockEntry) });

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
