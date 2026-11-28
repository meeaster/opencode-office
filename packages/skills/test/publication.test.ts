import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Entries, Settings } from "@office/sdk";
import { tools } from "@office/tools";
import { outputFolder, outputRecord, readPublished, sourceFolder } from "../generated.ts";
import { skills } from "../handles.ts";
import { receiptFile } from "../links.ts";
import { acquire, lockFile, takeoverFile } from "../publication.ts";
import definition from "../office.ts";
import type { settingsSchema } from "../settings.ts";
import { applyTool as applyToolIn, entriesOf, host, officeInfo, recorder, spec, write } from "./generated.fixture.ts";

type Given = Settings<typeof settingsSchema>;

let office: string;

/** What the fake generator writes next: one skill folder per ID, or a failure. */
let offered: string[];
let failing: string | undefined;
let calls: number;

/** Every immediate exclusion change, with whether each added path already existed when asked. */
let exclusions: { add?: readonly string[]; remove?: readonly string[]; present?: boolean[] }[];
let onExclude: ((change: { add?: readonly string[] }) => void) | undefined;

/** The runtimes each generator run got. */
let runtimesSeen: (readonly string[])[];

beforeEach(() => {
  office = mkdtempSync(join(tmpdir(), "office-skills-up-"));
  offered = ["openspec-propose", "openspec-explore"];
  failing = undefined;
  calls = 0;
  exclusions = [];
  onExclude = undefined;
  runtimesSeen = [];
});

afterEach(() => {
  rmSync(office, { recursive: true, force: true });
});

/** Entries as office gives them, from what the openspec-like package's setup adds (without `registers`, nothing). */
function entries(registers = true): Entries {
  const { ctx, added } = recorder();
  const cli = tools.require(ctx, spec);

  if (registers) {
    skills.sources.generated(ctx, {
      id: "openspec", tool: cli, revision: "1", inputs: () => ({ offered: [...offered] }),
      generate({ output, inputs, runtimes }) {
        calls++;
        runtimesSeen.push(runtimes);

        if (failing !== undefined) throw new Error(failing);

        for (const id of inputs.offered) write(join(output, id, "SKILL.md"));
        write(join(output, "stray.txt"), "not a skill\n");
      },
    });
  }

  return entriesOf(office, "openspec", added);
}

const info = () => officeInfo(office);

function updateExcluded(change: { add?: readonly string[]; remove?: readonly string[] }) {
  exclusions.push({ ...change, present: change.add?.map(path => lstatSync(join(office, path), { throwIfNoEntry: false }) !== undefined) });
  onExclude?.(change);

  return [...(change.add ?? []).map(path => `excluded /${path.replace(/\/$/, "")}`), ...(change.remove ?? []).map(path => `stopped excluding /${path}`)];
}

const up = (settings: Given, given = entries()) => definition.up?.({ office: info(), entries: given, settings, host, runtimes: () => ["/runtimes/node/bin"], updateExcluded });
const sync = (settings: Given, given = entries()) => definition.sync?.({ office: info(), entries: given, settings, exclude: () => undefined, updateExcluded });
const check = (settings: Given, given = entries()) => definition.check?.({ office: info(), entries: given, settings, host });

const applyTool = (version: string, drift = false) => void applyToolIn(office, version, drift);

const link = (id: string) => join(office, ".agents/skills", id);

const published = () => {
  const found = readPublished(office, "openspec");

  if (found === undefined) throw new Error("openspec isn't published");

  return found;
};

const sourceEntries = () => readdirSync(join(office, sourceFolder("openspec"))).sort();
const stable = () => join(office, outputFolder("openspec"));
const label = "generated source openspec (package openspec)";

test("up generates once, publishes stable output, and excludes each copy before it appears", async () => {
  applyTool("2.1.1");
  const settings = { sources: [], enabled: ["openspec-propose"] };

  expect(await up(settings)).toEqual([`${label}: generated openspec-explore, openspec-propose with npm:@fission-ai/openspec 2.1.1`, "excluded /.agents/skills/openspec-propose", "copied skill .agents/skills/openspec-propose (generated source openspec (package openspec))"]);
  expect(calls).toBe(1);
  expect(runtimesSeen).toEqual([["/runtimes/node/bin"]]);
  expect(exclusions[0]).toEqual({ add: [".agents/skills/openspec-propose/"], present: [false] });
  expect(lstatSync(link("openspec-propose")).isDirectory()).toBe(true);
  expect(readFileSync(join(link("openspec-propose"), "SKILL.md"), "utf8")).toContain("description");
  expect(published().skills).toEqual(["openspec-explore", "openspec-propose"]);
  expect(published().folder).toBe(outputFolder("openspec"));
  expect(sourceEntries()).toEqual(["output"]);
  expect(lstatSync(stable()).isDirectory()).toBe(true);
  expect(await up(settings)).toEqual([]);
  expect(await sync(settings)).toEqual([]);
  expect(calls).toBe(1);
  expect(await check(settings)).toEqual([]);
});

test("a changed key replaces stable output and leaves neighboring folders alone", async () => {
  applyTool("2.1.1");
  const settings = { sources: [], enabled: ["openspec-propose"] };

  await up(settings);
  const first = published().key;
  const source = join(office, sourceFolder("openspec"));

  write(join(source, "notes/keep.md"), "owner's\n");
  write(join(office, sourceFolder("other"), "output/x/SKILL.md"));
  write(join(office, ".office/cache/openspec/conduct/change.patch"), "durable\n");
  offered = ["openspec-propose", "openspec-explore", "openspec-verify-change"];
  applyTool("2.1.2");

  const lines = await up(settings);

  expect(calls).toBe(2);
  expect(lines).toEqual([`${label}: generated openspec-explore, openspec-propose, openspec-verify-change with npm:@fission-ai/openspec 2.1.2`]);
  expect(published().key).not.toBe(first);
  expect(sourceEntries()).toEqual(["notes", "output"]);
  expect(JSON.parse(readFileSync(join(stable(), outputRecord), "utf8"))).toEqual({ key: published().key, skills: published().skills });
  expect(readFileSync(join(source, "notes/keep.md"), "utf8")).toBe("owner's\n");
  expect(existsSync(join(office, sourceFolder("other"), "output/x/SKILL.md"))).toBe(true);
  expect(readFileSync(join(office, ".office/cache/openspec/conduct/change.patch"), "utf8")).toBe("durable\n");
  // Identical output was not delivered again. The added ID is available but not enabled.
  expect(existsSync(join(link("openspec-propose"), "SKILL.md"))).toBe(true);
  expect(existsSync(link("openspec-verify-change"))).toBe(false);
  expect(await sync({ sources: [], enabled: ["openspec-propose", "openspec-verify-change"] })).toEqual([
    "excluded /.agents/skills/openspec-verify-change",
    "copied skill .agents/skills/openspec-verify-change (generated source openspec (package openspec))",
  ]);
});

test("a generator failure, a removed enabled ID or a conflict leaves published output and copies unchanged", async () => {
  applyTool("2.1.1");
  write(join(office, "skills/openspec-explore/SKILL.md"));
  const settings = { sources: [], enabled: ["openspec-propose"] };

  await up(settings);
  const snapshot = () => ({ published: published(), inode: lstatSync(stable()).ino, receipt: readFileSync(join(office, receiptFile), "utf8"), entries: sourceEntries() });
  const before = snapshot();
  const unchanged = () => expect(snapshot()).toEqual(before);

  applyTool("2.1.2");
  failing = "openspec init exited 1";
  await expect(up(settings)).rejects.toThrow(`${label}: its generator failed with npm:@fission-ai/openspec 2.1.2: openspec init exited 1; published generated skills and their deliveries stay as they were`);
  unchanged();

  failing = undefined;
  offered = ["openspec-explore"];
  await expect(up(settings)).rejects.toThrow("no skill delivery changed: skill openspec-propose is enabled, but no source offers it; published generated skills and their deliveries stay as they were");
  unchanged();

  offered = ["openspec-propose", "openspec-explore"];
  await expect(up({ sources: [{ folder: "skills" }], enabled: ["openspec-propose"] })).rejects.toThrow(`skill openspec-explore is offered by more than one source: ${label} and folder skills`);
  unchanged();
  expect(existsSync(join(link("openspec-propose"), "SKILL.md"))).toBe(true);
});

test("a published source keeps its skills while its tool is below the minimum or changed; up and check say so", async () => {
  applyTool("2.1.1");
  const settings = { sources: [], enabled: ["openspec-propose"] };

  await up(settings);
  applyTool("2.0.0");
  expect(await up(settings)).toEqual([`${label} keeps its published skills: the applied npm:@fission-ai/openspec 2.0.0 is below the 2.1.0 it needs; office up --upgrade applies a newer one and generates the source`]);
  expect(await check(settings)).toEqual([{ level: "warning", message: `${label} keeps its published skills: the applied npm:@fission-ai/openspec 2.0.0 is below the 2.1.0 it needs; office up --upgrade applies a newer one and generates the source` }]);
  applyTool("2.1.1", true);
  expect((await check(settings))?.[0]?.message).toMatch(/keeps its published skills: tool npm:@fission-ai\/openspec 2\.1\.1: its applied executable openspec .* office activated/);
  expect(existsSync(join(link("openspec-propose"), "SKILL.md"))).toBe(true);
  expect(calls).toBe(1);
  applyTool("2.1.1");
  offered = ["openspec-propose"];
  expect(await check(settings)).toEqual([{ level: "warning", message: `${label} was generated for another tool or profile; office up generates it again` }]);
});

test("a source never published whose tool can't run fails up for the IDs it defers, naming why", async () => {
  await expect(up({ sources: [], enabled: ["openspec-propose"] })).rejects.toThrow(`no skill delivery changed: skill openspec-propose is enabled, but no source offers it; ${label} hasn't published yet: tool npm:@fission-ai/openspec isn't installed yet; office up installs it and generates the source`);
  expect(calls).toBe(0);
});

test("readers ignore abandoned staged output", async () => {
  applyTool("2.1.1");
  const settings = { sources: [], enabled: ["openspec-propose"] };

  await up(settings);
  const first = published();
  const leftover = join(office, sourceFolder("openspec"), ".stage-interrupted");

  write(join(leftover, "openspec-propose/SKILL.md"), "never published\n");
  write(join(leftover, outputRecord), JSON.stringify({ key: "sha256:other", skills: ["openspec-propose"] }));

  expect(await sync(settings)).toEqual([]);
  expect(await check(settings)).toEqual([]);
  expect(published()).toEqual(first);
});

test("sync keeps an enabled copy when an interrupted up left its output missing", async () => {
  applyTool("2.1.1");
  const settings = { sources: [], enabled: ["openspec-propose"] };
  await up(settings);
  const path = join(link("openspec-propose"), "SKILL.md");
  const previous = lstatSync(path).ino;

  renameSync(stable(), join(office, sourceFolder("openspec"), ".old-interrupted"));
  applyTool("2.0.0");
  expect(await sync(settings)).toContainEqual(expect.stringContaining("openspec-propose are deferred"));
  expect(lstatSync(path).ino).toBe(previous);
  await expect(up(settings)).rejects.toThrow("no source offers it");
  expect(lstatSync(path).ino).toBe(previous);
});

test("an ordinary file at output stops up before anything is generated or changed", async () => {
  applyTool("2.1.1");
  write(stable(), "not a folder\n");

  await expect(up({ sources: [], enabled: ["openspec-propose"] })).rejects.toThrow(`${outputFolder("openspec")} is a link or not a folder`);
  expect(calls).toBe(0);
  expect(exclusions).toEqual([]);
  expect(sourceEntries()).toEqual(["output"]);
  expect(readFileSync(stable(), "utf8")).toBe("not a folder\n");
});

test("a failed exclusion stops up before any copy or output is published; the candidate goes", async () => {
  applyTool("2.1.1");
  onExclude = () => {
    throw new Error("info/exclude has 2 start lines, not one block");
  };

  await expect(up({ sources: [], enabled: ["openspec-propose"] })).rejects.toThrow("info/exclude has 2 start lines, not one block; published generated skills and their deliveries stay as they were");
  expect(existsSync(link("openspec-propose"))).toBe(false);
  expect(sourceEntries()).toEqual([]);
});

test("a redirected source, output or record is refused before anything is written through it", async () => {
  applyTool("2.1.1");
  const settings = { sources: [], enabled: ["openspec-propose"] };
  const elsewhere = mkdtempSync(join(tmpdir(), "office-skills-elsewhere-"));

  try {
    write(join(elsewhere, "aaaaaaaaaaaa-00000000/keep.md"), "elsewhere's\n");
    mkdirSync(join(office, sourceFolder("openspec")), { recursive: true });
    symlinkSync(elsewhere, stable());

    await expect(up(settings)).rejects.toThrow(`${outputFolder("openspec")} is a link or not a folder, so office neither writes nor removes generated skills through it`);
    expect(readdirSync(elsewhere)).toEqual(["aaaaaaaaaaaa-00000000"]);
    expect(readFileSync(join(elsewhere, "aaaaaaaaaaaa-00000000/keep.md"), "utf8")).toBe("elsewhere's\n");

    rmSync(join(office, sourceFolder("openspec")), { recursive: true });
    symlinkSync(elsewhere, join(office, sourceFolder("openspec")));
    await expect(up(settings)).rejects.toThrow(`${sourceFolder("openspec")} is a link or not a folder`);
    expect(readdirSync(elsewhere)).toEqual(["aaaaaaaaaaaa-00000000"]);

    rmSync(join(office, sourceFolder("openspec")));
    mkdirSync(stable(), { recursive: true });
    symlinkSync(join(elsewhere, "aaaaaaaaaaaa-00000000/keep.md"), join(stable(), outputRecord));
    await expect(up(settings)).rejects.toThrow(`${outputFolder("openspec")}/${outputRecord} isn't a record of published skills`);
    expect(calls).toBe(0);
    expect(readFileSync(join(elsewhere, "aaaaaaaaaaaa-00000000/keep.md"), "utf8")).toBe("elsewhere's\n");
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test("one up at a time generates in an office: a running one's lock stops another, naming it; a dead one's is taken over", async () => {
  applyTool("2.1.1");
  const settings = { sources: [], enabled: ["openspec-propose"] };

  write(join(office, lockFile), `${process.pid}\n`);
  await expect(up(settings)).rejects.toThrow(`another office up (process ${process.pid}) is generating skills in this office; wait for it and run office up again, or remove ${lockFile} if none is running`);
  expect(calls).toBe(0);
  expect(readFileSync(join(office, lockFile), "utf8")).toBe(`${process.pid}\n`);

  const gone = spawnSync("true").pid;

  writeFileSync(join(office, lockFile), `${gone}\n`);
  await up(settings);
  expect(calls).toBe(1);
  expect(existsSync(join(office, lockFile))).toBe(false);
});

test("of two ups taking over the same dead one's lock, exactly one acquires, whichever step the other reaches first", () => {
  const gone = spawnSync("true").pid;
  const path = join(office, lockFile);

  const contend = () => {
    try {
      return acquire(office);
    } catch (error) {
      return error as Error;
    }
  };

  for (const at of ["stale", "guarded"] as const) {
    write(path, `${gone}\n`);
    let other: (() => void) | Error | undefined;
    let first: (() => void) | Error;

    try {
      first = acquire(office, step => { if (step === at) other = contend(); });
    } catch (error) {
      first = error as Error;
    }

    const acquired = [first, other].filter(result => typeof result === "function");

    expect(acquired).toHaveLength(1);
    expect([first, other].filter(result => result instanceof Error)).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe(`${process.pid}\n`);
    expect(existsSync(join(office, takeoverFile))).toBe(false);
    (acquired[0] as () => void)();
    expect(existsSync(path)).toBe(false);
  }
});

test("with no generated source declared, up does no link work at all", async () => {
  write(join(office, "skills/alpha/SKILL.md"));

  expect(await up({ sources: [{ folder: "skills" }], enabled: ["alpha"] }, entries(false))).toEqual([]);
  expect(existsSync(link("alpha"))).toBe(false);
  expect(exclusions).toEqual([]);
});

test("a never-published source whose tool can't run is named once in up's lines", async () => {
  write(join(office, "skills/alpha/SKILL.md"));

  const lines = (await up({ sources: [{ folder: "skills" }], enabled: ["alpha"] })) ?? [];

  expect(lines.filter(line => line.includes("hasn't published yet"))).toEqual([`${label} hasn't published yet: tool npm:@fission-ai/openspec isn't installed yet; office up installs it and generates the source`]);
});

test("in a mixed office, up refuses a Git checkout that isn't at its pinned commit before generating", async () => {
  applyTool("2.1.1");
  const repo = "https://example.invalid/skills.git";
  const ref = "c".repeat(40);
  const checkout = join(office, ".office/skills/git");

  mkdirSync(checkout, { recursive: true });
  const { checkoutFolder } = await import("../git.ts");

  mkdirSync(join(office, checkoutFolder(repo, ref)), { recursive: true });
  write(join(office, checkoutFolder(repo, ref), "review/SKILL.md"));

  await expect(up({ sources: [{ repo, ref, skills: [{ name: "review", path: "review" }] }], enabled: ["review"] })).rejects.toThrow(`no skill delivery changed: ${checkoutFolder(repo, ref)} isn't a checkout of ${ref.slice(0, 12)}; remove it and sync again`);
  expect(calls).toBe(0);
});

test("a link that appears while up applies stops it after publication; its exclusion is released, the rest is left for the next up", async () => {
  applyTool("2.1.1");
  onExclude = change => {
    if (change.add?.length) write(join(link("openspec-propose"), "SKILL.md"));
  };

  await expect(up({ sources: [], enabled: ["openspec-propose"] })).rejects.toThrow(".agents/skills/openspec-propose is already there and isn't a delivery this package recorded");
  expect(exclusions.at(-1)).toEqual({ remove: [".agents/skills/openspec-propose"], present: undefined });
  expect(published().skills).toEqual(["openspec-explore", "openspec-propose"]);
  expect(lstatSync(link("openspec-propose")).isDirectory()).toBe(true);
});

test("withdrawn, a source offers nothing: its enabled IDs stop sync until disabled, then only its links go; a manual skill and its generated folder stay", async () => {
  applyTool("2.1.1");
  write(join(link("manual"), "SKILL.md"));
  await up({ sources: [], enabled: ["openspec-propose"] });

  expect(() => sync({ sources: [], enabled: ["openspec-propose"] }, entries(false))).toThrow("no skill delivery changed: skill openspec-propose is enabled, but no source offers it");
  expect(await sync({ sources: [], enabled: [] }, entries(false))).toEqual(["removed skill copy .agents/skills/openspec-propose"]);
  expect(existsSync(link("openspec-propose"))).toBe(false);
  expect(existsSync(join(link("manual"), "SKILL.md"))).toBe(true);
  expect(existsSync(join(stable(), "openspec-propose/SKILL.md"))).toBe(true);
});
