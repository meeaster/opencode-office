// Optional integrations that can't run, in the compiled office with the example packages: a
// selected provider whose public export breaks is its own failure, never taken for an unselected
// one, and settings are checked against the consumer's one schema before any integration module
// is evaluated, the settings of an integration that is off included.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { definitionFixture } from "./package-definition.fixture.ts";
import { activeGeneration } from "./package-generation.ts";
import { copyExample, evaluated, json } from "./package-integrations.fixture.ts";

const { exe, write, read, fixture } = definitionFixture({ second: false });

const routing = (settings = "") => `  - name: chatgpt-routing\n${settings}`;

const provider = "  - name: mock-executor\n";

test("a selected provider whose public export breaks fails the command and admission, naming consumer, provider, module and cause; nothing is published; with the integration off the provider still loads", () => {
  const f = fixture("broken-export");
  const manifest = join(f.dir, "packages/mock-executor/package.json");

  copyExample(f);
  f.select(routing("    settings: { executor: { app: true } }\n") + provider);
  f.cli(0, "sync", "--packages");
  const published = activeGeneration(f.dir);

  write(manifest, read(manifest).replace('"exports": { "./apps": "./apps.ts" }', '"exports": {}'));
  evaluated(f);
  const failure = "package chatgpt-routing: integration @office/mock-executor (executor.ts): its module failed to load: Cannot find package '@office/mock-executor' imported from ";

  expect(f.cli(1, "chatgpt-routing", "direct")).toContain(failure);
  const sync = f.cli(1, "sync", "--packages");

  expect(sync).toContain(`FAILED ${failure}`);
  expect(sync).not.toContain("doesn't select");
  expect(activeGeneration(f.dir)).toBe(published);

  // Off, the consumer doesn't import it, and the provider's own definition still loads.
  f.select(routing() + provider);
  expect(json(exe, f, "mock-executor", "apps")).toEqual([]);
  f.cli(0, "sync", "--packages");
  expect(evaluated(f)).toEqual([]);
});

test("a dormant integration's invalid setting and a conflicting route fail the command and sync naming the setting, before any integration module is evaluated, with the provider selected or not", () => {
  const f = fixture("dormant");

  copyExample(f);
  f.select(routing() + provider);
  f.cli(0, "sync", "--packages");
  const published = activeGeneration(f.dir);

  evaluated(f);

  for (const [settings, problem] of [
    ['{ executor: { app: "yes" } }', "packages.chatgpt-routing.settings.executor.app: must be boolean"],
    ["{ routes: { gmail: executor }, executor: { app: false } }", "packages.chatgpt-routing.settings.executor.app: must be equal to constant"],
  ]) {
    for (const selected of [provider, ""]) {
      f.select(routing(`    settings: ${settings}\n`) + selected);
      expect(f.cli(1, "chatgpt-routing", "direct")).toContain(problem);
      expect(f.cli(1, "sync", "--packages")).toContain(`FAILED package chatgpt-routing: ${problem}`);
      expect(evaluated(f)).toEqual([]);
      expect(activeGeneration(f.dir)).toBe(published);
    }
  }
});
