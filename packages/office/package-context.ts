// Type-only contract shipped beside the required office package. No consumer dependency install.
export type SettingValue = null | boolean | number | string | SettingValue[] | { [key: string]: SettingValue };

/** The opencode(ctx) collection callback owns both registrations, including an empty result. */
export type OpenCodeContext = {
  readonly settings: Readonly<Record<string, SettingValue>>;
  serverPlugin(directory: string): void;
  desktopPanel(bundle: string): void;
};

/** A collection of named JSON records. The defining package owns its parser and ID prefix. */
export type CollectionEntry = { name: string; [field: string]: SettingValue };

export type Collection<T extends CollectionEntry> = {
  readonly id: string;
  /** Package-local names permit independent contributors to register the same name. */
  readonly identity?: "package";
  /** Validate and normalize each incoming addition whenever packages load (sync, and every package command). Each read returns a copy of the result. */
  parse(input: CollectionEntry): T;
};

export type CommandInputs = {
  read<T extends CollectionEntry>(collection: Collection<T>): readonly { value: T; owner: string; stale: boolean }[];
};

export type PackageCommand = {
  name: string;
  aliases?: string[];
  summary: string;
  run(inputs: CommandInputs): void | Promise<void>;
};

export type PackageContext = {
  settings: Readonly<Record<string, SettingValue>>;
  command(command: PackageCommand): void;
  booleanSetting(name: string, definition: { description: string; default: boolean }): boolean;
  /** A scalar delivered to the package's settings file and native Compose environment. */
  scalarSetting(name: string, definition: { description: string; default: string | number | boolean }): string | number | boolean;
  collection<T extends CollectionEntry>(collection: Collection<T>): void;
  add<T extends CollectionEntry>(collection: Collection<T>, value: NoInfer<T>): void;
};

export type CronContext = {
  settings: Readonly<Record<string, SettingValue>>;
  cron: {
    readonly mode: "managed-host" | "host" | "container";
    /** false reserves an inapplicable job's override name without scheduling it. */
    job(localName: string, definition: { schedule: string; script: string } | false): void;
  };
};

export type RegisterCron = (ctx: CronContext) => undefined;
