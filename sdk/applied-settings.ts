// The settings an office last applied, read from disk. `office sync` publishes every selected
// package's resolved settings in one snapshot per office; a plugin, script or bridge reads its own
// package's entry here, without loading package definitions, parsing office.yaml or reading secrets.
// It imports only Node built-ins and uses only erasable TypeScript, so Bun runs it as it is and a
// bundler takes it whole: `@office/sdk/applied-settings`. Node won't strip types under
// node_modules, so a plain Node reader bundles it or runs `office settings get`.
import { existsSync, type FSWatcher, lstatSync, readFileSync, realpathSync, watch } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { SettingValue } from "./index.ts";

/** Where an office keeps its applied settings, relative to the office's folder. Never committed. */
export const appliedSettingsPath = ".office/runtime/settings.json";

/** One package's applied settings: its office.yaml settings checked against its schema, with defaults applied. */
export type AppliedSettings = { [key: string]: SettingValue };

/**
 * Why a read failed: no snapshot yet, a snapshot that isn't one, no entry for the package, or a
 * snapshot reached through a link (`.office`, `.office/runtime` or the file itself), which could
 * be another office's.
 */
export type AppliedSettingsProblem = "missing-snapshot" | "malformed-snapshot" | "missing-package" | "redirected-snapshot";

export class AppliedSettingsError extends Error {
  readonly problem: AppliedSettingsProblem;
  /** The snapshot's absolute path. */
  readonly path: string;

  constructor(problem: AppliedSettingsProblem, path: string, message: string) {
    super(message);
    this.name = "AppliedSettingsError";
    this.problem = problem;
    this.path = path;
  }
}

/**
 * The snapshot of the office in `officeRoot`, absolute. Throws `redirected-snapshot` when
 * `.office` or `.office/runtime` is there but isn't a real folder, or the snapshot isn't a regular
 * file: the snapshot is only ever read or written in the office's own folders.
 */
export function appliedSettingsFile(officeRoot: string): string {
  const root = resolve(officeRoot);
  const file = join(root, appliedSettingsPath);

  for (const [path, wanted] of [[join(root, ".office"), "folder"], [dirname(file), "folder"], [file, "file"]] as const) {
    const info = lstatSync(path, { throwIfNoEntry: false });

    if (info !== undefined && !(wanted === "folder" ? info.isDirectory() : info.isFile())) {
      throw new AppliedSettingsError("redirected-snapshot", file, `${path} is a link or not a ${wanted === "folder" ? "folder" : "regular file"}, so the office's applied settings aren't read or written through it; move it aside and run office sync`);
    }
  }

  return file;
}

function isObject(value: unknown): value is AppliedSettings {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * JSON text for settings with every object's keys sorted, so equal settings give equal text
 * whatever order their keys were in; arrays keep their order, and numbers are compared as JSON
 * writes them (`-0` is `0`). Throws for a number JSON can't hold. Never changes `value`.
 */
export function canonicalJson(value: SettingValue, indent?: number): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "number" && !Number.isFinite(item)) throw new RangeError("a number JSON can't hold");

    return isObject(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
  }, indent);
}

/** Every package's entry in a snapshot's text; throws `malformed-snapshot` for text that isn't one. */
export function parseAppliedSnapshot(text: string, path: string): Map<string, AppliedSettings> {
  const malformed = (why: string) => new AppliedSettingsError("malformed-snapshot", path, `${path} is malformed: ${why}; run office sync to publish it again`);
  let document: unknown;

  // The parser's message quotes the text, which holds other packages' settings: it isn't repeated.
  try {
    document = JSON.parse(text);
  } catch {
    throw malformed("it isn't JSON");
  }

  if (!isObject(document) || !isObject(document.packages)) throw malformed(`it must be an object with a "packages" object`);
  const packages = new Map<string, AppliedSettings>();

  for (const [name, settings] of Object.entries(document.packages)) {
    if (!isObject(settings)) throw malformed(`package ${name}'s settings must be an object`);

    try {
      canonicalJson(settings);
    } catch {
      throw malformed(`package ${name}'s settings hold a number too large for JSON`);
    }

    packages.set(name, settings);
  }

  return packages;
}

/** Every package's applied settings in the office in `officeRoot`. Throws `missing-snapshot` before the office's first complete sync. */
export function readAppliedSnapshot(officeRoot: string): Map<string, AppliedSettings> {
  const path = appliedSettingsFile(officeRoot);
  let text: string;

  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;

    if (code === "ENOENT" || code === "ENOTDIR") throw new AppliedSettingsError("missing-snapshot", path, `no applied settings at ${path}; office sync publishes them once every selected package loads`);
    throw error;
  }

  return parseAppliedSnapshot(text, path);
}

/** One package's applied settings in the office in `officeRoot`. Throws `missing-package` when the last complete sync didn't select it. */
export function readAppliedSettings(officeRoot: string, packageName: string): AppliedSettings {
  const settings = readAppliedSnapshot(officeRoot).get(packageName);

  if (settings === undefined) throw new AppliedSettingsError("missing-package", appliedSettingsFile(officeRoot), `${appliedSettingsFile(officeRoot)} has no settings for package ${packageName}: the office's last complete sync didn't select it`);

  return settings;
}

/**
 * The office a package belongs to: the nearest folder above the package folder's real location
 * that holds an office.yaml, which isn't read. Pass a plugin or script its own folder, never the
 * process's working folder, which can be in another office or a repository nested in this one.
 */
export function officeRootOf(packageDir: string): string {
  const start = realpathSync(packageDir);

  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, "office.yaml"))) return dir;

    if (dirname(dir) === dir) throw new Error(`no office.yaml above ${start}`);
  }
}

export type AppliedSettingsWatch = {
  /** The package's settings when the watch started; undefined when they couldn't be read then, as before a sync applied any. */
  readonly settings: AppliedSettings | undefined;
  close(): void;
};

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * Watches one package's applied settings: the snapshot's folder, `.office/runtime/`, which sync
 * makes before it links any plugin, so a replacement by rename is seen. It starts watching before
 * it reads, so no sync is missed between the two. `onChange` gets the package's entry each time it
 * differs from the last one read: a sync that applies it for the first time, or changes it.
 * Another package's change, or the same values written again, calls nothing. A failed read, at
 * the start too, goes to `onError` and keeps the last settings, so an entry that comes back
 * unchanged calls nothing either. It never throws, and never writes: when the folder can't be
 * watched, or is reached through a link, `onError` says why and nothing more is reported.
 */
export function watchAppliedSettings(officeRoot: string, packageName: string, onChange: (settings: AppliedSettings) => void, onError: (error: Error) => void = () => {}): AppliedSettingsWatch {
  const folder = dirname(join(resolve(officeRoot), appliedSettingsPath));
  let last: string | undefined;

  const read = (): AppliedSettings | undefined => {
    try {
      return readAppliedSettings(officeRoot, packageName);
    } catch (error) {
      onError(asError(error));
    }
  };

  let watcher: FSWatcher;

  try {
    // Refused before watching: a redirected folder would report another office's writes.
    appliedSettingsFile(officeRoot);
  } catch (error) {
    onError(asError(error));

    return { settings: undefined, close: () => {} };
  }

  try {
    watcher = watch(folder, (_event, name) => {
      if (name !== null && name !== basename(appliedSettingsPath)) return;
      const next = read();

      if (next === undefined) return;
      const text = canonicalJson(next);

      if (text === last) return;
      last = text;
      onChange(next);
    });
  } catch (error) {
    onError(new Error(`can't watch ${folder} for package ${packageName}'s applied settings: ${asError(error).message}; office sync makes it`));

    return { settings: undefined, close: () => {} };
  }

  watcher.on("error", onError);
  const settings = read();

  if (settings !== undefined) last = canonicalJson(settings);

  return { settings, close: () => watcher.close() };
}
