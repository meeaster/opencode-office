import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import type { RegistryEntry, SettingValue } from "../sdk/index.ts";
import { loadIntegrations, type OptionalIntegration, selectedIntegrations } from "./package-integrations.ts";
import { registerPackage } from "./package-setup.ts";
import { packageManifestSchema } from "./schema.ts";

let dir: string;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "office-integrations-")); });

afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const skills: OptionalIntegration = { provider: "skills", module: "skills.ts" };

const selection = (selected: string[], unread: string[] = []) => ({ selected: new Set(selected), unread: new Set(unread) });

/** The Error `run` throws or rejects with. */
async function failureOf(run: () => void | Promise<void>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) return error;

    throw error;
  }

  throw new Error("expected a failure");
}

test("an integration runs exactly while its provider is selected; a selected provider that didn't load fails it rather than counting as absent", async () => {
  expect(selectedIntegrations([skills], selection(["review-kit", "skills"]))).toEqual([skills]);
  expect(selectedIntegrations([skills], selection(["review-kit"]))).toEqual([]);
  expect((await failureOf(() => { selectedIntegrations([skills], selection(["review-kit", "skills"], ["skills"])); })).message).toBe("integration @office/skills (skills.ts): package skills is selected but didn't load, so this integration can't run; fix package skills");
});

test("a module loads from the package's folder, its setup naming it with the cause when it throws; a module that throws or isn't Package.integration's is named with its cause", async () => {
  mkdirSync(join(dir, "adapters"));
  writeFileSync(join(dir, "adapters/good.ts"), 'import { Package } from "@office/sdk";\nexport default Package.integration()({ setup(ctx) { ctx.add({ id: "skills.offers", parse: entry => entry }, { directory: "skills/review" }); } });\n');
  writeFileSync(join(dir, "adapters/failing.ts"), 'import { Package } from "@office/sdk";\nexport default Package.integration()({ setup() { throw new Error("no app name"); } });\n');
  writeFileSync(join(dir, "adapters/broken.ts"), 'import { apps } from "@office/absent-provider/apps";\nexport default apps;\n');
  writeFileSync(join(dir, "adapters/plain.ts"), "export default { setup() {} };\n");
  const at = (module: string): OptionalIntegration => ({ provider: "skills", module });
  const added: RegistryEntry[] = [];
  const [good, failing] = loadIntegrations(dir, [at("adapters/good.ts"), at("adapters/failing.ts")]);

  await good?.setup({ settings: {}, add: (_handle, value) => { added.push(value); } });
  expect(added).toEqual([{ directory: "skills/review" }]);
  await expect(failing?.setup({ settings: {}, add() {} })).rejects.toMatchObject({ cause: { message: "no app name" }, message: "integration @office/skills (adapters/failing.ts): its setup failed: no app name" });

  const broken = (() => {
    try {
      loadIntegrations(dir, [at("adapters/broken.ts")]);
    } catch (error) {
      return error;
    }
  })();

  expect(String(broken)).toContain("integration @office/skills (adapters/broken.ts): its module failed to load: Cannot find package '@office/absent-provider'");
  expect(broken instanceof Error && broken.cause instanceof Error).toBe(true);
  expect(() => loadIntegrations(dir, [at("adapters/plain.ts")])).toThrow("integration @office/skills (adapters/plain.ts): its default export must be the result of Package.integration from @office/sdk, with a setup function");
});

test("an integration's setup is read once, through the wrapper that keeps the cause, and called on its export; a thrown undefined is kept as the cause", async () => {
  const sdk = 'import { Package } from "@office/sdk";\n';

  // Its getter gives a setup recording its receiver the first time, and throws after.
  writeFileSync(join(dir, "getter.ts"), `${sdk}let reads = 0;
const exported = Package.integration()({ get setup() {
  if (++reads > 1) throw new Error("read twice");
  return function (ctx) { ctx.add({ id: "skills.offers", parse: entry => entry }, { receiver: this === exported }); };
} });
export default exported;
`);
  writeFileSync(join(dir, "unreadable.ts"), `${sdk}export default Package.integration()({ get setup() { throw new Error("no setup yet"); } });\n`);
  writeFileSync(join(dir, "undefined.ts"), `${sdk}export default Package.integration()({ setup() { throw undefined; } });\n`);
  writeFileSync(join(dir, "plain.ts"), "export default { setup() {} };\n");
  const at = (module: string): OptionalIntegration => ({ provider: "skills", module });

  const added: RegistryEntry[] = [];
  const [getter, undefinedThrower] = loadIntegrations(dir, [at("getter.ts"), at("undefined.ts")]);

  await getter?.setup({ settings: {}, add: (_handle, value) => { added.push(value); } });
  expect(added).toEqual([{ receiver: true }]);

  const rejected = await failureOf(async () => { await undefinedThrower?.setup({ settings: {}, add() {} }); });

  expect(rejected.message).toBe("integration @office/skills (undefined.ts): its setup failed: undefined");
  expect(Object.hasOwn(rejected, "cause") && rejected.cause === undefined).toBe(true);
  expect(await failureOf(() => { loadIntegrations(dir, [at("unreadable.ts")]); })).toMatchObject({ cause: { message: "no setup yet" }, message: "integration @office/skills (unreadable.ts): its setup failed: no setup yet" });

  // A problem found with nothing thrown has no cause.
  expect(Object.hasOwn(await failureOf(() => { loadIntegrations(dir, [at("plain.ts")]); }), "cause")).toBe(false);
});

test("an integration's setup runs after its package's own and adds as that package; what it throws fails the registration", async () => {
  const offers = { id: "skills.offers", parse: (entry: RegistryEntry) => entry };
  const manifest = v.parse(packageManifestSchema("review-kit"), { setup(ctx: { add: (handle: typeof offers, value: RegistryEntry) => void }) { ctx.add(offers, { directory: "own" }); } });
  const seen: SettingValue[] = [];

  const registered = await registerPackage({ name: "review-kit", manifest, settings: { title: "T" }, selected: new Set(), integrations: [{ setup(ctx) {
    seen.push(ctx.settings.title ?? null);
    ctx.add(offers, { directory: "skills/review" });
  } }] });

  expect(registered.additions).toEqual([{ id: "skills.offers", value: { directory: "own" } }, { id: "skills.offers", value: { directory: "skills/review" } }]);
  expect(seen).toEqual(["T"]);

  const boom = new Error("no app name");

  await expect(registerPackage({ name: "review-kit", manifest, settings: {}, selected: new Set(), integrations: [{ setup() { throw boom; } }] })).rejects.toBe(boom);
});
