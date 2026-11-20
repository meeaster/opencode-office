// Type-only contract shipped beside the required office package. No consumer dependency install.
export type SettingValue = null | boolean | number | string | SettingValue[] | { [key: string]: SettingValue };

export type CommandInputs = {
  references: readonly { name: string; url: string; ref?: string; description?: string; owner: string; stale: boolean }[];
};

export type PackageCommand = {
  name: string;
  aliases?: string[];
  summary: string;
  run(inputs: CommandInputs): void | Promise<void>;
};

export type PackageContext = {
  settings: Readonly<Record<string, SettingValue>>;
  cron: {
    /** Defined only while this package's synchronous cron declarations are being read. */
    readonly mode: "managed-host" | "host" | "container" | undefined;
    /** false reserves an inapplicable job's override name without scheduling it. */
    job(localName: string, definition: { schedule: string; script: string } | false): void;
  };
  command(command: PackageCommand): void;
  add(item: {
    registry: "references.repository";
    value: { name: string; url: string; ref?: string; description?: string };
  }): void;
};
