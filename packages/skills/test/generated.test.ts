import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Entries, JsonValue, Settings, SyncInputs } from "@office/sdk";
import { tools } from "@office/tools";
import { currentLink, generationFolder, generationRecord, generatorKey, nextGeneration } from "../generation.ts";
import { skills } from "../handles.ts";
import { generate as publishGeneration } from "../publication.ts";
import { upRuntimes } from "../../../src/lifecycle-inputs.ts";
import type { Office } from "../../../src/office.ts";
import definition from "../office.ts";
import type { settingsSchema } from "../settings.ts";
import { type GeneratedSource, generatedSources } from "../sources.ts";
import { type Added, applyTool as applyToolIn, entriesOf as entriesIn, host, officeInfo as infoOf, recorder, spec, write } from "./generated.fixture.ts";

type Given = Settings<typeof settingsSchema>;

let office: string;

beforeEach(() => {
  office = mkdtempSync(join(tmpdir(), "office-skills-generated-"));
});

afterEach(() => {
  rmSync(office, { recursive: true, force: true });
});

const generate = () => undefined;

/** What the openspec package's setup does: requires the CLI and registers its generator against that handle. */
function openspecSetup(inputs: (office: string) => JsonValue = () => ({ profile: "core" })) {
  const { ctx, added } = recorder();
  const cli = tools.require(ctx, spec);

  skills.sources.generated(ctx, { id: "openspec", tool: cli, revision: "1", inputs, generate });

  return { cli, added };
}

const entriesOf = (owner: string, added: Added) => entriesIn(office, owner, added);
const officeInfo = () => infoOf(office);
const applyTool = (version: string, drift = false) => applyToolIn(office, version, drift);
const updateExcluded = () => [];
const hostRunner = { container: false };

function inputs(settings: Given, entries: Entries) {
  const excluded: string[] = [];
  const sync: SyncInputs<Given> = { office: officeInfo(), entries, settings, exclude: paths => void excluded.push(...paths), updateExcluded };

  return { sync, excluded };
}

async function list(settings: Given, entries: Entries) {
  const err = spyOn(console, "error").mockImplementation(() => undefined);

  try {
    const result = definition.commands?.["skills list"]?.result;

    if (result === undefined) throw new Error("skills list returns its text");

    return { out: await result({ office: officeInfo(), entries, settings, args: [], replaceSetting: () => settings, updateExcluded }), err: err.mock.calls.map(call => String(call[0])) };
  } finally {
    err.mockRestore();
  }
}

const g1 = "aaaaaaaaaaaa-00000001";

/** What office up's publication leaves: a generation holding `ids` and its record, and `current` naming it. */
function publish(ids: string[]) {
  for (const id of ids) write(join(office, generationFolder("openspec", g1), id, "SKILL.md"));
  write(join(office, generationFolder("openspec", g1), generationRecord), JSON.stringify({ key: "sha256:x", skills: ids }));
  symlinkSync(`generations/${g1}`, join(office, currentLink("openspec")));
}

test("a registered source's generator is one this process registered, and its revision a nonempty string", () => {
  const { added } = openspecSetup();
  const source = added.find(entry => entry.id === generatedSources.id)?.value;

  // Another process gathers afresh: a generator from elsewhere names nothing here.
  expect(() => generatedSources.parse({ ...source, generator: "token-from-another-process" })).toThrow("generated skill source openspec: generator must be the function given to skills.sources.generated");
  expect(() => generatedSources.parse({ ...source, revision: "" })).toThrow("generated skill source openspec: revision must be a nonempty string");
  expect(generatedSources.parse({ ...source, revision: "2026-11 profile handling, take 2" })).toMatchObject({ revision: "2026-11 profile handling, take 2" });
});

test("only a requirement handle with a minimum and one executable registers a source, and the error names it", () => {
  const { ctx } = recorder();
  const provided = tools.provide(ctx, { name: "doop", versionSetting: "version", install: { task: "install" }, releases: () => [], bin: "doop" });
  const two = tools.require(ctx, { name: "aws-cli", minimum: "2.0.0", bin: ["aws", "aws_completer"] });

  expect(() => skills.sources.generated(ctx, { id: "doop", tool: provided, revision: "1", generate })).toThrow("generated skill source doop: tool doop has no minimum; pass the handle tools.require returned");
  expect(() => skills.sources.generated(ctx, { id: "aws", tool: two, revision: "1", generate })).toThrow("generated skill source aws: tool aws-cli must expose exactly one executable, the one that generates; it names 2");
});

test("a source whose tool its package doesn't require stops sync, naming it", async () => {
  const { ctx, added } = recorder();

  skills.sources.generated(ctx, { id: "openspec", tool: Object.freeze({ ...spec, bin: [spec.bin] }), revision: "1", generate });

  expect(() => definition.sync?.(inputs({ sources: [], enabled: [] }, entriesOf("openspec", added)).sync)).toThrow("generated source openspec (package openspec): package openspec doesn't require tool npm:@fission-ai/openspec 2.1.0 with executable openspec; pass the handle its tools.require returned");
});

test("before its first publication the source defers enabled IDs nobody offers: sync links the rest and says what waits, list and check show it, check fails", async () => {
  write(join(office, "skills/alpha/SKILL.md"));
  const { added } = openspecSetup();
  const entries = entriesOf("openspec", added);
  const settings = { sources: [{ folder: "skills" }], enabled: ["alpha", "openspec-propose"] };
  const waits = "generated source openspec (package openspec) hasn't published yet: tool npm:@fission-ai/openspec isn't installed yet; office up installs it and generates the source";
  const deferred = "enabled skills openspec-propose are deferred: no source offers them until generated source openspec (package openspec) publishes";
  const { sync, excluded } = inputs(settings, entries);

  expect(await definition.sync?.(sync)).toEqual([waits, deferred, "linked .agents/skills/alpha (folder skills)"]);
  expect(excluded).toEqual([".agents/skills/alpha"]);
  expect(readlinkSync(join(office, ".agents/skills/alpha"))).toBe("../../skills/alpha");
  expect(await list(settings, entries)).toEqual({ out: ["alpha             folder skills  enabled", "openspec-propose  -              enabled, deferred until a generated source publishes"].join("\n"), err: [waits] });
  expect(await definition.check?.({ ...sync, host })).toEqual([{ level: "failed", message: waits }, { level: "failed", message: deferred }]);
  // With nothing deferred, the waiting source alone is a warning.
  expect(await definition.check?.({ ...inputs({ ...settings, enabled: ["alpha"] }, entries).sync, host })).toEqual([{ level: "warning", message: waits }]);
});

test("a pending source names the applied tool's state: below the minimum or changed since activation", async () => {
  const { added } = openspecSetup();
  const settings = { sources: [], enabled: ["openspec-propose"] };

  applyTool("2.0.0");
  expect((await list(settings, entriesOf("openspec", added))).err).toEqual(["generated source openspec (package openspec) hasn't published yet: the applied npm:@fission-ai/openspec 2.0.0 is below the 2.1.0 it needs; office up --upgrade applies a newer one and generates the source"]);

  applyTool("2.1.1", true);
  expect((await list(settings, entriesOf("openspec", added))).err[0]).toMatch(/^generated source openspec \(package openspec\) hasn't published yet: tool npm:@fission-ai\/openspec 2\.1\.1: its applied executable openspec at .* is sha256:[0-9a-f]{64}, not the sha256:[0-9a-f]{64} office activated/);
});

test("once published, its skills are offered and copied, and an enabled ID nobody offers fails as for any source", async () => {
  const { added } = openspecSetup();
  const entries = entriesOf("openspec", added);

  publish(["openspec-propose", "openspec-explore"]);
  const { sync } = inputs({ sources: [], enabled: ["openspec-propose"] }, entries);

  expect(await definition.sync?.(sync)).toEqual(["copied skill .agents/skills/openspec-propose (generated source openspec (package openspec))"]);
  expect(lstatSync(join(office, ".agents/skills/openspec-propose")).isDirectory()).toBe(true);
  expect((await list({ sources: [], enabled: ["openspec-propose"] }, entries)).out).toBe(["openspec-explore  generated source openspec (package openspec)  available", "openspec-propose  generated source openspec (package openspec)  enabled"].join("\n"));
  expect(() => definition.sync?.(inputs({ sources: [], enabled: ["openspec-propose", "openspec-onboard"] }, entries).sync)).toThrow("no skill delivery changed: skill openspec-onboard is enabled, but no source offers it");
});

test("the key is the applied version and identity, the revision and the inputs, whatever the inputs' field order, and is computed without generating", () => {
  const parts = { version: "2.1.1", identity: "openspec sha256:a", revision: "1", inputs: { profile: "custom", workflows: ["propose"], delivery: "both" } };
  const key = generatorKey(parts);

  expect(generatorKey({ ...parts, inputs: { delivery: "both", workflows: ["propose"], profile: "custom" } })).toBe(key);

  for (const change of [{ version: "2.1.2" }, { identity: "openspec sha256:b" }, { revision: "2" }, { inputs: { ...parts.inputs, workflows: ["propose", "explore"] } }]) expect(generatorKey({ ...parts, ...change })).not.toBe(key);

  let generated = 0;
  let profile = "core";
  const { ctx, added } = recorder();
  const cli = tools.require(ctx, spec);

  skills.sources.generated(ctx, { id: "openspec", tool: cli, revision: "1", inputs: () => ({ profile }), generate: () => void generated++ });
  const source = generatedSources.parse(added[1].value) as GeneratedSource;

  expect(nextGeneration(office, source, hostRunner)).toEqual({ waiting: "tool npm:@fission-ai/openspec isn't installed yet; office up installs it and generates the source" });
  const { identity } = applyTool("2.1.1");
  const first = nextGeneration(office, source, hostRunner);

  expect(first).toEqual({ ready: { executable: join(office, ".state/tools/current/bin/openspec"), version: "2.1.1", inputs: { profile: "core" }, key: generatorKey({ version: "2.1.1", identity, revision: "1", inputs: { profile: "core" } }), generate: expect.any(Function) } });
  expect(nextGeneration(office, source, hostRunner)).toEqual(first);
  profile = "custom";
  expect(nextGeneration(office, source, hostRunner)).not.toEqual(first);
  expect(generated).toBe(0);
});

test("in a container-mode office only the container's own executable generates, and only inside it; a tools record of the other mode waits, naming why", () => {
  const { added } = openspecSetup();
  const source = generatedSources.parse(added[1].value) as GeneratedSource;
  const bin = mkdtempSync(join(tmpdir(), "office-skills-container-bin-"));
  const path = process.env.PATH;

  write(join(bin, "openspec"), "#!/bin/sh\n");
  chmodSync(join(bin, "openspec"), 0o755);

  try {
    process.env.PATH = bin;
    expect(nextGeneration(office, source, { container: true, inContainer: () => true })).toEqual({ waiting: "office sync hasn't recorded where the office's tools are yet; office sync records it" });
    write(join(office, ".office/runtime/tools.json"), JSON.stringify({ mode: "container" }));
    expect(nextGeneration(office, source, { container: true, inContainer: () => false })).toEqual({ waiting: "this office's tools are its container's, and this process isn't running in a container, so openspec isn't run here; office up generates it from inside the office's container" });
    expect(nextGeneration(office, source, { container: true, inContainer: () => true })).toMatchObject({ ready: { executable: join(bin, "openspec"), version: "container" } });
    expect(nextGeneration(office, source, hostRunner)).toEqual({ waiting: "this office runs in host mode, but its tools record says a container supplies them; office sync rewrites it" });
    applyTool("2.1.1");
    expect(nextGeneration(office, source, { container: true, inContainer: () => true })).toEqual({ waiting: "this office runs in container mode, but its tools record is a host-mode office's; office sync rewrites it" });
  } finally {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  }
});

test("in a container-mode office, inside the container, the generator gets the node on the container's PATH and runs it", async () => {
  const { ctx, added } = recorder();
  const cli = tools.require(ctx, spec);
  const bin = mkdtempSync(join(tmpdir(), "office-skills-container-path-"));
  const path = process.env.PATH;

  skills.sources.generated(ctx, {
    id: "openspec", tool: cli, revision: "1", inputs: () => ({}),
    generate({ output, runtimes }) {
      mkdirSync(join(output, "openspec-propose"));
      execFileSync("node", [join(output, "openspec-propose/SKILL.md")], { env: { PATH: runtimes.join(":") } });
    },
  });
  const source = generatedSources.parse(added[1].value) as GeneratedSource;

  write(join(bin, "openspec"), "#!/bin/sh\n");
  write(join(bin, "node"), "#!/bin/sh\nprintf -- '---\\nname: openspec-propose\\ndescription: from node\\n---\\n' > \"$1\"\n");
  chmodSync(join(bin, "openspec"), 0o755);
  chmodSync(join(bin, "node"), 0o755);
  write(join(office, ".office/runtime/tools.json"), JSON.stringify({ mode: "container" }));

  try {
    process.env.PATH = bin;
    const next = nextGeneration(office, source, { container: true, inContainer: () => true });

    if (!("ready" in next)) throw new Error(next.waiting);
    const container = { dir: office, opencode: { mode: "container" }, tools: {} } as unknown as Office;
    const published = await publishGeneration(office, { owner: "openspec", source, label: "generated source openspec (package openspec)" }, next.ready, () => upRuntimes(container, { PATH: bin }));

    expect(published.skills).toEqual(["openspec-propose"]);
    expect(readFileSync(join(office, generationFolder("openspec", published.generation), "openspec-propose/SKILL.md"), "utf8")).toContain("description: from node");
  } finally {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  }
});

test("skills update moves a pin while a generated source defers an enabled ID, saying so; once the source published, it links that ID too", async () => {
  const repo = mkdtempSync(join(tmpdir(), "office-skills-generated-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const commit = (text: string) => (write(join(repo, "review/SKILL.md"), `---\nname: review\ndescription: ${text}\n---\n`), git("add", "-A"), git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", text), git("rev-parse", "HEAD"));
  const { added } = openspecSetup();
  const entries = entriesOf("openspec", added);
  const out = spyOn(console, "log").mockImplementation(() => undefined);

  try {
    git("init", "-q", "-b", "main");
    let settings: Given = { sources: [{ repo, ref: commit("one"), track: "main", skills: [{ name: "review", path: "review" }] }], enabled: ["review", "openspec-propose"] };
    const replaceSetting = (_path: readonly (string | number)[], value: string | number | boolean) => (settings = { ...settings, sources: [{ ...(settings.sources[0] as object), ref: String(value) }] });

    const update = async () => {
      out.mockClear();
      await definition.commands?.["skills update"]?.run?.({ office: officeInfo(), entries, settings, args: [], replaceSetting, updateExcluded });

      return out.mock.calls.map(call => String(call[0]));
    };

    await definition.sync?.(inputs(settings, entries).sync);
    const second = commit("two");

    expect(await update()).toEqual([
      expect.stringContaining(`pinned`),
      `copied skill .agents/skills/review (${repo} at ${second.slice(0, 12)})`,
      "generated source openspec (package openspec) hasn't published yet: tool npm:@fission-ai/openspec isn't installed yet; office up installs it and generates the source",
      "enabled skills openspec-propose are deferred: no source offers them until generated source openspec (package openspec) publishes",
    ]);

    publish(["openspec-propose"]);
    const third = commit("three");

    expect(await update()).toEqual([
      expect.stringContaining(`→ ${third}`),
      "copied skill .agents/skills/openspec-propose (generated source openspec (package openspec))",
      `copied skill .agents/skills/review (${repo} at ${third.slice(0, 12)})`,
    ]);
    expect(lstatSync(join(office, ".agents/skills/openspec-propose")).isDirectory()).toBe(true);
  } finally {
    out.mockRestore();
    rmSync(repo, { recursive: true, force: true });
  }
});
