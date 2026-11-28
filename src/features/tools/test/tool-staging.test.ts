import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as v from "valibot";

import { applyTools, liveReleases } from "../apply.ts";
import { reconcileTools } from "../host.ts";
import { activeRecord, currentLink, readRecord, resolveIn, resolveTool } from "../../../../packages/tools/applied.ts";
import { projectionPath, toolsState } from "../applied.ts";
import type { Run } from "../selection.ts";
import { gatherPackages } from "../../../gather.ts";
import { grantConsent } from "../../machine/record.ts";
import { loadOffice } from "../../../office.ts";
import type { LockedTool } from "../../../schema.ts";
import { syncLines as sync } from "../../../../test/support/sync.fixture.ts";
import { applyOfficeTools, definitionText, isOfficeTool, officeTools, sharedToolsLock, writePackage } from "../../../../test/support/test-package.ts";
import { defaultPins, editLock } from "../../../versions.ts";

let dir: string;

let office: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-tool-staging-"));
  office = join(dir, "office");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const openspec = "npm:@fission-ai/openspec";
const sha = (text: string) => `sha256:${createHash("sha256").update(text).digest("hex")}`;
const script = (tool: string, version: string) => `#!/bin/sh\necho ${tool} ${version}\n`;

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function toolPackage(name: string, body: string, settings = "", prelude = 'import { tools } from "@office/tools";'): void {
  writePackage(join(office, `packages/${name}/office.ts`), definitionText(`{${settings ? `settings:${settings},` : ""}setup(ctx){${body}}}`, prelude), { dependencies: ["tools", "mise-integration"] });
}

function requires(name: string, tool: string, minimum: string, bin: string): void {
  toolPackage(name, `tools.require(ctx,{name:${JSON.stringify(tool)},minimum:${JSON.stringify(minimum)},bin:${JSON.stringify(bin)}})`);
}

// Well before any age the tests use.
const old = "2026-01-01T00:00:00Z";

/** A package that provides `tool` with its own task `stage`, listing `listed` versions (published `published`) with the digest of what the fake task stages. */
function provides(name: string, tool: string, version: string, listed: readonly string[], published: Record<string, string | undefined> = {}): void {
  // JSON leaves out a publication time given as undefined.
  const bin = tool.split("/").at(-1) ?? tool;
  const releases = listed.map(release => ({ version: release, published: release in published ? published[release] : old, digests: { [bin]: sha(script(tool, release)) } }));

  write(join(office, `packages/${name}/mise.toml`), '[tasks.stage]\nrun = "true"\n');

  toolPackage(name, `tools.provide(ctx,{name:${JSON.stringify(tool)},versionSetting:"version",install:mise.task("stage"),releases:()=>${JSON.stringify(releases)},bin:${JSON.stringify(bin)}})`, `{type:"object",additionalProperties:false,properties:{version:{type:"string",default:${JSON.stringify(version)}}}}`, 'import { tools } from "@office/tools";\nimport { mise } from "@office/mise-integration/claims";');
}

function select(...entries: string[]): void {
  write(join(office, "office.yaml"), `name: t\nstate: ${join(dir, "state")}\nopencode: {mode: host, url: 'http://127.0.0.1:49999'}\nminimum_release_age: 3d\npackages: [${entries.map(entry => `{name: ${entry}}`).join(", ")}]\n`);
}

async function published(): Promise<void> {
  mkdirSync(join(office, "packages"), { recursive: true });
  select();
  write(join(office, "office.lock"), sharedToolsLock());
  applyOfficeTools(loadOffice(office).state);
  grantConsent(loadOffice(office));
  await sync(loadOffice(office), { scope: "packages" });
}

function lock(tools: Record<string, LockedTool>): void {
  editLock(office, sections => {
    // The office package's own tools stay recorded beside the ones the test sets.
    const kept: [string, LockedTool][] = officeTools.map(({ tool, version }) => [tool, sections.tools.get(tool) ?? { version }]);

    sections.tools = new Map([...kept, ...Object.entries(tools)]);
  });
}

type Call = { argv: readonly string[]; cwd: string; env: Readonly<Partial<Record<string, string>>>; files: string[] };

/**
 * A fake mise for staging. `install` puts each exact tool of the folder's mise.toml in the data
 * folder, or fails as mise does for a tool in `broken`, with that error. `run stage` runs the
 * calling package's fake task: it writes the tool's script into the staging folder (altered for a
 * tool in `wrong`), or fails for a tool in `failing`.
 */
function fakeMise({ broken = {}, failing = [], foreign = false, wrong = [] }: { broken?: Record<string, string>; failing?: readonly string[]; foreign?: boolean; wrong?: readonly string[] } = {}) {
  const calls: Call[] = [];
  const installed = (env: Readonly<Record<string, string>>, tool: string, version: string) => join(env.MISE_DATA_DIR, "installs", tool.replace(/\W+/g, "-"), version);

  const run: Run = (argv, { cwd, env }) => {
    calls.push({ argv, cwd, env, files: readdirSync(cwd).map(name => `${name}: ${statSync(join(cwd, name)).isFile() ? readFileSync(join(cwd, name), "utf8") : "folder"}`) });
    const [command, ...args] = argv.slice(2);

    if (command === "tasks") return { status: 0, stdout: JSON.stringify({ name: args[1], source: foreign ? join(office, "mise.toml") : join(cwd, "mise.toml") }), stderr: "" };

    if (command === "run") {
      if (failing.includes(env.OFFICE_TOOL_NAME)) return { status: 1, stdout: "", stderr: `task ${args[0]} failed` };
      const staged = join(env.OFFICE_STAGE_DIR, env.OFFICE_TOOL_NAME.split("/").at(-1) ?? "");

      write(staged, `${script(env.OFFICE_TOOL_NAME, env.OFFICE_TOOL_VERSION)}${wrong.includes(env.OFFICE_TOOL_NAME) ? "echo altered\n" : ""}`);
      chmodSync(staged, 0o755);

      return { status: 0, stdout: "", stderr: "" };
    }

    const wanted = v.parse(v.object({ tools: v.record(v.string(), v.string()) }), Bun.TOML.parse(readFileSync(join(cwd, "mise.toml"), "utf8"))).tools;

    if (command === "install") {
      for (const [tool, version] of Object.entries(wanted)) {
        if (tool in broken) return { status: 1, stdout: "", stderr: `mise ERROR Failed to install ${tool}@${version}: ${broken[tool]}\nmise ERROR Run with --verbose or MISE_VERBOSE=1 for more information` };
        const folder = installed(env, tool, version);

        write(join(folder, "bin", tool.split(/[:/]/).at(-1) ?? tool), script(tool, version));
        chmodSync(join(folder, "bin", tool.split(/[:/]/).at(-1) ?? tool), 0o755);
      }

      return { status: 0, stdout: "", stderr: "" };
    }

    const spec = command === "where" ? args[0] : args[2];
    const at = spec.lastIndexOf("@");
    const folder = installed(env, spec.slice(0, at), spec.slice(at + 1));

    if (command === "where") return { status: 0, stdout: `${folder}\n`, stderr: "" };
    // The install exposes whichever executable is asked for.
    const path = join(folder, "bin", args[0]);

    if (!existsSync(path)) {
      write(path, script(spec, args[0]));
      chmodSync(path, 0o755);
    }

    return { status: 0, stdout: `${path}\n`, stderr: "" };
  };

  return { run, calls };
}

async function apply(mise: ReturnType<typeof fakeMise>, upgrade = false) {
  const config = loadOffice(office);
  const gathered = await gatherPackages(config, { machine: true });

  expect(gathered.problems).toEqual([]);

  return applyTools(config, gathered.packages, { mise: ["sfw", "mise"], run: mise.run, env: process.env, upgrade, releases: liveReleases(gathered) });
}

/** What activation owns: the applied record and the generation the current link names. */
function active() {
  const tools = toolsState(loadOffice(office));

  return { record: existsSync(activeRecord(tools)) ? readFileSync(activeRecord(tools), "utf8") : undefined, projection: existsSync(currentLink(tools)) ? join(tools, readlinkSync(currentLink(tools))) : undefined };
}

/** What `bin` of `name` resolves to for a consumer needing `minimum`. */
const resolved = (name: string, bin: string, minimum: string) => resolveIn(readRecord(toolsState(loadOffice(office))), { name, minimum, bin }, toolsState(loadOffice(office)));

/** What a managed tool's identity is once staged by the fake: its executable's name and SHA-256. */
const measured = (tool: string, version: string, bin = tool.split(/[:/]/).at(-1) ?? tool) => `${bin} ${sha(script(tool, version))}`;

test("plain apply installs what is missing, verified against office.lock, and a handle resolves only once it is active; a repeat stages nothing", async () => {
  await published();
  requires("alpha", "core:bun", "1.4.4", "bun");
  requires("beta", openspec, "2.1.0", "openspec");
  select("alpha", "beta");
  await sync(loadOffice(office), { scope: "packages" });
  lock({ "core:bun": { version: "1.4.4" }, [openspec]: { version: "2.1.1" } });
  const config = loadOffice(office);

  expect(resolved("core:bun", "bun", "1.4.4")).toEqual({ status: "missing" });

  const mise = fakeMise();
  const first = await apply(mise);

  // Each tool's identity is what was staged: its executable's SHA-256.
  expect(first).toEqual({ ok: true, lines: [`installed tool core:bun 1.4.4: ${measured("core:bun", "1.4.4")}`, `installed tool ${openspec} 2.1.1: ${measured(openspec, "2.1.1")}`] });
  // The exact version from an isolated folder, as mise installs and verifies it, with no lock or check office adds; the npm tool with pnpm.
  const installs = mise.calls.filter(call => call.argv[2] === "install");

  // Each installs fresh, into a new data folder of its own, with a throwaway package store.
  expect(installs.map(call => [call.env.MISE_LOCKED, call.env.MISE_NPM_PACKAGE_MANAGER, call.env.pnpm_config_minimum_release_age, call.files])).toEqual([[undefined, undefined, "4320", ['mise.toml: [tools]\n"core:bun" = "1.4.4"\n']], [undefined, "pnpm", "4320", [`mise.toml: [tools]\n"${openspec}" = "2.1.1"\n`]]]);
  expect(installs.map(call => call.env.MISE_DATA_DIR)).toEqual([expect.stringMatching(new RegExp(`^${join(dir, "state/tools/managed/core%3Abun/1.4.4-")}`.replaceAll(".", "\\."))), expect.stringMatching(new RegExp(`^${join(dir, "state/tools/managed/npm%3A%40fission-ai%2Fopenspec/2.1.1-")}`.replaceAll(".", "\\.")))]);
  expect(installs.every(call => call.env.pnpm_config_store_dir?.startsWith(dirname(call.cwd)))).toBe(true);
  expect(installs.every(call => call.argv[0] === "sfw" && !call.cwd.startsWith(office) && call.env.MISE_CEILING_PATHS === dirname(call.cwd))).toBe(true);

  const ready = resolved("core:bun", "bun", "1.4.4");

  expect(ready).toMatchObject({ status: "ready", version: "1.4.4", identity: measured("core:bun", "1.4.4") });
  expect(realpathSync(join(projectionPath(config), "bun"))).toBe(realpathSync(ready.status === "ready" ? ready.path : ""));
  expect(readlinkSync(join(projectionPath(config), "openspec"))).toEndWith("/2.1.1/bin/openspec");

  const repeat = fakeMise();
  const before = active();

  expect(await apply(repeat)).toEqual({ ok: true, lines: [] });
  expect(repeat.calls).toEqual([]);
  expect(active()).toEqual(before);
});

test("a newer desired release waits for an upgrade, which stages every change before switching any; a failed stage switches nothing", async () => {
  await published();
  requires("alpha", "core:bun", "1.4.4", "bun");
  provides("gamma", "widget", "1.0.0", ["1.0.0", "1.1.0"]);
  select("alpha", "gamma");
  await sync(loadOffice(office), { scope: "packages" });
  lock({ "core:bun": { version: "1.4.4" } });
  expect((await apply(fakeMise())).ok).toBe(true);

  // A bump and the owner's new provider version: plain apply keeps what is active; a consumer needing the newer one is told to upgrade.
  select("alpha", "gamma, settings: {version: 1.1.0}");
  await sync(loadOffice(office), { scope: "packages" });
  lock({ "core:bun": { version: "1.4.5" } });
  const held = active();

  expect(await apply(fakeMise())).toEqual({ ok: true, lines: ["tool widget 1.0.0 stays active; 1.1.0 is desired: office up --upgrade switches to it", "tool core:bun 1.4.4 stays active; 1.4.5 is desired: office up --upgrade switches to it"] });
  expect(active()).toEqual(held);
  expect(resolved("core:bun", "bun", "1.4.5")).toEqual({ status: "upgrade-pending", version: "1.4.4" });

  // A staging task that fails, before the other tool: nothing staged, nothing switched.
  const broken = await apply(fakeMise({ failing: ["widget"] }), true);

  expect(broken.lines.slice(-2)).toEqual(["FAILED staging tool widget@1.1.0 with its package's task stage failed (exit 1): task stage failed", "FAILED nothing was staged or switched"]);
  expect(active()).toEqual(held);

  // The widget stages, then mise's own verification of bun's download fails: neither switches, and mise's words are what fails.
  const failed = await apply(fakeMise({ broken: { "core:bun": "Checksum mismatch for file bun-linux-x64.zip" } }), true);

  expect(failed.ok).toBe(false);
  expect(failed.lines.at(-1)).toBe("FAILED staged widget, but no tool was switched");
  expect(failed.lines.at(-2)).toBe("FAILED installing tool core:bun@1.4.5 failed (exit 1): mise ERROR Failed to install core:bun@1.4.5: Checksum mismatch for file bun-linux-x64.zip");
  expect(active()).toEqual(held);

  const upgraded = await apply(fakeMise(), true);

  expect(upgraded.lines).toEqual([`switched tool widget 1.1.0 (was 1.0.0): widget ${sha(script("widget", "1.1.0"))}`, `switched tool core:bun 1.4.5 (was 1.4.4): ${measured("core:bun", "1.4.5")}`]);
  expect(resolved("core:bun", "bun", "1.4.5")).toMatchObject({ status: "ready", version: "1.4.5" });
  expect(readlinkSync(join(projectionPath(loadOffice(office)), "widget"))).toBe(join(dir, "state/tools/provided/widget/1.1.0/widget"));
  expect(existsSync(held.projection ?? "")).toBe(false);
});

test("an upgrade refuses a downgrade, a desired release below a minimum or off the owner's hold before staging anything, and a stage mise can't complete switches nothing", async () => {
  await published();
  requires("alpha", "core:bun", "1.4.4", "bun");
  select("alpha");
  await sync(loadOffice(office), { scope: "packages" });
  lock({ "core:bun": { version: "1.4.5" } });
  expect((await apply(fakeMise())).ok).toBe(true);
  const before = active();

  const refusals: [() => void, string][] = [
    [() => lock({ "core:bun": { version: "1.4.4" } }), "FAILED refused tool core:bun 1.4.4: it is older than 1.4.5, the highest version applied here, and a tool is never downgraded"],
    [() => lock({ "core:bun": { version: "1.4.3" } }), "FAILED office.lock records tool core:bun 1.4.3, below the 1.4.4 package alpha needs; run office bump"],
    [() => lock({}), "FAILED office.lock has no release of tool core:bun, which package alpha requires; run office bump"],
    [() => { lock({ "core:bun": { version: "1.4.6" } }); write(join(office, "machine.toml"), '[tools]\nbun = "1.4.5"\n'); }, "FAILED machine.toml holds tool bun at 1.4.5, but office.lock records 1.4.6; run office bump"],
  ];

  for (const [arrange, refusal] of refusals) {
    arrange();
    const mise = fakeMise();
    const result = await apply(mise, true);

    expect(result.ok).toBe(false);
    expect(result.lines).toEqual([refusal, "FAILED no tool was installed or switched"]);
    expect(mise.calls).toEqual([]);
    expect(active()).toEqual(before);
  }

  // A prerequisite mise needs and doesn't find fails the stage with mise's error; nothing is substituted or switched.
  rmSync(join(office, "machine.toml"));
  lock({ "core:bun": { version: "1.4.6" } });
  const missing = fakeMise({ broken: { "core:bun": "unzip is required to extract bun-linux-x64.zip but was not found" } });
  const prerequisite = await apply(missing, true);

  expect(prerequisite.lines).toEqual(["FAILED installing tool core:bun@1.4.6 failed (exit 1): mise ERROR Failed to install core:bun@1.4.6: unzip is required to extract bun-linux-x64.zip but was not found", "FAILED nothing was staged or switched"]);
  expect(missing.calls.map(call => call.argv[2])).toEqual(["install"]);
  expect(readdirSync(join(dir, "state/tools/managed/core%3Abun")).filter(name => name.startsWith("1.4.6"))).toEqual([]);
  expect(active()).toEqual(before);
});

test("each provider's task runs in its own package folder, whatever the caller's folder or mise config, and its result must match the release list", async () => {
  await published();
  // Only the office package's tools are active, as the fixture applied them.
  const fixture = active();
  provides("alpha", "widget", "1.0.0", ["1.0.0"]);
  provides("beta", "gadget", "2.0.0", ["1.0.0"]);
  select("alpha", "beta");
  await sync(loadOffice(office), { scope: "packages" });

  const first = fakeMise();
  const unlisted = await apply(first);

  // Refused before anything stages.
  expect(unlisted.lines).toEqual(["FAILED tool gadget 2.0.0 isn't among the releases its provider lists", "FAILED no tool was installed or switched"]);
  expect(first.calls).toEqual([]);
  expect(active()).toEqual(fixture);

  select("alpha", "beta, settings: {version: 1.0.0}");
  await sync(loadOffice(office), { scope: "packages" });
  const ambient = process.env.MISE_CONFIG_DIR;
  const mise = fakeMise();

  process.env.MISE_CONFIG_DIR = join(dir, "ambient");

  try {
    expect((await apply(mise)).ok).toBe(true);
  } finally {
    if (ambient === undefined) delete process.env.MISE_CONFIG_DIR;
    else process.env.MISE_CONFIG_DIR = ambient;
  }

  const tasks = mise.calls.filter(call => call.argv[2] === "run");

  expect(tasks.map(call => [call.argv.slice(2), call.cwd, call.env.MISE_CEILING_PATHS, call.env.MISE_TRUSTED_CONFIG_PATHS])).toEqual([
    [["run", "stage"], realpathSync(join(office, "packages/alpha")), realpathSync(join(office, "packages")), realpathSync(join(office, "packages/alpha"))],
    [["run", "stage"], realpathSync(join(office, "packages/beta")), realpathSync(join(office, "packages")), realpathSync(join(office, "packages/beta"))],
  ]);
  expect(tasks.every(call => call.env.MISE_CONFIG_DIR !== join(dir, "ambient") && call.env.OFFICE_STAGE_DIR !== undefined)).toBe(true);
  expect(Object.keys(JSON.parse(active().record ?? "{}").tools).filter(tool => !isOfficeTool(tool))).toEqual(["gadget", "widget"]);
});

test("a provided release installs only when its list states a trusted publication time at least the strictest age of its provider and consumers old, explicit version included", async () => {
  await published();
  const now = Date.parse("2026-11-24T12:00:00Z");

  provides("alpha", "widget", "1.0.0", ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.4.0"], { "1.1.0": undefined, "1.2.0": "last tuesday", "1.3.0": "2026-12-01T00:00:00Z", "1.4.0": "2026-11-20T12:00:00Z" });
  requires("beta", "widget", "1.0.0", "widget");
  select("alpha", "beta, minimum_release_age: 7d");
  await sync(loadOffice(office), { scope: "packages" });

  const run = async (version: string, upgrade = true, mise = fakeMise()) => {
    select("alpha, settings: {version: " + version + "}", "beta, minimum_release_age: 7d");
    const gathered = await gatherPackages(loadOffice(office), { machine: true });

    return { result: await applyTools(loadOffice(office), gathered.packages, { mise: ["sfw", "mise"], run: mise.run, env: process.env, upgrade, releases: liveReleases(gathered), now }), mise };
  };

  expect((await run("1.0.0")).result.ok).toBe(true);
  const before = active();

  for (const [version, refusal] of [
    ["1.1.0", "tool widget 1.1.0: its provider's release list states no publication time, so its age can't be checked"],
    ["1.2.0", 'tool widget 1.2.0: its provider\'s publication time "last tuesday" isn\'t an ISO 8601 time with a zone'],
    ["1.3.0", "tool widget 1.3.0: its provider's publication time 2026-12-01T00:00:00Z is in the future, so it isn't trusted"],
    // Four days old: the provider's entry inherits 3d, but its consumer beta waits 7d.
    ["1.4.0", "tool widget 1.4.0 was published 2026-11-20T12:00:00Z, younger than the 7d its packages wait; it is eligible from 2026-11-27T12:00:00.000Z"],
    ["9.9.9", "tool widget 9.9.9 isn't among the releases its provider lists"],
  ] as const) {
    const { result, mise } = await run(version);

    expect(result).toEqual({ ok: false, lines: [`FAILED ${refusal}`, "FAILED no tool was installed or switched"] });
    expect(mise.calls).toEqual([]);
    expect(active()).toEqual(before);
  }
});

test("a provider's task must be its own package's, and it runs behind the firewall with the applied tools first on PATH", async () => {
  await published();
  // Only the office package's tools are active, as the fixture applied them.
  const fixture = active();
  provides("alpha", "widget", "1.0.0", ["1.0.0"]);
  select("alpha");
  await sync(loadOffice(office), { scope: "packages" });
  write(join(office, "mise.toml"), '[tasks.stage]\nrun = "true"\n');

  const foreign = await apply(fakeMise({ foreign: true }));

  expect(foreign.lines[0]).toBe(`FAILED tool widget@1.0.0: task stage isn't its package's own (mise finds it in ${realpathSync(join(office, "mise.toml"))}, not under ${realpathSync(join(office, "packages/alpha"))})`);
  expect(active()).toEqual(fixture);

  const mise = fakeMise();

  expect((await apply(mise)).ok).toBe(true);
  expect(mise.calls.map(call => call.argv.slice(0, 4))).toEqual([["sfw", "mise", "tasks", "info"], ["sfw", "mise", "run", "stage"]]);
  expect(mise.calls[1].env.PATH?.split(":")[0]).toBe(join(dir, "state/tools/current/bin"));
});

test("a handle resolves through the office's tools as sync located them: an alias its consumer used, a raised minimum as pending whatever else is on PATH, and a container's own tools", async () => {
  await published();
  requires("alpha", "bun", "1.4.4", "bun");
  select("alpha");
  await sync(loadOffice(office), { scope: "packages" });
  lock({ "core:bun": { version: "1.4.4" } });
  const config = loadOffice(office);

  expect(resolveTool(office, { name: "bun", minimum: "1.4.4", bin: "bun" })).toEqual({ status: "missing" });
  expect((await apply(fakeMise())).ok).toBe(true);
  expect(resolveTool(office, { name: "bun", minimum: "1.4.4", bin: "bun" })).toMatchObject({ status: "ready", version: "1.4.4", path: expect.stringContaining(join(dir, "state/tools/managed/")) });

  // A working bun on PATH doesn't satisfy a consumer that needs more than the applied one.
  const ambient = join(dir, "ambient/bun");

  write(ambient, "#!/bin/sh\necho 9.9.9\n");
  chmodSync(ambient, 0o755);
  const path = process.env.PATH;

  process.env.PATH = `${dirname(ambient)}:${path}`;

  try {
    expect(resolveTool(office, { name: "bun", minimum: "1.4.5", bin: "bun" })).toEqual({ status: "upgrade-pending", version: "1.4.4" });
  } finally {
    process.env.PATH = path;
  }

  // Sync tells scripts where the tools are: here; a container-mode office's are its container's.
  expect(JSON.parse(readFileSync(join(office, ".office/runtime/tools.json"), "utf8"))).toEqual({ mode: "host", tools: toolsState(config) });
  write(join(office, ".office/runtime/tools.json"), '{"mode":"container"}\n');
  expect(resolveTool(office, { name: "bun", minimum: "1.4.4", bin: "bun" })).toEqual({ status: "container" });
});

test("an applied executable that changed, went missing or resolves outside the tools folder is drift: never ready, never replaced by up, with its activated identity and no copy on PATH in its place", async () => {
  await published();
  requires("alpha", "bun", "1.4.4", "bun");
  select("alpha");
  await sync(loadOffice(office), { scope: "packages" });
  lock({ "core:bun": { version: "1.4.4" } });
  expect((await apply(fakeMise())).ok).toBe(true);
  const ready = resolveTool(office, { name: "bun", minimum: "1.4.4", bin: "bun" });

  if (ready.status !== "ready") throw new Error(`bun isn't ready: ${ready.status}`);
  const { path, identity } = ready;
  const tools = toolsState(loadOffice(office));
  const recorded = sha(script("core:bun", "1.4.4"));
  const fixed = active();
  const ambient = join(dir, "ambient/bun");

  write(ambient, "#!/bin/sh\necho 1.4.4\n");
  chmodSync(ambient, 0o755);
  const saved = process.env.PATH;

  process.env.PATH = `${dirname(ambient)}:${saved}`;

  try {
    // Changed bytes.
    write(path, "#!/bin/sh\necho tampered\n");
    const changed = `tool core:bun 1.4.4: its applied executable bun at ${path} is ${sha("#!/bin/sh\necho tampered\n")}, not the ${recorded} office activated; office neither runs a changed tool nor substitutes another copy: restore the file, or move the office's tools folder ${tools} aside for office up to install afresh`;

    expect(resolveTool(office, { name: "bun", minimum: "1.4.4", bin: "bun" })).toEqual({ status: "drifted", version: "1.4.4", identity, path, message: changed });
    const mise = fakeMise();

    expect(await apply(mise)).toEqual({ ok: false, lines: [`FAILED ${changed}`, "FAILED no tool was installed or switched"] });
    expect(await apply(mise, true)).toEqual({ ok: false, lines: [`FAILED ${changed}`, "FAILED no tool was installed or switched"] });
    expect(mise.calls).toEqual([]);
    expect(active()).toEqual(fixed);

    // A link to a file outside the tools folder, even one with the activated bytes.
    rmSync(path);
    write(join(dir, "outside/bun"), script("core:bun", "1.4.4"));
    symlinkSync(join(dir, "outside/bun"), path);
    expect(resolveTool(office, { name: "bun", minimum: "1.4.4", bin: "bun" })).toMatchObject({ status: "drifted", identity, message: expect.stringContaining(`its applied executable bun at ${path} resolves outside the office's tools folder`) });

    // Missing.
    rmSync(path);
    expect(resolveTool(office, { name: "bun", minimum: "1.4.4", bin: "bun" })).toMatchObject({ status: "drifted", identity, message: expect.stringContaining(`its applied executable bun at ${path} is missing`) });
    expect((await apply(fakeMise())).lines).toContain(`FAILED tool core:bun 1.4.4: its applied executable bun at ${path} is missing; office neither runs a changed tool nor substitutes another copy: restore the file, or move the office's tools folder ${tools} aside for office up to install afresh`);

    // Restored: ready again, as activated.
    write(path, script("core:bun", "1.4.4"));
    expect(resolveTool(office, { name: "bun", minimum: "1.4.4", bin: "bun" })).toEqual(ready);
    expect(await apply(fakeMise())).toEqual({ ok: true, lines: [] });
    expect(active()).toEqual(fixed);

    // With Socket Firewall off in office.yaml, up that has nothing to select or stage runs no mise and succeeds.
    write(join(office, "office.yaml"), readFileSync(join(office, "office.yaml"), "utf8").replace("minimum_release_age: 3d\n", `minimum_release_age: 3d\ntools:\n  sfw: { version: ${defaultPins.sfw.version}, enabled: false }\n`));
    const config = loadOffice(office);

    expect(await reconcileTools(config, await gatherPackages(config, { machine: true }), { upgrade: true, run: () => { throw new Error("mise ran"); } })).toEqual({ ok: true, lines: [] });
  } finally {
    process.env.PATH = saved;
  }
});

test("provided tools get folders of their own, and staging never replaces or follows what it didn't stage", async () => {
  await published();
  provides("alpha", "a/b", "1.0.0", ["1.0.0"]);
  provides("beta", "a-b", "1.0.0", ["1.0.0"]);
  select("alpha", "beta");
  await sync(loadOffice(office), { scope: "packages" });
  const tools = toolsState(loadOffice(office));

  // Something else in a version's folder: refused before anything stages, and left as it is.
  const occupied = join(tools, "provided/a-b/1.0.0");

  write(join(occupied, "sentinel"), "the owner's\n");
  const blocked = fakeMise();
  const refused = await apply(blocked);

  expect(refused.lines).toEqual([`FAILED tool a-b@1.0.0: ${occupied} is there already and isn't this release's staged output, so office doesn't replace it; move it aside`, "FAILED no tool was installed or switched"]);
  expect(blocked.calls).toEqual([]);
  expect(readFileSync(join(occupied, "sentinel"), "utf8")).toBe("the owner's\n");

  // A link on the way is refused too, and nothing is written where it leads.
  rmSync(occupied, { recursive: true });
  const elsewhere = join(dir, "elsewhere");

  mkdirSync(elsewhere);
  rmSync(join(tools, "provided/a-b"), { recursive: true });
  symlinkSync(elsewhere, join(tools, "provided/a-b"));
  expect((await apply(fakeMise())).lines[0]).toBe(`FAILED tool a-b@1.0.0: ${join(tools, "provided/a-b")} is a link or not a folder, so office doesn't stage there; move it aside`);
  expect(readdirSync(elsewhere)).toEqual([]);

  // Clear, both stage side by side: a/b and a-b never share a folder.
  rmSync(join(tools, "provided/a-b"));
  expect((await apply(fakeMise())).ok).toBe(true);
  expect(readFileSync(join(tools, "provided/a%2Fb/1.0.0/b"), "utf8")).toBe(script("a/b", "1.0.0"));
  expect(readFileSync(join(tools, "provided/a-b/1.0.0/a-b"), "utf8")).toBe(script("a-b", "1.0.0"));
});

test("a managed install is fresh and contained: mise naming a file outside its new data folder stages nothing", async () => {
  await published();
  requires("alpha", "core:bun", "1.4.4", "bun");
  select("alpha");
  await sync(loadOffice(office), { scope: "packages" });
  lock({ "core:bun": { version: "1.4.4" } });
  const before = active();
  const outside = join(dir, "outside/bun");

  write(outside, script("core:bun", "1.4.4"));
  chmodSync(outside, 0o755);
  const mise = fakeMise();
  const redirected: Run = (argv, options) => argv[2] === "which" ? { status: 0, stdout: `${outside}\n`, stderr: "" } : mise.run(argv, options);
  const config = loadOffice(office);
  const gathered = await gatherPackages(config, { machine: true });
  const result = await applyTools(config, gathered.packages, { mise: ["sfw", "mise"], run: redirected, env: process.env, upgrade: false, releases: liveReleases(gathered) });

  expect(result.lines[0]).toBe(`FAILED tool core:bun@1.4.4: mise names ${outside} for executable bun, which isn't inside its fresh install in ${mise.calls[0].env.MISE_DATA_DIR}`);
  expect(active()).toEqual(before);
  // The fresh folder it made is gone with the failed stage.
  expect(existsSync(mise.calls[0].env.MISE_DATA_DIR ?? "")).toBe(false);
});

test("activation switches one link: the record and PATH name the same generation, and a link office doesn't own stops it", async () => {
  await published();
  requires("alpha", "core:bun", "1.4.4", "bun");
  select("alpha");
  await sync(loadOffice(office), { scope: "packages" });
  lock({ "core:bun": { version: "1.4.4" } });
  const tools = toolsState(loadOffice(office));
  const fixture = active();

  expect((await apply(fakeMise())).ok).toBe(true);
  const generation = realpathSync(currentLink(tools));

  expect(dirname(realpathSync(activeRecord(tools)))).toBe(generation);
  expect(realpathSync(projectionPath(loadOffice(office)))).toBe(join(generation, "bin"));
  // The generation replaced is removed; nothing else in the tools folder is.
  expect(existsSync(fixture.projection ?? "")).toBe(false);
  expect(existsSync(join(tools, "fixture"))).toBe(true);

  // A current that isn't office's link is refused before anything stages or a generation is made.
  rmSync(currentLink(tools));
  mkdirSync(currentLink(tools));
  requires("beta", "aqua:sharkdp/bat", "0.26.1", "bat");
  select("alpha", "beta");
  await sync(loadOffice(office), { scope: "packages" });
  lock({ "core:bun": { version: "1.4.4" }, "aqua:sharkdp/bat": { version: "0.26.1" } });
  const generations = readdirSync(join(tools, "generations"));
  const refused = fakeMise();

  await expect(apply(refused)).rejects.toThrow(`${currentLink(tools)} isn't the link office switches between its tool generations; move it aside`);
  expect(refused.calls).toEqual([]);
  expect(readdirSync(join(tools, "generations"))).toEqual(generations);
});

test("each run reconciles executables with the current consumers: a new executable of the same version is staged, a deselected tool leaves PATH, and its highest version still bars a downgrade", async () => {
  await published();
  requires("alpha", "aqua:FiloSottile/age", "1.3.2", "age");
  select("alpha");
  await sync(loadOffice(office), { scope: "packages" });
  const age = officeTools.find(tool => tool.tool === "aqua:FiloSottile/age");
  const version = age?.version ?? "";

  lock({ "aqua:FiloSottile/age": { version } });
  const unchanged = fakeMise();

  // Every executable the consumers name is applied already: nothing stages.
  expect(await apply(unchanged)).toEqual({ ok: true, lines: [] });
  expect(unchanged.calls).toEqual([]);

  // A package needing a third executable of the same version: plain up stages it.
  requires("beta", "aqua:FiloSottile/age", "1.3.2", "age-plugin");
  select("alpha", "beta");
  await sync(loadOffice(office), { scope: "packages" });
  const more = await apply(fakeMise());

  expect(more.lines).toHaveLength(1);
  expect(more.lines[0]).toStartWith(`added executables of tool aqua:FiloSottile/age ${version}: ${measured("aqua:FiloSottile/age", version)}, `);
  expect(existsSync(join(projectionPath(loadOffice(office)), "age-plugin"))).toBe(true);

  // bun, applied and then deselected, leaves PATH; its highest version is still recorded.
  requires("gamma", "core:bun", "1.4.5", "bun");
  select("alpha", "beta", "gamma");
  await sync(loadOffice(office), { scope: "packages" });
  lock({ "aqua:FiloSottile/age": { version }, "core:bun": { version: "1.4.5" } });
  expect((await apply(fakeMise())).ok).toBe(true);
  select("alpha", "beta");
  await sync(loadOffice(office), { scope: "packages" });
  expect((await apply(fakeMise())).lines).toEqual(["tool core:bun left PATH: no package requires it here any more"]);
  expect(existsSync(join(projectionPath(loadOffice(office)), "bun"))).toBe(false);
  expect(readRecord(toolsState(loadOffice(office))).highest["core:bun"]).toBe("1.4.5");

  // Selected again at a lower release, it is refused before staging.
  requires("delta", "core:bun", "1.4.4", "bun");
  select("alpha", "beta", "delta");
  await sync(loadOffice(office), { scope: "packages" });
  lock({ "aqua:FiloSottile/age": { version }, "core:bun": { version: "1.4.4" } });
  const lower = fakeMise();

  expect((await apply(lower)).lines).toEqual(["FAILED refused tool core:bun 1.4.4: it is older than 1.4.5, the highest version applied here, and a tool is never downgraded", "FAILED no tool was installed or switched"]);
  expect(lower.calls).toEqual([]);
});

test("a provided stage whose output isn't what its release list states activates nothing, and leaves no version folder", async () => {
  await published();
  provides("alpha", "widget", "1.0.0", ["1.0.0"]);
  select("alpha");
  await sync(loadOffice(office), { scope: "packages" });
  const before = active();
  const result = await apply(fakeMise({ wrong: ["widget"] }));
  const altered = sha(`${script("widget", "1.0.0")}echo altered\n`);

  expect(result).toEqual({ ok: false, lines: [`FAILED tool widget@1.0.0 didn't stage: executable widget is ${altered}, not the ${sha(script("widget", "1.0.0"))} its release list states`, "FAILED nothing was staged or switched"] });
  expect(active()).toEqual(before);
  expect(existsSync(join(toolsState(loadOffice(office)), "provided/widget/1.0.0"))).toBe(false);
});
