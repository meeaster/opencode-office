// The SDK on disk as sync writes it, and `ctx.settings` typed from a definition's settings schema,
// checked by tsc against that copy with the office template's compiler settings.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeSdk } from "./package-imports.ts";

let office: string;

beforeEach(() => { office = mkdtempSync(join(tmpdir(), "office-sdk-types-")); });

afterEach(() => { rmSync(office, { recursive: true, force: true }); });

// Each @ts-expect-error must meet an error, and every other line must check: tsc fails otherwise.
const definition = `import { Package, type SettingValue } from "@office/sdk";

// Whether two types are the same, for a type's exact shape rather than what it is assignable to.
type Same<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

export default Package.define({
  settings: {
    type: "object",
    additionalProperties: false,
    required: ["account"],
    properties: {
      port: { type: "integer", default: 4566 },
      ratio: { type: "number", default: 0.5 },
      verbose: { type: "boolean", default: false },
      account: { type: "string" },
      note: { type: "string" },
      storage: { enum: ["memory", "persistent"], default: "memory" },
      tags: { type: "array", items: { type: "string" }, default: [] },
      limits: { type: "object", required: ["cpu"], properties: { cpu: { type: "integer" }, memory: { type: "string" } } },
      models: { $ref: "#/$defs/models" },
      mode: { type: "string" },
      pair: { type: "array", prefixItems: [{ type: "string" }], items: { type: "integer" }, default: [] },
    },
    if: { properties: { verbose: { const: true } } },
    then: { properties: { mode: { default: "loud" } } },
    $defs: { models: { type: "array", items: { type: "string" } } },
  },
  setup(ctx) {
    const port: number = ctx.settings.port + ctx.settings.ratio;
    const verbose: boolean = ctx.settings.verbose;
    const account: string = ctx.settings.account;
    const storage: "memory" | "persistent" = ctx.settings.storage;
    const tags: string[] = ctx.settings.tags;
    const note: string | undefined = ctx.settings.note;
    const cpu: number | undefined = ctx.settings.limits?.cpu;
    // @ts-expect-error a property with neither a default nor required may be undefined
    const required: string = ctx.settings.note;
    // @ts-expect-error a misspelled setting
    ctx.settings.prot;
    // @ts-expect-error a number where text is expected
    const text: string = ctx.settings.port;
    // @ts-expect-error an enum is its choices, not any text
    const other: "other" = ctx.settings.storage;
    // @ts-expect-error a nested property keeps its type
    const memory: number | undefined = ctx.settings.limits?.memory;
    // A property behind a $ref is loose, beside a sibling that keeps its type.
    const models: Same<typeof ctx.settings.models, SettingValue | undefined> = true;
    // @ts-expect-error a loose property isn't taken for text
    const modelText: string | undefined = ctx.settings.models;
    // @ts-expect-error a default inside an if branch doesn't make the property present
    const mode: string = ctx.settings.mode;
    // A list with prefixItems isn't taken for a list of its items.
    const pair: Same<typeof ctx.settings.pair, SettingValue[]> = true;
    // @ts-expect-error its first item is text
    const numbers: number[] = ctx.settings.pair;

    void [port, verbose, account, storage, tags, note, cpu, required, text, other, memory, models, modelText, mode, pair, numbers];
  },
  commands: {
    "typed show": { summary: "Show", usage: "<path>", run({ settings, args, office }) { const port: number = settings.port; const words: readonly string[] = args; const dir: string = office.dir; void [port, words, dir]; } },
  },
  committed: [".office/typed/"],
  sync({ settings, office, entries }) {
    const port: number = settings.port;

    void [port, office.dir, entries];

    return [\`synced \${office.dir}\`];
  },
  check: ({ settings, host }) => [{ level: settings.verbose ? "warning" : "failed", message: \`typed \${host.timers.status().length}\` }],
  up({ settings, office, entries, host }) {
    const mode: "host" | "managed-host" | "container" = office.mode;

    void [entries, mode];

    return host.timers.set([{ id: "tick", calendar: "*-*-* 06:00:00 UTC", run: [office.name, String(settings.port)] }]);
  },
  down: ({ settings, host }) => [String(settings.port), ...host.timers.clear()],
});

// \`down\` runs no setup, so it has no registries to read.
export const downOnly = Package.define({
  // @ts-expect-error down gets no entries
  down({ entries }) { void entries; },
});

export const problems = Package.define({
  // @ts-expect-error a problem is a warning or a failure
  check: () => [{ level: "info", message: "x" }],
});

// A root the typing doesn't cover makes the whole object loose, and any of its keys may be absent.
export const loose = Package.define({
  settings: { type: "object", oneOf: [{ properties: { a: { type: "string" } } }] },
  setup(ctx) {
    const anything: Same<typeof ctx.settings.whatever, SettingValue | undefined> = true;
    // @ts-expect-error it may be absent
    const present: SettingValue = ctx.settings.whatever;

    void [anything, present];
  },
});

// A command has one handler: result returns its text, run acts.
export const handlers = Package.define({
  commands: {
    "text show": { summary: "Show", result: ({ args }) => args.join(" ") },
    "text later": { summary: "Later", async result({ office }) { return office.name; } },
    // @ts-expect-error a result is text
    "text count": { summary: "Count", result: () => 7 },
    // @ts-expect-error not both
    "text both": { summary: "Both", result: () => "", run() {} },
    // @ts-expect-error nor neither
    "text none": { summary: "None" },
  },
});

// With no settings declared, there are none to read.
export const none = Package.define({
  setup(ctx) {
    // @ts-expect-error no such setting
    void ctx.settings.anything;
  },
  commands: {
    // @ts-expect-error nor in a command
    "none show": { summary: "Show", run({ settings }) { void settings.anything; } },
  },
});
`;

test("sync writes the SDK's own source beside the package links: types for editors, a runtime entry that throws", () => {
  writeSdk(office);
  const written = join(office, "node_modules/@office/sdk");
  const files = readdirSync(written).sort();

  expect(files).toEqual(readdirSync(join(import.meta.dir, "../sdk")).sort());

  for (const file of files) expect(readFileSync(join(written, file), "utf8")).toBe(readFileSync(join(import.meta.dir, "../sdk", file), "utf8"));

  expect(JSON.parse(readFileSync(join(written, "package.json"), "utf8"))).toMatchObject({ name: "@office/sdk", exports: { ".": { types: "./index.ts", default: "./disk.js" } } });
  // Loaded by ordinary resolution instead of the executable's redirect, it says so.
  const loaded = Bun.spawnSync([process.execPath, "-e", 'await import("@office/sdk")'], { cwd: office });

  expect(loaded.exitCode).not.toBe(0);
  expect(loaded.stderr.toString()).toContain("@office/sdk was loaded from disk; the executable's SDK was not registered");
});

test("ctx.settings has each setting's type, with no annotation and no as const", () => {
  writeSdk(office);
  copyFileSync(join(import.meta.dir, "../template/office/tsconfig.json"), join(office, "tsconfig.json"));
  const file = join(office, "packages/typed/office.ts");

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, definition);
  const tsc = Bun.spawnSync([join(import.meta.dir, "../node_modules/.bin/tsc"), "--noEmit", "-p", join(office, "tsconfig.json")], { cwd: office });

  expect(tsc.stdout.toString() + tsc.stderr.toString()).toBe("");
  expect(tsc.exitCode).toBe(0);
});
