import * as v from "valibot";

import type { CheckInputs, CommandInputs, DownInputs, FullSyncInputs, JsonValue, PackageInputs, Problem, SetupContext, SyncInputs, SyncItem, UpInputs } from "../../../sdk/index.ts";
import { check } from "../../parse.ts";
import { jsonValue, managedAgentEnvironment, mapping, name, type SettingValue, text } from "../../schema.ts";

// The bound leaves room for the office's and package's names in a systemd unit filename.
const unitPart = v.pipe(name, v.maxLength(48, "must be at most 48 characters"));

/** A script a package runs: a relative .sh path inside its folder, with nothing a shell would read. */
const packageScript = v.pipe(
  text,
  v.regex(/^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*\.sh$/, "must be a relative .sh path, such as scripts/serve.sh"),
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
function packageVariablePrefix(namespace: string): string {
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
const reservedVariables = ["PATH", "HOME", "SHELL", "ENV", "BASH_ENV", "ZDOTDIR", "IFS", "NPM_CONFIG_MIN_RELEASE_AGE", "pnpm_config_minimum_release_age", "UV_EXCLUDE_NEWER", "PIP_UPLOADED_PRIOR_TO", "MISE_MINIMUM_RELEASE_AGE", ...Object.keys(managedAgentEnvironment)];

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
 * and folders and variables for the office's environment file (src/features/machine/host-env.ts). No shell code.
 */
const hostBlock = v.strictObject(
  {
    setting: v.optional(v.string()),
    // Units office generates around a script; a package that supplies its own unit uses systemd.userUnits from @office/systemd.
    services: v.optional(v.record(unitPart, v.strictObject({
      description: v.pipe(text, v.regex(/^[^\r\n\0]+$/, "must be one line")),
      script: packageScript,
      setting: v.optional(v.string()),
    }, mapping))),
    tools: miseTools,
    install: v.optional(hostInstall),
    path: v.nullish(v.array(hostPathEntry, "must be a list of folders"), []),
    env: v.nullish(v.record(hostVariable, hostValue, "must map variable names to values"), {}),
  },
  mapping,
);

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
 * terminal (src/features/mise-integration/system-setup.ts); nothing else does. `prepare --check` must only say whether a run
 * would change anything (exit 0 for nothing, 100 with a line per change). `ready` lists the
 * absolute paths whose presence shows it was applied, for `office check`, and `verify`, a bash
 * script setup runs once the tools are installed, proves it works from the environment file.
 */
const bootstrapFile = packageFile("toml", "system/bootstrap.toml");

export const systemBlock = v.strictObject(
  {
    setting: v.string(),
    description: text,
    platforms: v.pipe(v.array(systemPlatform, "must be a list of platforms"), v.minLength(1, "must name at least one platform")),
    prepare: v.optional(packageFile("sh", "scripts/prepare.sh")),
    verify: v.optional(packageFile("sh", "scripts/verify.sh")),
    bootstrap: bootstrapFile,
    ready: v.pipe(v.array(v.pipe(v.string(), v.regex(/^\/[A-Za-z0-9._@+/-]+$/, "must be an absolute path")), "must be a list of absolute paths"), v.minLength(1, "must name at least one path")),
    env: v.nullish(v.record(hostVariable, hostValue, "must map variable names to values"), {}),
  },
  mapping,
);

export type SystemBlock = v.InferOutput<typeof systemBlock>;

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

/** The settings of a package that declares none: it accepts none. */
const noSettings = { type: "object", additionalProperties: false } satisfies Record<string, SettingValue>;

/** A settings schema as a definition writes it (readonly) or office reads it. */
type SchemaSource = { readonly [keyword: string]: JsonValue };

/**
 * A definition's `settings` that isn't a JSON-compatible mapping (`null`, `false`, a number, text,
 * a list, or a value JSON can't hold). Kept, rather than failing the definition, so its commands
 * still read; reading the settings reports `problem` and stops every setup.
 */
export class MalformedSettings {
  readonly problem = "must be a JSON Schema object";
}

/** A definition's settings schema as read: a mapping, or what stands for one that isn't. */
export type DeclaredSettings = SchemaSource | MalformedSettings;

function isMapping(value: JsonValue | undefined): value is SchemaSource {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The top-level properties a settings schema declares, by name; a malformed one declares none. */
export function settingProperties(schema: DeclaredSettings): SchemaSource {
  return !(schema instanceof MalformedSettings) && isMapping(schema.properties) ? schema.properties : {};
}

/** The top-level setting `name` when the schema declares it `type: "boolean"`. */
function booleanProperty(schema: DeclaredSettings, name: string): SchemaSource | undefined {
  const property = settingProperties(schema)[name];

  return isMapping(property) && property.type === "boolean" ? property : undefined;
}

/** Whether `name` is a top-level setting the schema declares `type: "boolean"`; a malformed schema is reported when the settings are read, not here. */
function booleanSetting(schema: DeclaredSettings, name: string): boolean {
  return schema instanceof MalformedSettings || booleanProperty(schema, name) !== undefined;
}

/** Whether `name` is a top-level boolean setting whose default is false: what gates a machine's system setup, so an office opts in. */
export function defaultOffSetting(schema: DeclaredSettings, name: string): boolean {
  return booleanProperty(schema, name)?.default === false;
}

/** A package command's name or alias: lowercase words separated by spaces. */
const commandRoute = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]*(?: [a-z][a-z0-9-]*)*$/, issue => `invalid route ${JSON.stringify(issue.input)}; expected lowercase command words separated by spaces`));

/** What a package declares under one command name: its one-line summary, usage, aliases and its one handler. */
const packageCommand = v.pipe(
  v.strictObject({
    summary: v.pipe(v.string(), v.nonEmpty(), v.regex(/^[^\p{Cc}]+$/u, "expected a single-line command summary")),
    usage: v.optional(v.pipe(v.string(), v.nonEmpty(), v.regex(/^[^\p{Cc}]+$/u, "expected a single-line usage"))),
    aliases: v.optional(v.array(commandRoute), []),
    result: v.optional(v.custom<(inputs: CommandInputs) => string | Promise<string>>(value => v.is(v.function(), value), "expected a command handler")),
    run: v.optional(v.custom<(inputs: CommandInputs) => void | Promise<void>>(value => v.is(v.function(), value), "expected a command handler")),
  }, mapping),
  v.check(command => (command.result === undefined) !== (command.run === undefined), "must declare exactly one of result or run"),
);

/**
 * A mapping, not an array, as a Map of its own entries for `v.map` to check each key and value:
 * Valibot's record parser would silently drop own keys such as `constructor`, `prototype` and `__proto__`.
 */
export function ownEntries(message: string) {
  return v.pipe(
    v.custom<Record<string, unknown>>(input => typeof input === "object" && input !== null && !Array.isArray(input), message),
    v.transform(entries => new Map(Object.entries(entries))),
  );
}

/** The commands a package declares, by name; `constructor` and `prototype` are valid routes. */
const packageCommands = v.pipe(
  ownEntries("must map command names to commands"),
  v.map(commandRoute, packageCommand),
  v.transform(commands => Object.fromEntries(commands)),
);

/** The entries of `.office/` office itself keeps, which no package may declare committed. */
const officeFolders = new Set(["cache", "claude", "current", "generation-ticket", "generations", "mise", "node_modules", "opencode", "packages", "plugins", "publishing.json", "resolved", "runtime", "tmp"]);

/** A committed folder: one plain folder name directly under `.office/`, written `.office/<name>/`, that office doesn't keep itself. */
const committedFolder = v.pipe(
  v.string(),
  v.check(path => /^\.office\/[A-Za-z0-9][A-Za-z0-9._-]*\/$/.test(path), issue => `${JSON.stringify(issue.input)} is not one folder directly under .office/, written .office/<name>/`),
  v.check(path => !officeFolders.has(path.slice(".office/".length, -1).toLowerCase()), issue => `${JSON.stringify(issue.input)} is one of office's own folders`),
);

/** The settings a schema declares whose compose variable is also one of the package's secrets. */
function shadowedSettings(manifest: { namespace: string; settings: DeclaredSettings; secrets: Record<string, v.InferOutput<typeof packageSecret>> }) {
  return Object.keys(settingProperties(manifest.settings)).filter((setting) => manifest.secrets[settingVariable(manifest.namespace, setting)] !== undefined);
}

const booleanGate = "must name one of the package's settings declared type: boolean";

// Its shape, its root's type and its validity are settings problems, checked when the settings are
// read (loader/definitions/settings.ts), so the rest of the definition, its commands included, still reads. An absent
// `settings` is the package declaring none; an explicit null is malformed.
const settingsSchema = v.union([
  v.custom<SchemaSource>(value => jsonValue(value) && isMapping(value)),
  v.pipe(v.unknown(), v.transform(() => new MalformedSettings())),
]);

/**
 * The definition of the package named `name`: what can't be discovered from its folders. Its name
 * and description are in its package.json; the namespace defaults to the name.
 */
export function packageManifestSchema(packageName: string) {
  return v.pipe(
    v.strictObject(
      {
        // What its services, volumes and variables are named after, when that isn't its name.
        namespace: v.optional(name),
        setup: v.optional(v.custom<(ctx: SetupContext) => void | Promise<void>>(value => v.is(v.function(), value), "must be a function in office.ts")),
        settings: v.optional(settingsSchema),
        commands: v.optional(packageCommands, {}),
        sync: v.optional(v.custom<(inputs: SyncInputs) => readonly string[] | void | Promise<readonly string[] | void>>(value => v.is(v.function(), value), "must be a function in office.ts")),
        fullSync: v.optional(v.custom<(inputs: FullSyncInputs) => readonly SyncItem[] | Promise<readonly SyncItem[]>>(value => v.is(v.function(), value), "must be a function in office.ts")),
        session: v.optional(v.custom<(inputs: PackageInputs) => string | Promise<string>>(value => v.is(v.function(), value), "must be a function in office.ts")),
        check: v.optional(v.custom<(inputs: CheckInputs) => readonly Problem[] | Promise<readonly Problem[]>>(value => v.is(v.function(), value), "must be a function in office.ts")),
        up: v.optional(v.custom<(inputs: UpInputs) => readonly string[] | void | Promise<readonly string[] | void>>(value => v.is(v.function(), value), "must be a function in office.ts")),
        down: v.optional(v.custom<(inputs: DownInputs) => readonly string[] | void | Promise<readonly string[] | void>>(value => v.is(v.function(), value), "must be a function in office.ts")),
        committed: v.optional(v.pipe(v.array(committedFolder, "must be a list of folders under .office/"), v.check(list => new Set(list).size === list.length, "lists a folder twice")), []),
        secrets: v.nullish(v.record(v.pipe(v.string(), v.regex(/^[A-Z][A-Z0-9_]*$/, "must be an environment variable name in capitals")), packageSecret, "must map variable names to how each is generated"), {}),
        // mise tools the package needs, each at the version it was tested with: `office sync` writes
        // them to the office's machine.packages.toml at that version, whose versions are the office's
        // from then on, and raises one only to keep it at or above what a package declares.
        tools: miseTools,
        host: v.optional(hostBlock),
        system: v.optional(systemBlock),
        // The label on Docker resources its services create themselves, which `office down` removes.
        spawns: v.optional(spawnsBlock),
      },
      "must be a mapping of namespace, settings, commands, setup, sync, fullSync, session, check, up, down, committed, secrets, tools, host, system and spawns",
    ),
    v.transform((manifest) => ({ ...manifest, settings: manifest.settings ?? noSettings, namespace: manifest.namespace ?? packageName })),
    v.forward(
      v.check((manifest) => manifest.host?.setting === undefined || booleanSetting(manifest.settings, manifest.host.setting), booleanGate),
      ["host", "setting"],
    ),
    v.forward(
      v.check((manifest) => Object.values(manifest.host?.services ?? {}).every((service) => service.setting === undefined || booleanSetting(manifest.settings, service.setting)), `each service's setting ${booleanGate}`),
      ["host", "services"],
    ),
    // A system setup runs as root on the user's machine, so a package offers it and the office opts in.
    v.forward(
      v.check((manifest) => manifest.system === undefined || manifest.settings instanceof MalformedSettings || defaultOffSetting(manifest.settings, manifest.system.setting), "must name one of the package's settings declared type: boolean with default: false: an office opts in"),
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
      v.check((manifest) => shadowedSettings(manifest).length === 0, (issue) => `${shadowedSettings(issue.input).map((setting) => `${settingVariable(issue.input.namespace, setting)} is also the variable of the setting ${setting}`).join("; ")}`),
      ["secrets"],
    ),
    // Two packages of an office can't share a label: namespaces are unique.
    v.forward(
      v.check((manifest) => manifest.spawns === undefined || spawnsNamesNamespace(manifest.spawns.label, manifest.namespace), "its value must name the package's namespace (its name unless it sets namespace:) as a part between - _ or ., such as office-${OFFICE_NAME}-tool"),
      ["spawns", "label"],
    ),
  );
}

/** The definition `document` of the package named `name`, checked, with its defaults. */
export function parseManifest(name: string, document: unknown) {
  return check(v.safeParse(packageManifestSchema(name), document));
}

export type PackageManifest = v.InferOutput<ReturnType<typeof packageManifestSchema>>;
