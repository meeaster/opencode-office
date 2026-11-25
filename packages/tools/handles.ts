// What other packages import: `tools.require` for a tool mise installs by its own backends, and
// `tools.provide` for one a package installs itself. Each returns a handle that names the tool; the
// office resolves one exact release per tool, which every handle of that tool shares.
//
// A provider's `releases` is a function, which no registry entry can hold: `provide` keeps it in
// a table of this process under a fresh token and adds the token. The office reads it back through
// the providers registry this package registered (`providers.releases`), in the process that ran
// setup.
import { randomUUID } from "node:crypto";

import { Registry, type RegistryEntry, type SetupContext } from "@office/sdk";

/**
 * A tool a package needs: a mise registry short name such as `bun`, or a backend-qualified name
 * such as `npm:@fission-ai/openspec`, at least `minimum`, the exact version the package was tested
 * with. `bin` names each executable it exposes. A `hostOnly` requirement applies only where OpenCode
 * runs on the host.
 */
export type Requirement = { name: string; minimum: string; bin: string[]; hostOnly?: boolean };

/**
 * One release a provider lists: its exact version, when it was published (ISO 8601 with a time zone,
 * such as 2026-11-20T08:00:00Z), and the SHA-256 (`sha256:<hex>`) of each executable it stages.
 */
export type Release = { version: string; published: string; digests: Readonly<Record<string, string>> };

/** A provider's trusted list of its releases, which the office checks a staged version against. */
export type Releases = () => readonly Release[] | Promise<readonly Release[]>;

/** A package's own native mise task, as `mise.task` from `@office/mise-integration/claims` names it. */
export type TaskBinding = { task: string };

/**
 * A tool a package installs itself: its exact version is the package's setting `versionSetting`,
 * `install` is the package's own mise task that stages that version, and `releases` the token of
 * its release list in this module.
 */
export type Provision = { name: string; versionSetting: string; install: TaskBinding; releases: string; bin: string[] };

/**
 * What `tools.require` and `tools.provide` return: the tool, before or after any install, with the
 * minimum a requirement needs. A script or plugin resolves it to the applied executable with
 * `resolveTool` from `@office/tools/applied`.
 */
export type ToolHandle = { readonly name: string; readonly bin: readonly string[]; readonly minimum?: string };

const toolName = /^[A-Za-z0-9_.:@/-]+$/;
const exactVersion = /^v?\d+(?:\.\d+)+(?:[-+][0-9A-Za-z.-]+)?$/;
const executable = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

function fieldsOf(input: RegistryEntry, allowed: readonly string[], what: string): void {
  const unknown = Object.keys(input).filter(key => !allowed.includes(key));

  if (unknown.length) throw new Error(`${what}: unknown key ${unknown.join(", ")}; it has ${allowed.join(", ")}`);
}

function named(name: RegistryEntry[string], what: string): string {
  if (typeof name !== "string" || !toolName.test(name)) throw new Error(`${what} needs a mise tool name, such as bun or npm:@fission-ai/openspec`);

  return name;
}

function executables(bin: RegistryEntry[string], what: string): string[] {
  const names = typeof bin === "string" ? [bin] : bin;
  const valid = Array.isArray(names) ? names.filter((item): item is string => typeof item === "string" && executable.test(item)) : [];

  if (!Array.isArray(names) || valid.length === 0 || valid.length !== names.length) throw new Error(`${what}: bin must name each executable it exposes, such as "openspec"`);

  return [...new Set(valid)];
}

const requirements = Registry.define<Requirement>({
  id: "tools.requirements",
  key: entry => entry.name,
  keyScope: "package",
  parse(input: RegistryEntry): Requirement {
    const name = named(input.name, "a tool requirement");
    const what = `tool requirement ${name}`;
    const { minimum, hostOnly } = input;

    fieldsOf(input, ["name", "minimum", "bin", "hostOnly"], what);

    if (typeof minimum !== "string" || !exactVersion.test(minimum)) throw new Error(`${what}: minimum must be the exact version the package was tested with, such as 2.1.0`);

    if (hostOnly !== undefined && typeof hostOnly !== "boolean") throw new Error(`${what}: hostOnly must be true or false`);
    const requirement: Requirement = { name, minimum, bin: executables(input.bin, what) };

    if (hostOnly) requirement.hostOnly = true;

    return requirement;
  },
});

// One table per process, whichever copy of this module a package's import reached: a process
// that isn't bound to a package set can load the module once for the registry's owner and once
// for a package that imports it.
declare global {
  var officeToolReleases: Map<string, Releases> | undefined;
}

const releaseLists = (globalThis.officeToolReleases ??= new Map<string, Releases>());

function taskBinding(install: RegistryEntry[string], what: string): TaskBinding {
  const task = install !== null && typeof install === "object" && !Array.isArray(install) && Object.keys(install).length === 1 ? install.task : undefined;

  if (typeof task !== "string" || !/^[a-z][a-z0-9:_-]*$/.test(task)) throw new Error(`${what}: install must be mise.task("<name>"), the package's own mise task that stages the version`);

  return { task };
}

const providers = {
  ...Registry.define<Provision>({
    id: "tools.providers",
    key: entry => entry.name,
    parse(input: RegistryEntry): Provision {
      const name = named(input.name, "a tool provider");
      const what = `tool provider ${name}`;
      const { versionSetting, releases } = input;

      fieldsOf(input, ["name", "versionSetting", "install", "releases", "bin"], what);

      if (typeof versionSetting !== "string" || versionSetting === "") throw new Error(`${what}: versionSetting must name the package setting that holds its exact version`);

      if (typeof releases !== "string" || !releaseLists.has(releases)) throw new Error(`${what}: releases must be the function that lists its releases, given to tools.provide`);

      return { name, versionSetting, install: taskBinding(input.install, what), releases, bin: executables(input.bin, what) };
    },
  }),
  /** The release list `tools.provide` was given under `token`, in this process. */
  releases(token: string): Releases | undefined {
    return releaseLists.get(token);
  },
};

function handle(name: string, bin: readonly string[], minimum?: string): ToolHandle {
  return Object.freeze(minimum === undefined ? { name, bin: Object.freeze([...bin]) } : { name, bin: Object.freeze([...bin]), minimum });
}

/** What a package's `setup` passes to `tools.require`; `bin` is one executable or a list. */
export type RequireOptions = { name: string; minimum: string; bin: string | string[]; hostOnly?: boolean };

/** What a package's `setup` passes to `tools.provide`. */
export type ProvideOptions = { name: string; versionSetting: string; install: TaskBinding; releases: Releases; bin: string | string[] };

/** The tools registries, with `require` and `provide`, which a package calls from its `setup`. */
export const tools = {
  requirements,
  providers,
  /** Declares a tool mise installs through its own backend; no package registers releases or an installer for it. */
  require(ctx: Pick<SetupContext, "add">, options: RequireOptions): ToolHandle {
    const bin = [options.bin].flat();

    ctx.add(requirements, { ...options, bin });

    return handle(options.name, bin, options.minimum);
  },
  /** Declares the one custom installation of a tool, which this package's task stages at the version its setting holds. */
  provide(ctx: Pick<SetupContext, "add">, options: ProvideOptions): ToolHandle {
    const bin = [options.bin].flat();
    const token = randomUUID();

    releaseLists.set(token, options.releases);
    ctx.add(providers, { name: options.name, versionSetting: options.versionSetting, install: { task: options.install.task }, releases: token, bin });

    return handle(options.name, bin);
  },
};
