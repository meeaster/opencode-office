import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as v from "valibot";

import { appliedSettingsPath } from "../../../../sdk/applied-settings.ts";
import type { Registry, RegistryEntry } from "../../../../sdk/index.ts";
import { mise } from "../../../../packages/mise-integration/claims.ts";
import { tools } from "../../../../packages/tools/handles.ts";
import { withoutTools } from "../../mise-integration/delivery.ts";
import { admitTools } from "../admission.ts";
import { parseRegistry } from "../registry.ts";
import { effectiveAge, type PlanningEnvironment, planningToml, type Run } from "../selection.ts";
import { reservedWord } from "../../../command-table.ts";
import { bump } from "../../../commands/bump.ts";
import { gatherPackages } from "../../../gather.ts";
import { miseShims } from "../../host/host-env.ts";
import { globalConfD, grantConsent, machineRecordPath } from "../../host/machine.ts";
import { loadOffice } from "../../../office.ts";
import { syncLines as sync } from "../../../../test/support/sync.fixture.ts";
import { applyOfficeTools, definitionText, isOfficeTool, officePlan, officeTools, sharedToolsLock, writePackage } from "../../../../test/support/test-package.ts";
import { lockSections, readLockText } from "../../../versions.ts";

let dir: string;

let office: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-shared-tools-"));
  office = join(dir, "office");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

const openspec = "npm:@fission-ai/openspec";

/** A local package whose setup runs `body` with `tools` imported; `settings` is its settings schema's source, if any. */
function toolPackage(name: string, body: string, settings = ""): void {
  writePackage(join(office, `packages/${name}/office.ts`), definitionText(`{${settings ? `settings:${settings},` : ""}setup(ctx){${body}}}`, 'import { tools } from "@office/tools";'), { dependencies: ["tools"] });
}

function requires(name: string, tool: string, minimum: string, bin: string | string[] = "openspec", hostOnly = false): void {
  toolPackage(name, `tools.require(ctx,{name:${JSON.stringify(tool)},minimum:${JSON.stringify(minimum)},bin:${JSON.stringify(bin)}${hostOnly ? ",hostOnly:true" : ""}})`);
}

function provides(name: string, tool: string, version: string, bin: string): void {
  toolPackage(name, `tools.provide(ctx,{name:${JSON.stringify(tool)},versionSetting:"version",install:{task:"stage"},releases:()=>[],bin:${JSON.stringify(bin)}})`, `{type:"object",additionalProperties:false,properties:{version:{type:"string",default:${JSON.stringify(version)}}}}`);
}

/** office.yaml selecting each entry (`name`, or `name, <more keys>`), in a host-mode office with a three-day age. */
function select(...entries: string[]): void {
  write(join(office, "office.yaml"), `name: t\nstate: ./state\nopencode: {mode: host, url: 'http://127.0.0.1:49999'}\nminimum_release_age: 3d\npackages: [${entries.map(entry => `{name: ${entry}}`).join(", ")}]\n`);
}

const run = () => sync(loadOffice(office), { scope: "packages" });

/** Publishes an empty package set first: from source, a local package resolves its @office imports through it, by a link in packages/. */
async function published(): Promise<void> {
  mkdirSync(join(office, "packages"), { recursive: true });
  select();
  write(join(office, "office.lock"), sharedToolsLock());
  applyOfficeTools(loadOffice(office).state);
  grantConsent(loadOffice(office));
  await run();
}

async function loaded() {
  const config = loadOffice(office);
  const gathered = await gatherPackages(config, { machine: true });

  return { config, gathered };
}

function readIf(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/** What a rejected sync or a selection must leave alone: the active generation, applied settings, machine files and the global mise links; office.lock unless `lock` is false. */
function snapshot({ lock = true } = {}) {
  const conf = globalConfD();

  return {
    current: readlinkSync(join(office, ".office/current")),
    settings: readIf(join(office, appliedSettingsPath)),
    lock: lock ? readIf(join(office, "office.lock")) : undefined,
    packages: readIf(join(office, "machine.packages.toml")),
    machine: readIf(join(office, "machine.toml")),
    record: readIf(machineRecordPath()),
    links: existsSync(conf) ? readdirSync(conf).map(name => [name, readlinkSync(join(conf, name))]) : [],
  };
}

type Call = { argv: readonly string[]; env: PlanningEnvironment; cwd: string; plan?: string };

type FakeMise = { stderr?: string; status?: number; releases?: Readonly<Record<string, string>> };

/**
 * A fake mise: `ls-remote <tool> <prefix>` lists `releases[tool]`, and the planning dry run answers
 * `stdout` and `stderr`; anything else fails; it records each call and the file it saw.
 */
function fakeMise(stdout: string, { stderr = "", status = 0, releases = {} }: FakeMise = {}) {
  const calls: Call[] = [];

  const runner: Run = (argv, { cwd, env }) => {
    const at = argv.indexOf("ls-remote");

    if (at >= 0) {
      calls.push({ argv, env, cwd });

      return { status: 0, stdout: releases[argv[at + 1]] ?? "", stderr: "" };
    }

    calls.push({ argv, env, cwd, plan: readFileSync(join(cwd, "mise.toml"), "utf8") });

    if (!argv.includes("upgrade")) return { status: 1, stdout: "", stderr: `mise ERROR unexpected ${argv.join(" ")}` };

    // The office package's tools are always planned, at the floors office.lock records.
    return { status, stdout: `${officePlan}${stdout}`, stderr };
  };

  return { runner, calls };
}

const lockedTools = () => {
  const read = lockSections(readLockText(office)).tools;

  if (!read.ok) throw read.error;

  // The office package's tools stay as the fixture recorded them.
  return Object.fromEntries([...read.value].filter(([tool]) => !isOfficeTool(tool)));
};

test("a handle names its tool and executables; a requirement needs a tested exact minimum and its executables", () => {
  const added: RegistryEntry[] = [];
  const ctx = { add: (_registry: Registry<RegistryEntry>, value: RegistryEntry) => added.push(value) };

  expect(tools.require(ctx, { name: openspec, minimum: "2.1.0", bin: "openspec" })).toEqual({ name: openspec, bin: ["openspec"], minimum: "2.1.0" });
  const listed = [{ version: "1.0.0", published: "2026-11-01T00:00:00Z", digests: { widget: `sha256:${"a".repeat(64)}` } }];

  expect(tools.provide(ctx, { name: "widget", versionSetting: "version", install: mise.task("stage-widget"), releases: () => listed, bin: ["widget", "widgetd"] })).toEqual({ name: "widget", bin: ["widget", "widgetd"] });
  const [, provision] = added;

  // The release list stays in this process: the entry holds only its token, which the providers handle reads back.
  expect(provision).toEqual({ name: "widget", versionSetting: "version", install: { task: "stage-widget" }, releases: expect.any(String), bin: ["widget", "widgetd"] });
  expect(tools.providers.parse(provision).install).toEqual({ task: "stage-widget" });
  expect(tools.providers.releases(String(provision.releases))?.()).toBe(listed);
  expect(() => tools.providers.parse({ ...provision, releases: "forged" })).toThrow("releases must be the function that lists its releases");
  expect(() => tools.providers.parse({ ...provision, install: "stage-widget" })).toThrow('install must be mise.task("<name>")');

  const invalid: [RegistryEntry, string][] = [
    [{ name: openspec, minimum: "latest", bin: ["openspec"] }, "minimum must be the exact version"],
    [{ name: openspec, minimum: "2", bin: ["openspec"] }, "minimum must be the exact version"],
    [{ name: openspec, minimum: "2.1.0", bin: [] }, "bin must name each executable"],
    [{ name: openspec, minimum: "2.1.0", bin: ["../openspec"] }, "bin must name each executable"],
    [{ name: openspec, minimum: "2.1.0", bin: ["openspec"], releases: "npm" }, "unknown key releases"],
  ];

  for (const [entry, message] of invalid) expect(() => tools.requirements.parse(entry)).toThrow(message);
});

test("mise's registry names a short name's or an alias's first backend; a backend-qualified name stands for itself", () => {
  const registry = parseRegistry(JSON.stringify([
    { short: "aws-cli", backends: ["aqua:aws/aws-cli", "asdf:MetricMike/asdf-awscli"], aliases: ["aws", "awscli"] },
    { short: "bun", backends: ["core:bun"] },
    { short: "aws", backends: ["aqua:other/aws"] },
  ]));

  expect([...registry]).toEqual([["aws-cli", "aqua:aws/aws-cli"], ["bun", "core:bun"], ["aws", "aqua:other/aws"], ["awscli", "aqua:aws/aws-cli"]]);
});

test("two packages requiring one npm tool share one demand at the higher minimum, with no provider and nothing written to the active mise files", async () => {
  await published();
  requires("alpha", openspec, "2.0.0");
  requires("beta", openspec, "2.1.0");
  select("alpha", "beta");

  expect((await run()).join("\n")).not.toContain("FAILED");
  const { config, gathered } = await loaded();
  expect(gathered.complete).toBe(true);
  expect([...admitTools(config, gathered.packages).demands.values()].filter(demand => !isOfficeTool(demand.name))).toEqual([{ name: openspec, floor: "2.1.0", consumers: [{ package: "alpha", name: openspec, minimum: "2.0.0" }, { package: "beta", name: openspec, minimum: "2.1.0" }], bin: ["openspec"] }]);
  expect(gathered.entries(tools.providers)).toEqual([]);
  // Desired releases are office.lock's; machine.packages.toml, linked into mise, doesn't get them.
  expect(readIf(join(office, "machine.packages.toml")) ?? "").not.toContain(openspec);
});

test("a short name, its aliases and its backend are one tool: one floor, every executable, every consumer, and machine.toml's pin under any of them", async () => {
  await published();
  requires("alpha", "bun", "1.4.4", "bun");
  requires("beta", "core:bun", "1.5.0", ["bun", "bunx"]);
  requires("gamma", "aws", "2.40.0", "aws");
  requires("delta", "aqua:aws/aws-cli", "2.41.0", ["aws", "aws_completer"]);
  select("alpha", "beta", "gamma", "delta");
  write(join(office, "machine.toml"), '[tools]\n"core:bun" = "1.5.2"\nnode = "lts"\nzig = ["0.17.1", "0.15.2"]\n');
  expect((await run()).join("\n")).not.toContain("FAILED");

  const { config, gathered } = await loaded();
  const admission = admitTools(config, gathered.packages);

  expect(admission.problems).toEqual([]);
  expect([...admission.demands.values()].filter(demand => !isOfficeTool(demand.name))).toEqual([
    { name: "core:bun", floor: "1.5.0", consumers: [{ package: "alpha", name: "bun", minimum: "1.4.4" }, { package: "beta", name: "core:bun", minimum: "1.5.0" }], bin: ["bun", "bunx"] },
    { name: "aqua:aws/aws-cli", floor: "2.41.0", consumers: [{ package: "delta", name: "aqua:aws/aws-cli", minimum: "2.41.0" }, { package: "gamma", name: "aws", minimum: "2.40.0" }], bin: ["aws", "aws_completer"] },
  ]);
  // The owner's other entries, not one exact version, are no tool's hold and stay as written.
  expect([...admission.holds]).toEqual([["core:bun", { key: "core:bun", version: "1.5.2" }]]);
  expect(readFileSync(join(office, "machine.toml"), "utf8")).toContain('node = "lts"');
});

/** Arranges each case, syncs, and checks it is refused before publication with `message`, leaving everything as `before` but machine.toml; up's gathering refuses too. */
async function refused(cases: [() => void, string[], string][]) {
  await published();
  requires("alpha", "bun", "1.4.4", "bun");
  select("alpha");
  expect((await run()).join("\n")).not.toContain("FAILED");
  const before = snapshot();

  for (const [arrange, selected, message] of cases) {
    arrange();
    select(...selected);
    const output = (await run()).join("\n");

    expect(output).toContain(message);
    expect(output).toContain("no package set was published");
    expect(snapshot()).toEqual({ ...before, machine: readIf(join(office, "machine.toml")) });
    // up gathers first and starts nothing while gathering has a problem (src/commands/compose.ts).
    const { gathered } = await loaded();
    expect(gathered.complete).toBe(false);
    expect(gathered.problems.map(problem => problem.message)).toContain(message);
    rmSync(join(office, "machine.toml"), { force: true });
  }
}

// Each case has packages of its own: this process caches a definition module by its path.
test("a conflicting package claim is refused before publication, naming both parties, and sync and up change nothing", async () => {
  await refused([
    [() => { provides("beta", "widget", "1.0.0", "widget"); provides("gamma", "widget", "1.0.0", "widgetd"); }, ["alpha", "beta", "gamma"], "tools.providers widget claimed by both package beta and package gamma"],
    [() => requires("delta", "npm:bun", "1.0.0", "bun"), ["alpha", "delta"], "executable bun is claimed by tool core:bun (package alpha) and tool npm:bun (package delta)"],
    [() => { provides("epsilon", openspec, "2.0.0", "openspec"); requires("zeta", openspec, "2.1.0"); }, ["alpha", "epsilon", "zeta"], "package epsilon provides tool npm:@fission-ai/openspec 2.0.0 (its setting version), below the 2.1.0 package zeta needs"],
    [() => requires("eta", "no-such-tool-in-the-registry", "1.0.0", "nst"), ["alpha", "eta"], "package eta requires tool no-such-tool-in-the-registry, which mise's registry doesn't name; require it by its backend-qualified name, such as npm:<package>"],
    // A consumer of a provided tool can only get what its provider stages.
    [() => { provides("theta", "widget", "1.0.0", "widget"); requires("iota", "widget", "1.0.0", "widgetctl"); }, ["alpha", "theta", "iota"], "package iota requires executable widgetctl of tool widget, which package theta provides without it (it stages widget)"],
    // The older route would install the same bun a second way, through machine.packages.toml.
    [() => writePackage(join(office, "packages/kappa/office.ts"), definitionText('{setup(ctx){ctx.add(requirements,{name:"bun",minimumVersion:"1.4.4"})}}', 'import { requirements } from "@office/tooling/requirements";'), { dependencies: ["tooling"] }), ["alpha", "kappa"], "package kappa declares tool bun through @office/tooling, which machine.packages.toml installs, and package alpha requires it as core:bun through @office/tools: declare it one way, with tools.require"],
  ]);
});

test("machine.toml's entry for a required tool, under any of its names, must be one exact version at or above every minimum, once", async () => {
  const machine = (text: string) => () => write(join(office, "machine.toml"), text);
  const not = (shown: string) => `machine.toml gives tool bun ${shown}, which isn't one exact version, and package alpha requires it as core:bun: pin one exact version there, or remove the entry`;

  await refused([
    [machine('[tools]\n"core:bun" = "1.4.0"\n'), ["alpha"], "machine.toml pins tool core:bun 1.4.0, below the 1.4.4 package alpha needs; raise or remove the pin there"],
    [machine('[tools]\nbun = "latest"\n'), ["alpha"], not('"latest"')],
    [machine('[tools]\nbun = ["1.4.4", "1.4.5"]\n'), ["alpha"], not('["1.4.4","1.4.5"]')],
    [machine('[tools]\nbun = { version = "prefix:1.4" }\n'), ["alpha"], not('{"version":"prefix:1.4"}')],
    [machine('[tools]\nbun = "1.4.5"\n"core:bun" = "1.4.4"\n'), ["alpha"], "machine.toml pins tool core:bun twice, as bun and as core:bun, which package alpha requires; keep one entry"],
    // mise takes 1.4 as a prefix of several releases: no hold.
    [machine('[tools]\nbun = "1.4"\n'), ["alpha"], "machine.toml gives tool bun 1.4, a prefix mise matches against several releases, and package alpha requires it as core:bun: pin one exact release there, such as 1.4.4, or remove the entry"],
    // An inline [tools] office can't take one entry out of, line by line.
    [machine('tools = { bun = "1.4.5", zig = "0.15.2" }\n'), ["alpha"], 'machine.toml holds tool bun in a form office can\'t leave out of what mise loads; write each as key = "version" under [tools]'],
  ]);
});

test("a hold is left out of what mise loads however TOML writes its key, and every other entry stays as written and as mise reads it", () => {
  const unrelated = '[settings]\nexperimental = true\n\n[tools]\nzig = "0.15.2" # the owner\'s\nnode = { version = "24", os = ["linux"] }\n';
  const held = new Set(["bun", "core:bun"]);

  for (const form of ["bun = \"1.4.5\"\n", "'bun' = \"1.4.5\"\n", "\"core:bun\" = { version = \"1.4.5\" }\n", "bun . version = \"1.4.5\"\n"]) {
    expect(withoutTools(`${unrelated}${form}`, held)).toBe(unrelated);
  }

  // A [tools.bun] table goes whole, up to the next table; a dotted root key goes too.
  expect(withoutTools(`[tools.bun]\nversion = "1.4.5"\npostinstall = "true"\n\n${unrelated}`, held)).toBe(unrelated);
  expect(withoutTools('tools.bun = "1.4.5"\ntools.zig = "0.15.2"\n', held)).toBe('tools.zig = "0.15.2"\n');
  // An unrelated tool whose key only looks alike stays.
  expect(withoutTools(`${unrelated}bunx = "1.0.0"\n'bun-extra' = "2"\n`, held)).toBe(`${unrelated}bunx = "1.0.0"\n'bun-extra' = "2"\n`);
  // What office can't place line by line is refused, not guessed.
  expect(withoutTools('tools = { bun = "1.4.5" }\n', held)).toBeUndefined();
  expect(withoutTools('[tools]\nbun = """\n1.4.5"""\n', held)).toBeUndefined();
});

test("a host-only requirement applies only in host mode, so an inactive one raises no floor", async () => {
  await published();
  requires("alpha", "bun", "1.4.4", "bun");
  requires("beta", "core:bun", "1.5.0", "bun", true);
  select("alpha", "beta");
  expect((await run()).join("\n")).not.toContain("FAILED");
  const host = await loaded();
  expect(admitTools(host.config, host.gathered.packages).demands.get("core:bun")?.floor).toBe("1.5.0");
  const container = { ...host.config, opencode: { ...host.config.opencode, mode: "container" as const } };
  expect(admitTools(container, host.gathered.packages).demands.get("core:bun")).toEqual({ name: "core:bun", floor: "1.4.4", consumers: [{ package: "alpha", name: "bun", minimum: "1.4.4" }], bin: ["bun"] });
});

test("a shared tool takes its consumers' strictest effective age; a package entry's own age replaces the office's for it alone", () => {
  const consumers = [{ package: "lenient", name: "bun", minimum: "1.0.0" }, { package: "plain", name: "core:bun", minimum: "1.0.0" }];
  const demand = (name: string) => ({ name, floor: "1.0.0", consumers, bin: [name] });

  expect(effectiveAge("3d", consumers, new Map([["lenient", "0d"]]))).toBe("3d");
  expect(effectiveAge("3d", consumers.slice(0, 1), new Map([["lenient", "0d"]]))).toBe("0d");
  expect(effectiveAge("3d", consumers, new Map([["plain", "1w"]]))).toBe("1w");
  expect(effectiveAge("3d", consumers, new Map([["plain", "72h"]]))).toBe("3d");
  expect(planningToml("3d", [{ demand: demand("aqua:aws/aws-cli"), age: "3d" }, { demand: demand("core:bun"), age: "7d" }, { demand: demand(openspec), age: "0d" }])).toBe([
    "[settings]",
    'minimum_release_age = "3d"',
    "",
    "[tools]",
    '"aqua:aws/aws-cli" = "latest"',
    '"core:bun" = { version = "latest", minimum_release_age = "7d" }',
    `"${openspec}" = { version = "latest", minimum_release_age = "0d" }`,
    "",
  ].join("\n"));
});

test("office bump runs one isolated dry run with office.yaml's ages, ignoring ambient mise config, records each tool by backend, and changes nothing applied", async () => {
  expect(reservedWord("bump")).toBe(true);
  await published();
  requires("alpha", openspec, "2.0.0");
  requires("beta", openspec, "2.1.0");
  requires("gamma", "bun", "1.4.4", "bun");
  requires("delta", "aws-cli", "2.40.0", "aws");
  // gamma's own age replaces the office's for bun; alpha's lower one is outweighed by beta's three days.
  select("alpha, minimum_release_age: 0d", "beta", "gamma, minimum_release_age: 7d", "delta");
  expect((await run()).join("\n")).not.toContain("FAILED");
  // Ambient config the plan must not see: the office's own mise.toml and mise variables.
  write(join(office, "mise.toml"), '[settings]\nminimum_release_age = "0d"\n[tools]\nbun = "1.0.0"\n');
  const before = snapshot({ lock: false });
  const warning = "mise WARN  newer bun release 1.4.5 (released 2026-11-19, eligible 2026-11-26 08:47 UTC) ignored by minimum_release_age (7d); latest eligible release is 1.4.4";

  const mise = fakeMise(["Would install aqua:aws/aws-cli@2.42.1", "Would install bun@1.4.4", `Would install ${openspec}@2.1.1`, "Would schedule bat@0.25.0 for pruning after 24h", "Would bump core:bun@1.4.4 in /tmp/x/mise.toml", ""].join("\n"), { stderr: `${warning}\nmise DEBUG ignored\n` });

  const ambient = { MISE_MINIMUM_RELEASE_AGE: process.env.MISE_MINIMUM_RELEASE_AGE, MISE_GLOBAL_CONFIG_FILE: process.env.MISE_GLOBAL_CONFIG_FILE, PATH: process.env.PATH };
  process.env.MISE_MINIMUM_RELEASE_AGE = "0d";
  process.env.MISE_GLOBAL_CONFIG_FILE = join(dir, "ambient.toml");
  // mise's shims, as the environment file puts them on PATH: each resolves its tool through the caller's config.
  process.env.PATH = `${miseShims()}:${process.env.PATH}`;
  let result;

  try {
    result = await bump(loadOffice(office), { mise: ["sfw", "mise"], run: mise.runner });
  } finally {
    for (const [key, value] of Object.entries(ambient)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }

  expect(result).toEqual({
    ok: true,
    lines: [
      warning,
      "office.lock: selected tool aqua:aws/aws-cli 2.42.1 for package delta",
      "office.lock: selected tool core:bun 1.4.4 for package gamma",
      `office.lock: selected tool ${openspec} 2.1.1 for package alpha and package beta`,
    ],
  });
  // office.lock records the exact versions alone; mise is asked only for its plan.
  expect(lockedTools()).toEqual({ "aqua:aws/aws-cli": { version: "2.42.1" }, "core:bun": { version: "1.4.4" }, [openspec]: { version: "2.1.1" } });
  expect(mise.calls.map(call => call.argv)).toEqual([["sfw", "mise", "upgrade", "--bump", "--dry-run"]]);
  expect(mise.calls[0].plan).toBe(['[settings]', 'minimum_release_age = "3d"', "", "[tools]", '"aqua:aws/aws-cli" = "latest"', ...officeTools.map(({ tool }) => `"${tool}" = "latest"`).toSorted((a, b) => a.localeCompare(b)), '"core:bun" = { version = "latest", minimum_release_age = "7d" }', `"${openspec}" = "latest"`, ""].join("\n"));

  const [{ cwd, env }] = mise.calls;
  const root = dirname(cwd);

  expect(cwd.startsWith(office)).toBe(false);
  expect(env).toMatchObject({ MISE_CONFIG_DIR: join(root, "config"), MISE_GLOBAL_CONFIG_FILE: join(root, "config/config.toml"), MISE_DATA_DIR: join(root, "data"), MISE_CEILING_PATHS: root, MISE_TRUSTED_CONFIG_PATHS: cwd });
  expect(env.MISE_MINIMUM_RELEASE_AGE).toBeUndefined();
  expect(env.PATH?.split(":")).not.toContain(miseShims());
  expect(existsSync(root)).toBe(false);
  expect(snapshot({ lock: false })).toEqual(before);
});

test("machine.toml's exact pin is held outside the batch once mise lists it; a selection never lowers office.lock; a release below a minimum or a missing one records nothing", async () => {
  await published();
  requires("alpha", openspec, "2.1.0");
  requires("gamma", "bun", "1.4.4", "bun");
  select("alpha", "gamma");
  write(join(office, "machine.toml"), `[tools]\n"${openspec}" = { version = "2.1.0", postinstall = "true" }\n`);
  expect((await run()).join("\n")).not.toContain("FAILED");
  const config = loadOffice(office);
  const select2 = (mise: ReturnType<typeof fakeMise>) => bump(config, { mise: ["mise"], run: mise.runner });
  const releases = { [openspec]: "2.1.0\n" };

  const held = fakeMise("Would install bun@1.4.5\n", { releases });
  expect((await select2(held)).lines).toEqual([
    "office.lock: selected tool core:bun 1.4.5 for package gamma",
    `machine.toml holds tool ${openspec} at 2.1.0`,
    `office.lock: selected tool ${openspec} 2.1.0 for package alpha`,
  ]);
  expect(held.calls.map(call => call.argv)).toEqual([["mise", "ls-remote", openspec, "2.1.0"], ["mise", "upgrade", "--bump", "--dry-run"]]);
  expect(lockedTools()).toEqual({ "core:bun": { version: "1.4.5" }, [openspec]: { version: "2.1.0" } });

  const repeat = fakeMise("Would install bun@1.4.5\n", { releases });
  expect((await select2(repeat)).lines).toEqual([`machine.toml holds tool ${openspec} at 2.1.0`]);
  expect(repeat.calls.map(call => call.argv[1])).toEqual(["ls-remote", "upgrade"]);
  expect(held.calls[0].env.MISE_MINIMUM_RELEASE_AGE).toBe("0d");
  expect(held.calls[1].plan).not.toContain(openspec);

  expect((await select2(fakeMise("Would install core:bun@1.4.4\n", { releases }))).lines).toContain("kept tool core:bun at 1.4.5 in office.lock: mise selected the older 1.4.4");
  const recorded = readFileSync(join(office, "office.lock"), "utf8");

  for (const [mise, failure] of [
    [fakeMise("Would install bun@1.4.3\n", { releases }), "FAILED mise selected tool core:bun 1.4.3, below the 1.4.4 package gamma needs; office.lock is left as it was"],
    [fakeMise("Would install bat@0.26.1\n", { releases }), "FAILED mise selected no release of tool core:bun, which package gamma requires; office.lock is left as it was"],
    [fakeMise("Would install bun@1.4.4\nWould install bun@1.4.5\n", { releases }), "FAILED mise planned bun twice; office.lock is left as it was"],
    [fakeMise("", { status: 1, stderr: "mise ERROR network down", releases }), "FAILED mise couldn't plan the tools' releases (exit 1): mise ERROR network down; office.lock is left as it was"],
    [fakeMise("Would install core:bun@1.4.5\n", { releases: { [openspec]: "2.1.0-beta.1\n2.1.0.1\n" } }), `FAILED machine.toml holds tool ${openspec} at 2.1.0, which isn't one of the releases mise lists for ${openspec}; package alpha requires it: pin one exact release there, or remove the entry; office.lock is left as it was`],
  ] as const) {
    const selection = await select2(mise);

    expect(selection.ok).toBe(false);
    expect(selection.lines.at(-1)).toBe(failure);
    expect(readFileSync(join(office, "office.lock"), "utf8")).toBe(recorded);
  }
});

