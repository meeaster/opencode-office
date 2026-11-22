import { expect, test } from "bun:test";
import * as v from "valibot";
import { registerPackage } from "./package-setup.ts";
import { type PackageManifest, packageManifestSchema } from "./schema.ts";

const manifest = (setup: PackageManifest["setup"]) => v.parse(packageManifestSchema, { name: "catalog", description: "Catalog", setup });
const items = { id: "catalog.items", parse: (input: { name: string }) => input };

test("one package's setup returns its collections, unparsed additions and commands", async () => {
  const run = () => {};

  const registered = await registerPackage({ dir: "/nowhere", name: "catalog", overrides: {}, settings: {}, manifest: manifest(ctx => {
    ctx.collection(items);
    ctx.add(items, { name: "first" });
    // The one-argument form earlier definitions use.
    (ctx.add as unknown as (row: unknown) => void)({ registry: "references.repository", value: { name: "docs", url: "u" } });
    ctx.command({ name: "items show", aliases: ["items"], summary: "Show", run });
    ctx.command({ name: "Bad Name", summary: "Show", run });
  }) });

  expect([...registered.collections.keys()]).toEqual(["catalog.items"]);
  expect(registered.additions).toEqual([{ id: "catalog.items", value: { name: "first" } }, { id: "references.repository", value: { name: "docs", url: "u" } }]);
  expect(registered.commands).toEqual([{ name: "items show", aliases: ["items"], summary: "Show", run }]);
  expect(registered.invalid.join("\n")).toContain('package catalog: command: name: invalid route "Bad Name"');
});

test("a setup that throws, or registers another package's collection, fails the call", async () => {
  const input = { dir: "/nowhere", name: "catalog", overrides: {}, settings: {} };

  await expect(registerPackage({ ...input, manifest: manifest(() => { throw new Error("setup failed"); }) })).rejects.toThrow("setup failed");
  await expect(registerPackage({ ...input, manifest: manifest(ctx => ctx.collection({ id: "other.items", parse: i => i })) })).rejects.toThrow("invalid or duplicate collection other.items");
});
