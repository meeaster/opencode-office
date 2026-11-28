// @office/sdk: what a package imports to be an office package. A package's definition is
// `export default Package.define({...})`; a registry handle is `Registry.define({...})`.
//
// The office executable registers its own copy of this module under the name `@office/sdk` before
// it loads a definition, so a package always gets that copy, whatever is on disk. The copy sync
// writes beside an office's packages gives editors and tsc these types; loading it throws.
// Named exports only: there is no default export.
import { mark, markAccess, markIntegration } from "./mark.ts";

/** A value an office.yaml setting can hold: what YAML and JSON share. */
export type SettingValue = null | boolean | number | string | SettingValue[] | { [key: string]: SettingValue };

/** A JSON value as a definition writes it, readonly so a literal schema fits. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** A package's settings: one JSON Schema object, whose root has `type: "object"`. */
export type SettingsSchema = { readonly type: "object"; readonly [keyword: string]: JsonValue };

/** The settings of a package that declares none. */
type NoSettings = { readonly type: "object"; readonly additionalProperties: false };

/** A registry entry as a package adds it: any JSON object. */
export type RegistryEntry = { [field: string]: SettingValue };

/**
 * A registry handle: its id, which starts with the owning package's name and a dot, and the parser
 * that checks and normalizes every entry added to it. Handles match by id.
 */
export type Registry<Value extends RegistryEntry> = {
  readonly id: string;
  /** What makes a parsed entry unique: two entries with one key fail the run. Without it, equal entries are accepted. */
  key?(entry: Value): string;
  /** Where keys must be unique: across the registry (the default), or within each adding package's own entries. */
  readonly keyScope?: "office" | "package";
  parse(input: RegistryEntry): Value;
};

/**
 * An entry a command reads: the provider's parsed value, who added it, and where that package is.
 * Office supplies every field but `value` from the adding package, never from what it added.
 */
export type Entry<Value> = {
  value: Value;
  /** The adding package's name, or `office.yaml` for the office's own entries. */
  owner: string;
  /** The adding package's namespace, its name unless its definition sets one; `office.yaml` for the office's own entries. */
  namespace: string;
  /** The adding package's settings in this run, defaults applied; empty for the office's own entries. */
  settings: Readonly<Record<string, SettingValue>>;
  /** The folder the adding package was loaded from in this run: read its files here. It may be staged during sync. */
  folder: string;
  /**
   * The adding package's stable delivery folder: `packages/<name>/`
   * for a package of the office's own, `.office/packages/<name>/` for one sync pulls in; the
   * office's folder for office.yaml's entries. Build a link that must outlast this run from it.
   */
  root: string;
};

/** The office a command or lifecycle function runs in. */
export type OfficeInfo = {
  /** The office's folder, absolute. */
  readonly dir: string;
  /** Its name in office.yaml. */
  readonly name: string;
  /** Where its OpenCode runs: in its container, or on this machine, managed by office or not. */
  readonly mode: "host" | "managed-host" | "container";
  /** The command that runs office here: the executable, or a checkout's bin/office. For a script or a process a package starts. */
  readonly launcher: string;
};

/** A timer a package wants: `run` is the words after `office --office <dir>` its service runs. */
export type Timer = { id: string; calendar: string; run: readonly string[] };

/**
 * One of a package's installed timers: which of its two unit files are there, what the timer file
 * says and what systemd reports. With only the service there is no timer: never active, no calendar.
 */
export type TimerState = { id: string; files: "pair" | "timer" | "service"; active: boolean; calendar: string; persistent: boolean; next?: string; last?: string };

/** What a package may do on the host. */
export type Host = {
  /**
   * Its own systemd user timers, each named office-<office>-<package>-<id>, persistent, and run in
   * the environment an unattended run needs. Another package's, and any other unit, are out of reach.
   */
  timers: {
    /** Makes its timers equal the list: removes the others, writes and starts these. Throws in container mode. Returns the lines to print. */
    set(timers: readonly Timer[]): readonly string[];
    /** Removes all of its timers. Returns the lines to print. */
    clear(): readonly string[];
    /** What is installed for it, wanted or not, including a service left without its timer. Throws when systemd loaded one of its units from another file. */
    status(): readonly TimerState[];
  };
};

/** How `linkOpenCode` left an app: it declares no OpenCode account, was already linked, was linked to an existing account, or got a new one. */
export type OpenCodeLink = { outcome: "not-required" } | { outcome: "unchanged" | "linked" | "connected"; account: string };

/**
 * The office's Executor, reached through the runtime, which keeps its token and the OpenCode
 * password: a package never reads either, or the office's state folder.
 */
export type ExecutorAccess = {
  /**
   * An authenticated request to the office's Executor: `path` starts with `/`, such as
   * `/api/context`, and never names another address; a redirect is refused, not followed. Resolves
   * to the parsed JSON response, or null for an empty one. When Executor answers with an error
   * status, rejects with an Error naming the method, path and status, whose numeric `status`
   * property holds it; an Error without one means Executor wasn't reached or didn't answer within
   * `options.timeout` milliseconds (default five minutes).
   */
  request<Result = unknown>(method: string, path: string, body?: JsonValue, options?: { timeout?: number }): Promise<Result>;
  /** Where the office's OpenCode server is as Executor reaches it, for an app's generated modules. */
  readonly opencode: {
    /** Its origin from Executor's side, such as `http://opencode:4096`. */
    readonly url: string;
    /** The folder its sessions are under. */
    readonly directory: string;
    readonly mode: "host" | "container";
  };
  /**
   * Links the deployed app `slug` to the OpenCode account for the server's current host, when the app
   * declares one: reuses the account another app already links for that host, or connects one with
   * the office's server password. A check's access rejects it.
   */
  linkOpenCode(slug: string): Promise<OpenCodeLink>;
};

/** What a package's command, `up` and `check` get besides their lifecycle inputs: its Executor, absent when the runtime has none. */
export type ExecutorInputs = {
  /** Absent when the runtime has no Executor token: fail naming Executor if the package needs it. */
  readonly executor?: ExecutorAccess;
};

/** Returns a registry's entries, each with its owner and folder; every call returns its own copy. */
export type Entries = <Value extends RegistryEntry>(registry: Registry<Value>) => readonly Entry<Value>[];

/** What a package's `sync` and `check` get: the office, the registries to read, and its settings. */
export type Lifecycle<Settings = Readonly<Record<string, SettingValue>>> = {
  readonly office: OfficeInfo;
  readonly entries: Entries;
  readonly settings: Settings;
};

/** What a package's `sync`, `up` and its commands get: a way to change their own exclusions at once. */
export type ExclusionUpdate = {
  /**
   * Changes the office's Git exclude block now, not at the end of a whole sync: each office-relative
   * path in `remove` stops being excluded and each in `add` is excluded, literally; every other line
   * stays. Use a trailing slash in `add` to verify Git ignores a directory before it exists.
   * Throws if an addition cannot be kept out of Git. Returns one line per change.
   */
  updateExcluded(change: { add?: readonly string[]; remove?: readonly string[] }): readonly string[];
};

/** What a package's `sync` gets: also `exclude`, to keep what it placed for this machine out of commits. */
export type SyncInputs<Settings = Readonly<Record<string, SettingValue>>> = Lifecycle<Settings> & {
  /**
   * Office-relative paths this sync placed for this machine, such as links, which commits leave
   * out: sync names each one, literally, in the office's Git exclude block. Each call adds to this
   * sync's list; a path missing from it next sync stops being excluded.
   */
  exclude(paths: readonly string[]): void;
} & ExclusionUpdate;

/** How one item of a package's full-sync work ended: done, with an optional summary, or failed with the reason sync names. */
export type ItemResult = { ok: true; summary?: string } | { ok: false; reason: string };

/**
 * One item of a package's full-sync work, such as one checkout, which sync shows as a part of its
 * progress while `run` works. `output` shows a line of progress under the item. A failed result,
 * or a throw, names the package, the item and the reason, makes sync exit 1 and stops nothing else.
 */
export type SyncItem = {
  /** What the item is, unique within the package's list, such as `repos/notes`. */
  readonly item: string;
  run(output: (line: string) => void): ItemResult | Promise<ItemResult>;
};

/** What a package's `fullSync` and `session` get: the office and its settings. */
export type PackageInputs<Settings = Readonly<Record<string, SettingValue>>> = {
  readonly office: OfficeInfo;
  readonly settings: Settings;
};

/** What a package's `fullSync` gets: its inputs, and whether the sync shows full progress (`--verbose`), such as Git's progress meter, in its items' output. */
export type FullSyncInputs<Settings = Readonly<Record<string, SettingValue>>> = PackageInputs<Settings> & {
  readonly verbose: boolean;
};

/** A repository a package will read or push to, which `office setup` reads before cloning anything. */
export type AccessSource = {
  /** What it is within the package, for setup's messages, such as `source 2` or `notes`. */
  readonly name: string;
  /** Its URL, as Git clones it. */
  readonly url: string;
  /** `read-write` when the office pushes to it, so setup plans a login that can. */
  readonly access: "read" | "read-write";
};

/**
 * A package's access declaration: the module its package.json names in `office.access`, whose
 * default export is `Package.access(settings => [...])`. It runs before the package set exists,
 * on a fresh office included, so it imports only `@office/sdk` and the package's own files, and
 * parses the settings itself: they are office.yaml's, not yet checked against the schema.
 */
export type Access = (settings: Readonly<Record<string, SettingValue>>) => readonly AccessSource[];

/** What a package's `check` gets: also the host helpers, to read its timers. */
export type CheckInputs<Settings = Readonly<Record<string, SettingValue>>> = Lifecycle<Settings> & ExecutorInputs & { readonly host: Host };

/**
 * What a package's `up` gets: the office, the registries to read, its settings, the host helpers,
 * its Executor, and a way to change its own exclusions at once, which throws when the exclude block
 * can't be changed, so an up stops before placing what it would exclude.
 */
export type UpInputs<Settings = Readonly<Record<string, SettingValue>>> = Lifecycle<Settings> & ExecutorInputs & {
  readonly host: Host;
  /**
   * The folders of the runtimes (node, pnpm) for a tool the package runs: in a host-mode office those
   * the office's pinned mise resolves for the office, never PATH's; in a container-mode office the
   * first on PATH outside mise's shims and the image's Socket Firewall wrappers, read when called,
   * so call it only once the package knows it runs inside the office's container.
   */
  runtimes(): readonly string[];
} & ExclusionUpdate;

/** What a package's `down` gets: no registries, since `office down` runs no `setup`. */
export type DownInputs<Settings = Readonly<Record<string, SettingValue>>> = {
  readonly office: OfficeInfo;
  readonly settings: Settings;
  readonly host: Host;
};

/** A problem a package's `check` reports: a warning leaves `office check`'s exit status alone; a failure makes it 1. */
export type Problem = { level: "warning" | "failed"; message: string };

/**
 * What a command's handler gets: the office, the registries to read, its package's settings as
 * office.yaml has them now, and the words after the command's name, exactly as typed.
 */
export type CommandInputs<Settings = Readonly<Record<string, SettingValue>>> = Lifecycle<Settings> & ExecutorInputs & {
  readonly args: readonly string[];
  /**
   * Replaces one scalar that already exists in this package's own settings in office.yaml, such as
   * `["sources", 0, "ref"]`, keeping every other character of the file. Throws, writing nothing,
   * for a path outside its settings or to no scalar, or when office.yaml or the package's settings
   * schema would reject the result. Returns the settings as they now read.
   */
  replaceSetting(path: readonly (string | number)[], value: string | number | boolean): Settings;
} & ExclusionUpdate;

/**
 * A command a package declares under its name: `office <name>` runs it. It has one handler:
 * `result` returns the text `office` prints on standard output, or `run` acts with the terminal.
 */
export type Command<Settings = Readonly<Record<string, SettingValue>>> = {
  /** One line for `office --help`. */
  summary: string;
  /** What follows the name in help, such as `<path>`; the command parses its own `args`. */
  usage?: string;
  aliases?: readonly string[];
} & (
  | { result(inputs: CommandInputs<Settings>): string | Promise<string>; run?: never }
  | { run(inputs: CommandInputs<Settings>): void | Promise<void>; result?: never }
);

/** What `setup` gets: the package's validated settings, and the registries to register and add to. */
export type SetupContext<Settings = Readonly<Record<string, SettingValue>>> = {
  readonly settings: Settings;
  /** Registers a registry this package owns; its id starts with the package's name. */
  registry<Value extends RegistryEntry>(registry: Registry<Value>): void;
  /** Adds an entry to a registry, this package's or another's. */
  add<Value extends RegistryEntry>(registry: Registry<Value>, value: NoInfer<Value>): void;
  /** Which packages the office selects, without loading any of them. */
  readonly providers: {
    /**
     * Whether office.yaml selects the package `name`, as office.yaml names it (`executor`, not
     * `@office/executor`); a required built-in always is. A selected package that didn't load
     * still is: that is its own failure, never absence.
     */
    selected(name: string): boolean;
  };
};

// `ctx.settings` from the schema. The keywords below are left to the validator: a property using
// one is loosely typed, and a root using one makes the whole object loose. A loose object's keys
// may be absent; a list with `prefixItems` is a loose list; no declared settings means no keys.
type Unclear = "$ref" | "$dynamicRef" | "if" | "then" | "else" | "oneOf" | "anyOf" | "allOf" | "not";

type UnclearRoot = "$ref" | "$dynamicRef" | "oneOf" | "anyOf" | "allOf" | "not" | "patternProperties";

type Simplify<Fields> = { [Key in keyof Fields]: Fields[Key] } & {};

type Loose = { [key: string]: SettingValue | undefined };

type TypeValue<Type, Property> =
  Type extends readonly (infer Each)[] ? TypeValue<Each, Property>
    : Type extends "boolean" ? boolean
    : Type extends "integer" | "number" ? number
    : Type extends "string" ? string
    : Type extends "null" ? null
    : Type extends "array" ? Property extends { readonly prefixItems: JsonValue } ? SettingValue[] : Property extends { readonly items: infer Items } ? PropertyValue<Items>[] : SettingValue[]
    : Type extends "object" ? Property extends { readonly properties: object } ? ObjectValue<Property> : Loose
    : SettingValue;

type PropertyValue<Property> =
  [Extract<keyof Property, Unclear>] extends [never]
    ? Property extends { readonly enum: readonly (infer Choice)[] } ? Choice
      : Property extends { readonly type: infer Type } ? TypeValue<Type, Property>
      : SettingValue
    : SettingValue;

type RequiredKey<Schema> = Schema extends { readonly required: readonly (infer Key)[] } ? Key : never;

type PresentKey<Schema, Properties, Key extends keyof Properties> =
  Key extends RequiredKey<Schema> ? Key : Properties[Key] extends { readonly default: JsonValue } ? Key : never;

type ObjectValue<Schema extends { readonly properties: object }> = Schema["properties"] extends infer Properties
  ? Simplify<
    { readonly [Key in keyof Properties as PresentKey<Schema, Properties, Key>]: PropertyValue<Properties[Key]> } &
    { readonly [Key in keyof Properties as Exclude<Key, PresentKey<Schema, Properties, Key>>]?: PropertyValue<Properties[Key]> }
  >
  : Loose;

/** The type of `ctx.settings` for a settings schema. */
export type Settings<Schema> =
  [Extract<keyof Schema, UnclearRoot>] extends [never]
    ? Schema extends { readonly properties: object } ? ObjectValue<Schema>
      : Schema extends { readonly additionalProperties: false } ? Readonly<Record<never, never>>
      : Readonly<Loose>
    : Readonly<Loose>;

/**
 * What an integration's `setup` gets: its package's validated settings, and a way to add to the
 * provider's registries as its package. It decides from the settings whether to add anything.
 */
export type IntegrationContext<Settings = Readonly<Record<string, SettingValue>>> = Pick<SetupContext<Settings>, "settings" | "add">;

/** An integration module's default export: the setup office runs, as its package, once per gathering while its provider is selected. */
export type Integration<Settings = Readonly<Record<string, SettingValue>>> = {
  setup(ctx: IntegrationContext<Settings>): void | Promise<void>;
};

/** The type of `ctx.settings` of a definition, from its `typeof`. */
type DefinitionSettings<Parent> = Parent extends { readonly settings?: infer Schema } ? Settings<NonNullable<Schema>> : never;

type Secret = { generate: "hex" | "base64"; bytes: number; prefix?: string };

type HostBlock = {
  setting?: string;
  services?: { readonly [id: string]: { description: string; script: string; setting?: string } };
  tools?: { readonly [tool: string]: string };
  install?: { description: string; creates: string; script: string; executable?: boolean };
  path?: readonly string[];
  env?: { readonly [variable: string]: string | number | boolean };
};

type SystemBlock = {
  setting: string;
  description: string;
  platforms: readonly string[];
  prepare?: string;
  verify?: string;
  bootstrap: string;
  ready: readonly string[];
  env?: { readonly [variable: string]: string | number | boolean };
};

/** A package definition. Its name and description are in its package.json. */
export type Definition<Schema extends SettingsSchema = NoSettings> = {
  /** The settings it accepts, as one JSON Schema. Without it, it accepts none. */
  settings?: Schema;
  /** Its commands, by name. */
  commands?: { readonly [name: string]: Command<Settings<Schema>> };
  setup?(ctx: SetupContext<Settings<Schema>>): void | Promise<void>;
  /**
   * Runs at each sync that switches and applies the package set with every selected package loaded,
   * after every `setup`, in the order packages load. Returns the lines to print. A throw stops the sync.
   */
  sync?(inputs: SyncInputs<Settings<Schema>>): readonly string[] | void | Promise<readonly string[] | void>;
  /**
   * Runs only at a full `office sync` (and the sync `office setup` and `office refresh` run), after
   * that same sync admitted and applied the package set with every selected package loaded; never
   * at `office sync --packages` or `office packages update`. Returns its items, which run
   * alongside other packages' work: one item's failure is reported and the rest go on.
   */
  fullSync?(inputs: FullSyncInputs<Settings<Schema>>): readonly SyncItem[] | Promise<readonly SyncItem[]>;
  /**
   * Text every new OpenCode and Claude Code session in the office gets, from the settings the last
   * sync applied. Runs as each session starts, so it can describe files as they are then. Empty text adds nothing.
   */
  session?(inputs: PackageInputs<Settings<Schema>>): string | Promise<string>;
  /** Runs at `office check` with every selected package loaded, and only reports: it must not write. */
  check?(inputs: CheckInputs<Settings<Schema>>): readonly Problem[] | Promise<readonly Problem[]>;
  /**
   * Runs at the end of `office up`, after the office's own work, with every selected package loaded,
   * in the order packages load. Returns the lines to print. A throw stops the later ones.
   */
  up?(inputs: UpInputs<Settings<Schema>>): readonly string[] | void | Promise<readonly string[] | void>;
  /**
   * Runs at the start of `office down`, in a shutdown process of its own, with no `setup` run and no
   * registry to read: it undoes what the package itself installed. Returns the lines to print. The
   * office's own shutdown runs after it in the `office down` process, whatever happens here.
   */
  down?(inputs: DownInputs<Settings<Schema>>): readonly string[] | void | Promise<readonly string[] | void>;
  /** Folders directly under `.office/` that are committed, such as `.office/notes/`: sync leaves each out of its exclude block. */
  committed?: readonly string[];
  /** What its services, volumes and variables are named after, when that isn't its name. */
  namespace?: string;
  secrets?: { readonly [variable: string]: Secret };
  tools?: { readonly [tool: string]: string };
  host?: HostBlock;
  system?: SystemBlock;
  spawns?: { label: string };
};

/** Makes package definitions. */
export const Package = {
  /** A package definition, as its definition module's default export. `ctx.settings` is typed from `settings`. */
  define<const Schema extends SettingsSchema = NoSettings>(definition: Definition<Schema>): Definition<Schema> {
    return mark(definition);
  },
  /**
   * An integration module's default export, typed by its package's definition without loading it:
   * `Package.integration<typeof definition>()({ setup })` with `import type definition from "./office.ts"`.
   */
  integration<Parent extends { readonly settings?: SettingsSchema }>() {
    return (integration: Integration<DefinitionSettings<Parent>>): Integration<DefinitionSettings<Parent>> => markIntegration(integration);
  },
  /** An access declaration module's default export; see `Access`. */
  access(access: Access): Access {
    return markAccess(access);
  },
};

/** Makes registry handles. */
export const Registry = {
  /** A registry handle, for the owner to register in `setup` and for any package to add to. */
  define<Value extends RegistryEntry>(registry: Registry<Value>): Registry<Value> {
    return registry;
  },
};
