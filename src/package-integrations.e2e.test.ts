// Optional integrations in the compiled office, with the example packages: a consumer alone, with
// its provider selected and its settings adding nothing, adding, adding both routes, withdrawn
// while the provider stays selected, with the provider broken, and with the provider removed,
// before and after each sync. Selection decides, not the links an earlier package set left; what a
// registry holds is read live, while a separate runtime reads the settings the last sync applied.
import { expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { definitionFixture } from "./package-definition.fixture.ts";
import { copyExample, evaluated, json, runtime } from "./package-integrations.fixture.ts";

const { exe, fixture } = definitionFixture({ second: false });

const review = (settings = "") => `  - name: review-kit\n${settings}`;

const routing = (settings = "") => `  - name: chatgpt-routing\n${settings}`;

const skills = (enabled: string) => `  - name: skills\n    settings:\n      enabled: ${enabled}\n`;

const provider = "  - name: mock-executor\n";

test("a consumer works alone, with its provider selected adding nothing, adding, adding both routes, withdrawn, broken and removed, before and after sync; nothing runs from a stale link", () => {
  const f = fixture("integrations");
  const link = join(f.dir, ".agents/skills/review-checklist");
  const stale = join(f.dir, ".office/current/node_modules/@office/mock-executor");

  copyExample(f);

  // Alone: the base commands and the applied settings, no integration module evaluated.
  f.select(review() + routing());
  f.cli(0, "sync", "--packages");
  expect(f.cli(0, "review-kit", "show")).toContain("Review checklist");
  expect(json(exe, f, "chatgpt-routing", "direct")).toEqual(["gmail", "calendar"]);
  expect(runtime(f)).toEqual({ direct: ["gmail", "calendar"], app: null });
  expect(evaluated(f)).toEqual([]);

  // Providers selected, listed after their consumers: both adapters run and add nothing, as the owner turns the skill offer off and asks for no app.
  f.select(review("    settings: { skills: false }\n") + routing() + skills("[]") + provider);
  f.cli(0, "sync", "--packages");
  expect(json(exe, f, "mock-executor", "apps")).toEqual([]);
  expect(f.cli(0, "skills", "list")).not.toContain("review-checklist");
  expect(new Set(evaluated(f))).toEqual(new Set(["review-kit/skills.ts", "chatgpt-routing/executor.ts"]));

  // Adding: left out, the skill setting offers the skill while skills is selected, and the owner enables it; the app is registered with no tool while Gmail stays direct.
  f.select(review() + routing("    settings: { executor: { app: true } }\n") + skills("[review-checklist]") + provider);
  f.cli(0, "sync", "--packages");
  expect(readlinkSync(link)).toBe("../../packages/review-kit/skills/review-checklist");
  expect(f.cli(0, "skills", "list")).toMatch(/review-checklist +package review-kit +enabled/);
  expect(json(exe, f, "mock-executor", "apps")).toEqual([{ owner: "chatgpt-routing", namespace: "chatgpt-routing", app: "chatgpt", tools: [] }]);
  expect(json(exe, f, "chatgpt-routing", "direct")).toEqual(["gmail", "calendar"]);
  expect(runtime(f)).toEqual({ direct: ["gmail", "calendar"], app: "chatgpt" });
  expect(new Set(evaluated(f))).toEqual(new Set(["review-kit/skills.ts", "chatgpt-routing/executor.ts"]));

  // Gmail through the app only: commands read office.yaml at once, the runtime the applied settings until sync publishes them.
  f.select(review() + routing("    settings: { routes: { gmail: executor }, executor: { app: true } }\n") + skills("[review-checklist]") + provider);
  expect(json(exe, f, "mock-executor", "apps")).toEqual([{ owner: "chatgpt-routing", namespace: "chatgpt-routing", app: "chatgpt", tools: [{ name: "gmail.search", readOnly: true }] }]);
  expect(json(exe, f, "chatgpt-routing", "direct")).toEqual(["calendar"]);
  expect(runtime(f)).toEqual({ direct: ["gmail", "calendar"], app: "chatgpt" });
  f.cli(0, "sync", "--packages");
  expect(runtime(f)).toEqual({ direct: ["calendar"], app: "chatgpt" });

  // Both routes: Gmail is direct and in the app.
  f.select(review() + routing("    settings: { routes: { gmail: both }, executor: { app: true } }\n") + skills("[review-checklist]") + provider);
  expect(json(exe, f, "mock-executor", "apps")).toEqual([{ owner: "chatgpt-routing", namespace: "chatgpt-routing", app: "chatgpt", tools: [{ name: "gmail.search", readOnly: true }] }]);
  expect(json(exe, f, "chatgpt-routing", "direct")).toEqual(["gmail", "calendar"]);
  evaluated(f);

  // Turning the offer off while skills still enables the ID is the skills package's error: no link changes.
  f.select(review("    settings: { skills: false }\n") + routing() + skills("[review-checklist]") + provider);
  expect(f.cli(1, "sync", "--packages")).toContain("skill review-checklist is enabled, but no source offers it");
  expect(lstatSync(link).isSymbolicLink()).toBe(true);

  // Withdrawn in one transition, the offer and the owner's enabled ID, with skills still selected: its link goes.
  f.select(review("    settings: { skills: false }\n") + routing() + skills("[]") + provider);
  f.cli(0, "sync", "--packages");
  expect(f.cli(0, "skills", "list")).not.toContain("review-checklist");
  // Unlinked, not left dangling.
  expect(lstatSync(link, { throwIfNoEntry: false })).toBeUndefined();
  expect(json(exe, f, "mock-executor", "apps")).toEqual([]);
  evaluated(f);

  // A selected provider that doesn't load fails the gathering naming it, though these settings add nothing: it isn't treated as absent.
  const definition = join(f.dir, "packages/mock-executor/office.ts");
  const healthy = readFileSync(definition, "utf8");
  writeFileSync(definition, 'throw new Error("mock-executor on import");\n');
  const broken = f.cli(1, "chatgpt-routing", "direct");
  expect(broken).toContain("package chatgpt-routing: integration @office/mock-executor (executor.ts): package mock-executor is selected but didn't load, so this integration can't run; fix package mock-executor");
  expect(broken).toContain("mock-executor on import");
  expect(evaluated(f)).toEqual(["review-kit/skills.ts"]);
  writeFileSync(definition, healthy);

  // Providers removed from office.yaml, their links still in the published set: an explicit request fails in base setup, naming both, with no direct fallback...
  f.select(review() + routing("    settings: { executor: { app: true } }\n"));
  expect(existsSync(stale)).toBe(true);
  expect(f.cli(1, "chatgpt-routing", "direct")).toContain("package chatgpt-routing: executor.app needs package mock-executor, which office.yaml doesn't select");
  f.select(review("    settings: { skills: true }\n") + routing());
  expect(f.cli(1, "review-kit", "show")).toContain("package review-kit: skills: true needs package skills, which office.yaml doesn't select");
  expect(evaluated(f)).toEqual([]);

  // ...and without one, the base commands run and nothing is evaluated, before and after sync; left out, the skill setting offers nothing without skills.
  f.select(review() + routing());

  for (const synced of [false, true]) {
    expect(existsSync(stale)).toBe(!synced);
    expect(f.cli(0, "review-kit", "show")).toContain("Review checklist");
    expect(json(exe, f, "chatgpt-routing", "direct")).toEqual(["gmail", "calendar"]);
    expect(evaluated(f)).toEqual([]);

    if (!synced) f.cli(0, "sync", "--packages");
  }

  expect(runtime(f)).toEqual({ direct: ["gmail", "calendar"], app: null });
  expect(evaluated(f)).toEqual([]);

  // After sync, the explicit request fails the same way in the command and in sync.
  f.select(review() + routing("    settings: { executor: { app: true } }\n"));
  expect(f.cli(1, "chatgpt-routing", "direct")).toContain("executor.app needs package mock-executor, which office.yaml doesn't select");
  expect(f.cli(1, "sync", "--packages")).toContain("FAILED package chatgpt-routing: executor.app needs package mock-executor, which office.yaml doesn't select");
  expect(evaluated(f)).toEqual([]);
});
