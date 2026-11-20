// Type-only contract shipped beside the required office package. No consumer dependency install.
export type SettingValue = null | boolean | number | string | SettingValue[] | { [key: string]: SettingValue };

export type PackageContext = {
  settings: Readonly<Record<string, SettingValue>>;
  add(item: {
    registry: "references.repository";
    value: { name: string; url: string; ref?: string; description?: string };
  }): void;
};
