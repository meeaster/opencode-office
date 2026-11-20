// Type-only contract shipped beside the required office package. No consumer dependency install.
export type SettingValue = null | boolean | number | string | SettingValue[] | { [key: string]: SettingValue };

/** The opencode(ctx) collection callback owns both registrations, including an empty result. */
export type OpenCodeContext = {
  readonly settings: Readonly<Record<string, SettingValue>>;
  serverPlugin(directory: string): void;
  desktopPanel(bundle: string): void;
};

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
  command(command: PackageCommand): void;
  add(item: {
    registry: "references.repository";
    value: { name: string; url: string; ref?: string; description?: string };
  }): void;
};
