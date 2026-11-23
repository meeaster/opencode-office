import { expect, test } from "bun:test";
import * as v from "valibot";
import type { RegistryEntry } from "../sdk/index.ts";
import { registerPackage } from "./package-setup.ts";
import { type PackageManifest, packageManifestSchema } from "./schema.ts";

const manifest = (setup: PackageManifest["setup"]) => v.parse(packageManifestSchema("catalog"), { setup });
const items = { id: "catalog.items", parse: (input: RegistryEntry) => input };
const input = { name: "catalog", settings: {} };

test("one package's setup returns its registries and its unparsed additions", async () => {
  const registered = await registerPackage({ ...input, manifest: manifest(ctx => {
    ctx.registry(items);
    ctx.add(items, { name: "first" });
    ctx.add({ id: "references.repository", parse: entry => entry }, { name: "docs", url: "u" });
  }) });

  expect([...registered.registries.keys()]).toEqual(["catalog.items"]);
  expect(registered.additions).toEqual([{ id: "catalog.items", value: { name: "first" } }, { id: "references.repository", value: { name: "docs", url: "u" } }]);
});

test("a setup that throws, registers another package's registry or adds something other than a JSON object fails the call", async () => {
  await expect(registerPackage({ ...input, manifest: manifest(() => { throw new Error("setup failed"); }) })).rejects.toThrow("setup failed");
  await expect(registerPackage({ ...input, manifest: manifest(ctx => ctx.registry({ id: "other.items", parse: entry => entry })) })).rejects.toThrow("invalid or duplicate registry other.items");
  // An untyped JavaScript definition can pass anything (JSON.parse's result is untyped); the entry is checked at runtime.
  await expect(registerPackage({ ...input, manifest: manifest(ctx => ctx.add(items, JSON.parse('["x"]'))) })).rejects.toThrow("catalog.items: an entry must be a JSON object");
  // Any JSON object is an entry: a name is the registry's parser's to require.
  expect((await registerPackage({ ...input, manifest: manifest(ctx => ctx.add(items, JSON.parse('{"title":"x"}'))) })).additions).toEqual([{ id: "catalog.items", value: { title: "x" } }]);
});
