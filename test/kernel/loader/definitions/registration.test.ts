import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { installedPackages } from "../../../../src/loader/definitions/inventory.ts";
import { registerPackages } from "../../../../src/loader/definitions/registration.ts";
import { requiredPackages } from "../../../../src/loader/sources/selection.ts";
import { loadOffice } from "../../../../src/office.ts";
import { definitionText } from "../../../support/test-package.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-registration-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, text: string) {
  const file = join(dir, path);

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function pkg(name: string, body: string, integrations: Record<string, string> = {}) {
  write(`packages/${name}/package.json`, JSON.stringify({ name: `@office/${name}`, office: { definition: "./office.ts", integrations } }));
  write(`packages/${name}/office.ts`, body);
}

async function register(...names: string[]) {
  write("office.yaml", `name: t\npackages:\n${names.map(name => `  - name: ${name}\n`).join("")}`);
  const office = loadOffice(dir);
  const inventory = installedPackages(office, new Set(requiredPackages));
  const failures: { name: string; cause: unknown }[] = [];
  const setUp = await registerPackages(office, inventory, (name, cause) => failures.push({ name, cause }));

  return { setUp, failures };
}

const offer = `{ id: "provider.offers", parse: entry => entry }`;
const integration = (body: string) => `import { Package } from "@office/sdk";\nexport default Package.integration()(${body});\n`;

test("only selected integrations run, sequentially after their package's setup; an unread provider is a failure", async () => {
  pkg("consumer", definitionText(`{settings:{type:"object",properties:{title:{type:"string",default:"T"}}},async setup(ctx){await Promise.resolve(); ctx.add(${offer}, { directory: "own" });}}`), { "@office/provider": "./adapters/skills.ts" });
  write("packages/consumer/adapters/skills.ts", integration(`{ setup(ctx) { ctx.add(${offer}, { directory: "skills/review", title: ctx.settings.title }); } }`));
  pkg("provider", definitionText(`{ setup(ctx) { ctx.registry(${offer}); } }`));

  const absent = await register("consumer");
  expect(absent.failures).toEqual([]);
  expect(absent.setUp[0].registered.additions).toEqual([{ id: "provider.offers", value: { directory: "own" } }]);

  const active = await register("consumer", "provider");
  expect(active.failures).toEqual([]);
  expect(active.setUp.map(pkg => pkg.name)).toEqual(["consumer", "provider"]);
  expect([...active.setUp[1].registered.registries.keys()]).toEqual(["provider.offers"]);
  expect(active.setUp[0].registered.additions).toEqual([
    { id: "provider.offers", value: { directory: "own" } },
    { id: "provider.offers", value: { directory: "skills/review", title: "T" } },
  ]);

  pkg("broken", 'throw new Error("broken provider");');
  pkg("other", definitionText("{}"), { "@office/broken": "./adapters/broken.ts" });
  write("packages/other/adapters/broken.ts", 'throw new Error("must not import an unread provider’s integration");');
  expect((await register("broken", "other")).failures).toEqual([
    { name: "other", cause: expect.objectContaining({ message: "integration @office/broken (adapters/broken.ts): package broken is selected but didn't load, so this integration can't run; fix package broken" }) },
  ]);
});

test("integration failures name the provider and module, retain the cause, and are reported in package order", async () => {
  pkg("provider", definitionText("{}"));

  for (const [name, module] of [
    ["failing", integration('{ setup() { throw new Error("no app name"); } }')],
    ["broken", 'import { apps } from "@office/absent-provider/apps";\nexport default apps;\n'],
    ["plain", "export default { setup() {} };\n"],
    ["getter", `import { Package } from "@office/sdk";\nlet reads = 0;
const exported = Package.integration()({ get setup() {
  if (++reads > 1) throw new Error("read twice");
  return function (ctx) { ctx.add(${offer}, { receiver: this === exported }); };
} });
export default exported;\n`],
    ["unreadable", integration('{ get setup() { throw new Error("no setup yet"); } }')],
    ["undefined", integration("{ setup() { throw undefined; } }")],
  ] as const) {
    pkg(name, definitionText("{}"), { "@office/provider": "./skills.ts" });
    write(`packages/${name}/skills.ts`, module);
  }

  const { setUp, failures } = await register("provider", "failing", "broken", "plain", "getter", "unreadable", "undefined");

  expect(setUp.map(pkg => pkg.name)).toEqual(["provider", "getter"]);
  expect(setUp[1].registered.additions).toEqual([{ id: "provider.offers", value: { receiver: true } }]);
  expect(failures.map(({ name, cause }) => [name, cause instanceof Error ? cause.message : cause])).toEqual([
    ["failing", "integration @office/provider (skills.ts): its setup failed: no app name"],
    ["broken", expect.stringContaining("integration @office/provider (skills.ts): its module failed to load: Cannot find package '@office/absent-provider'")],
    ["plain", "integration @office/provider (skills.ts): its default export must be the result of Package.integration from @office/sdk, with a setup function"],
    ["unreadable", "integration @office/provider (skills.ts): its setup failed: no setup yet"],
    ["undefined", "integration @office/provider (skills.ts): its setup failed: undefined"],
  ]);
  const [failing, broken, plain, unreadable, thrownUndefined] = failures.map(failure => failure.cause);

  expect(failing).toHaveProperty("cause.message", "no app name");
  expect(broken).toHaveProperty("cause", expect.any(Error));
  expect(plain).not.toHaveProperty("cause");
  expect(unreadable).toHaveProperty("cause.message", "no setup yet");
  expect(thrownUndefined).toHaveProperty("cause", undefined);
});

test("registration validates what setup adds and keeps a valid package's unparsed entries", async () => {
  pkg("foreign", definitionText(`{ setup(ctx) { ctx.registry(${offer}); } }`));
  pkg("array", definitionText(`{ setup(ctx) { ctx.add(${offer}, ["x"]); } }`));
  pkg("catalog", definitionText(`{ setup(ctx) {
    const own = { id: "catalog.items", parse() { throw new Error("parsed too early"); } };
    ctx.registry(own);
    ctx.add(own, { name: "first" });
    ctx.add(${offer}, { title: "x" });
  } }`));

  const { setUp, failures } = await register("foreign", "array", "catalog");

  expect(failures.map(({ name, cause }) => [name, cause instanceof Error ? cause.message : cause])).toEqual([
    ["foreign", "invalid or duplicate registry provider.offers"],
    ["array", "provider.offers: an entry must be a JSON object"],
  ]);
  expect(setUp.map(pkg => pkg.name)).toEqual(["catalog"]);
  expect([...setUp[0].registered.registries.keys()]).toEqual(["catalog.items"]);
  expect(setUp[0].registered.additions).toEqual([
    { id: "catalog.items", value: { name: "first" } },
    { id: "provider.offers", value: { title: "x" } },
  ]);
});
