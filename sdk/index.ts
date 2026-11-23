// @office/sdk: what a package imports to be an office package. A package's definition is
// `export default Package.define({...})`; a registry handle is `Registry.define({...})`.
//
// The office executable registers its own copy of this module under the name `@office/sdk` before
// it loads a definition, so a package always gets that copy, whatever is on disk. The copy sync
// writes beside an office's packages gives editors and tsc these types; loading it throws.
// Named exports only: there is no default export.
import { mark } from "./mark.ts";

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

/** An entry a command reads: the provider's parsed value, who added it, and the folder that package was loaded from. */
export type Entry<Value> = {
  value: Value;
  /** The adding package's name, or `office.yaml` for the office's own entries. */
  owner: string;
  folder: string;
};

/** What a command's handler gets: the registries to read, and its package's settings as office.yaml has them now. */
export type CommandInputs<Settings = Readonly<Record<string, SettingValue>>> = {
  read<Value extends RegistryEntry>(registry: Registry<Value>): readonly Entry<Value>[];
  readonly settings: Settings;
};

/** A command a package declares under its name: `office <name>` runs it. */
export type Command<Settings = Readonly<Record<string, SettingValue>>> = {
  /** One line for `office --help`. */
  summary: string;
  aliases?: readonly string[];
  run(inputs: CommandInputs<Settings>): void | Promise<void>;
};

/** What `setup` gets: the package's validated settings, and the registries to register and add to. */
export type SetupContext<Settings = Readonly<Record<string, SettingValue>>> = {
  readonly settings: Settings;
  /** Registers a registry this package owns; its id starts with the package's name. */
  registry<Value extends RegistryEntry>(registry: Registry<Value>): void;
  /** Adds an entry to a registry, this package's or another's. */
  add<Value extends RegistryEntry>(registry: Registry<Value>, value: NoInfer<Value>): void;
};

/** Transitional, until agents are a registry: what `opencode(ctx)` registers. */
export type OpenCodeContext = {
  readonly settings: Readonly<Record<string, SettingValue>>;
  serverPlugin(directory: string): void;
  desktopPanel(bundle: string): void;
};

/** Transitional, until cron is a registry: what `registerCron(ctx)` gets. */
export type CronContext = {
  settings: Readonly<Record<string, SettingValue>>;
  cron: {
    readonly mode: "managed-host" | "host" | "container";
    /** false reserves an inapplicable job's override name without scheduling it. */
    job(localName: string, definition: { schedule: string; script: string } | false): void;
  };
};

/** Transitional, until cron is a registry. */
export type RegisterCron = (ctx: CronContext) => undefined;

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

type Secret = { generate: "hex" | "base64"; bytes: number; prefix?: string };

type Job = { schedule: string; script: string; when?: "managed-host" | "host" | "container" };

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
  /** What its services, volumes and variables are named after, when that isn't its name. */
  namespace?: string;
  secrets?: { readonly [variable: string]: Secret };
  tools?: { readonly [tool: string]: string };
  host?: HostBlock;
  system?: SystemBlock;
  cron?: { readonly [job: string]: Job };
  registerCron?: RegisterCron;
  opencode?(ctx: OpenCodeContext): void;
  executor_app?: { setting?: string };
  spawns?: { label: string };
};

/** Makes package definitions. */
export const Package = {
  /** A package definition, as its definition module's default export. `ctx.settings` is typed from `settings`. */
  define<const Schema extends SettingsSchema = NoSettings>(definition: Definition<Schema>): Definition<Schema> {
    return mark(definition);
  },
};

/** Makes registry handles. */
export const Registry = {
  /** A registry handle, for the owner to register in `setup` and for any package to add to. */
  define<Value extends RegistryEntry>(registry: Registry<Value>): Registry<Value> {
    return registry;
  },
};
