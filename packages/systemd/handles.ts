// What other packages import: `systemd.userUnits.add`, which a package's `setup` calls to contribute
// a native systemd user unit. The unit's own text is authoritative for ExecStart, restart policy and
// dependencies: the package either ships the file or renders it once the office's and machine's facts
// are known, at `office up`, never during setup.
//
// `render` and `ready` are functions, which no registry entry can hold: `add` keeps them in a table
// of this process under a fresh token and adds the token. The process that runs office up finds them
// again through `userUnits.functions`, after its own setup ran; a token never outlives that process.
import { randomUUID } from "node:crypto";

import { type OfficeInfo, Registry, type RegistryEntry, type SetupContext } from "@office/sdk";

/** A tool a unit runs: the handle `tools.require` or `tools.provide` returned, described by its shape. */
export type UnitTool = { readonly name: string; readonly bin: readonly string[]; readonly minimum?: string };

/** What a rendered unit and its readiness probe can know about this office and machine. */
export type UnitFacts = {
  readonly office: OfficeInfo;
  /** The package's folder, as the office delivered it. */
  readonly dir: string;
  /**
   * The `Environment=` and `ExecStart=` lines that run a package script the way `host.services`
   * does: from the package's folder, with the office launcher and the verified machine environment.
   */
  launch(script: string): string;
  /** A stable path to an executable of a tool in `restartWhenChanged`, which keeps naming the activated release. */
  executable(tool: UnitTool, bin?: string): string;
};

/** Whether a started unit serves: its main process and the facts it was rendered with. */
export type Ready = (probe: { readonly pid: number; readonly facts: UnitFacts }) => boolean | Promise<boolean>;

type Source = { file: string; render?: never } | { render: (facts: UnitFacts) => string; file?: never };

/**
 * What a package's `setup` passes to `systemd.userUnits.add`. The unit is installed as
 * `office-<office>-pkg-<package>.<id>.service`. `restartWhenChanged` names the tools and package
 * files the running process depends on: a change to any of them restarts it without rewriting the
 * unit. `ready` decides when a started unit serves; until it returns true the unit isn't ready.
 */
export type UserUnitOptions = Source & { id: string; restartWhenChanged?: UnitTool | string | readonly (UnitTool | string)[]; ready?: Ready };

/** A tool a unit depends on, as registered. */
export type UnitToolClaim = { name: string; bin: string[]; minimum?: string };

/** A unit as registered: its source (a package file, or the token of its renderer), what restarts it, and the token of its probe. */
export type UserUnit = { id: string; file?: string; render?: string; tools: UnitToolClaim[]; files: string[]; ready?: string };

type Functions = { render?: (facts: UnitFacts) => string; ready?: Ready };

// One table per process, whichever copy of this module a package's import reached.
declare global {
  var officeUserUnitFunctions: Map<string, Functions> | undefined;
}

const functions = (globalThis.officeUserUnitFunctions ??= new Map<string, Functions>());

const unitId = /^[a-z0-9][a-z0-9-]{0,47}$/;
const packageFile = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/;

function text(value: RegistryEntry[string] | undefined): value is string {
  return typeof value === "string";
}

function filePath(value: RegistryEntry[string] | undefined, what: string): string {
  if (!text(value) || !packageFile.test(value) || value.split("/").includes("..")) throw new Error(`${what} must be a relative path to a file in the package, such as units/greeter.service`);

  return value;
}

function toolClaim(value: RegistryEntry[string], what: string): UnitToolClaim {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${what}: each tool must be the handle tools.require or tools.provide returned`);
  const { name, bin, minimum } = value;
  const names = Array.isArray(bin) ? bin.filter(text) : [];

  if (!text(name) || !Array.isArray(bin) || names.length === 0 || names.length !== bin.length || (minimum !== undefined && !text(minimum))) throw new Error(`${what}: each tool must be the handle tools.require or tools.provide returned`);

  return minimum === undefined ? { name, bin: names } : { name, bin: names, minimum };
}

function token(value: RegistryEntry[string] | undefined, key: "render" | "ready", what: string): string | undefined {
  if (value === undefined) return undefined;

  if (!text(value) || functions.get(value)?.[key] === undefined) throw new Error(`${what}: ${key} must be the function given to systemd.userUnits.add`);

  return value;
}

function parse(input: RegistryEntry): UserUnit {
  const { id, file, render, tools, files, ready } = input;
  const what = `user unit ${text(id) ? id : "(unnamed)"}`;
  const unknown = Object.keys(input).filter(key => !["id", "file", "render", "tools", "files", "ready"].includes(key));

  if (unknown.length) throw new Error(`${what}: unknown key ${unknown.join(", ")}; it has id, file or render, tools, files and ready`);

  if (!text(id) || !unitId.test(id)) throw new Error(`${what}: id must be lowercase letters, digits and dashes, at most 48 characters`);

  if ((file === undefined) === (render === undefined)) throw new Error(`${what}: give either file, the unit's file in the package, or render`);

  if (!Array.isArray(tools) || !Array.isArray(files)) throw new Error(`${what}: tools and files must be lists`);
  const unit: UserUnit = { id, tools: tools.map(tool => toolClaim(tool, what)), files: files.map(path => filePath(path, `${what}: restartWhenChanged`)) };
  const renderer = token(render, "render", what);
  const probe = token(ready, "ready", what);

  if (file !== undefined) unit.file = filePath(file, `${what}: file`);

  if (renderer !== undefined) unit.render = renderer;

  if (probe !== undefined) unit.ready = probe;

  return unit;
}

const registry = Registry.define<UserUnit>({ id: "systemd.user-units", key: entry => entry.id, keyScope: "package", parse });

/** The user units registry, and the functions `add` kept for a token in this process. */
export const userUnits = {
  ...registry,
  functions(token: string): Functions | undefined {
    return functions.get(token);
  },
};

/** Declares native units from a package's `setup`. */
export const systemd = {
  userUnits: {
    ...userUnits,
    /** Declares one native user unit of the calling package. */
    add(ctx: Pick<SetupContext, "add">, options: UserUnitOptions): void {
      const dependencies = options.restartWhenChanged === undefined ? [] : [options.restartWhenChanged].flat();
      const tools: UnitToolClaim[] = [];
      const files: string[] = [];

      for (const item of dependencies) {
        if (typeof item === "string") files.push(item);
        else tools.push(item.minimum === undefined ? { name: item.name, bin: [...item.bin] } : { name: item.name, bin: [...item.bin], minimum: item.minimum });
      }

      const entry: UserUnit = { id: options.id, tools, files };

      if (options.file !== undefined) entry.file = options.file;

      if (options.render !== undefined || options.ready !== undefined) {
        const key = randomUUID();

        functions.set(key, { render: options.render, ready: options.ready });

        if (options.render !== undefined) entry.render = key;

        if (options.ready !== undefined) entry.ready = key;
      }

      ctx.add(registry, entry);
    },
  },
};
