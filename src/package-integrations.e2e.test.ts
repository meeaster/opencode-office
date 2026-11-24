// Optional integrations in the compiled office, with the example packages: a consumer alone, with
// its provider selected but the integration off, on, withdrawn while the provider stays selected,
// and with the provider removed, before and after each sync. Selection decides, not the links an
// earlier package set left; what a registry holds is read live, while a separate runtime reads the
// settings the last sync applied.
import { expect, test } from "bun:test";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { definitionFixture } from "./package-definition.fixture.ts";
import { copyExample, evaluated, json, runtime } from "./package-integrations.fixture.ts";

const { exe, fixture } = definitionFixture({ second: false });

const review = (settings = "") => `  - name: review-kit\n${settings}`;

const routing = (settings = "") => `  - name: chatgpt-routing\n${settings}`;

const skills = (enabled: string) => `  - name: skills\n    settings:\n      enabled: ${enabled}\n`;

const provider = "  - name: mock-executor\n";

test("a consumer works alone, with its provider selected and the integration off, on, withdrawn and removed, before and after sync; nothing activates from a stale link", () => {
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

  // Providers selected, listed after their consumers; the owner turns the default skill offer off and asks for no app.
  f.select(review("    settings: { skills: false }\n") + routing() + skills("[]") + provider);
  f.cli(0, "sync", "--packages");
  expect(json(exe, f, "mock-executor", "apps")).toEqual([]);
  expect(f.cli(0, "skills", "list")).not.toContain("review-checklist");
  expect(evaluated(f)).toEqual([]);

  // On: the author's default offers the skill, which the owner enables; the app is registered with no tool while Gmail stays direct.
  f.select(review() + routing("    settings: { executor: { app: true } }\n") + skills("[review-checklist]") + provider);
  f.cli(0, "sync", "--packages");
  expect(readlinkSync(link)).toBe("../../packages/review-kit/skills/review-checklist");
  expect(f.cli(0, "skills", "list")).toMatch(/review-checklist +package review-kit +enabled/);
  expect(json(exe, f, "mock-executor", "apps")).toEqual([{ owner: "chatgpt-routing", app: "chatgpt", tools: [] }]);
  expect(json(exe, f, "chatgpt-routing", "direct")).toEqual(["gmail", "calendar"]);
  expect(runtime(f)).toEqual({ direct: ["gmail", "calendar"], app: "chatgpt" });
  expect(new Set(evaluated(f))).toEqual(new Set(["review-kit/skills.ts", "chatgpt-routing/executor.ts"]));

  // Gmail through the app only: commands read office.yaml at once, the runtime the applied settings until sync publishes them.
  f.select(review() + routing("    settings: { routes: { gmail: executor }, executor: { app: true } }\n") + skills("[review-checklist]") + provider);
  expect(json(exe, f, "mock-executor", "apps")).toEqual([{ owner: "chatgpt-routing", app: "chatgpt", tools: [{ name: "gmail.search", readOnly: true }] }]);
  expect(json(exe, f, "chatgpt-routing", "direct")).toEqual(["calendar"]);
  expect(runtime(f)).toEqual({ direct: ["gmail", "calendar"], app: "chatgpt" });
  f.cli(0, "sync", "--packages");
  expect(runtime(f)).toEqual({ direct: ["calendar"], app: "chatgpt" });
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
  expect(evaluated(f)).toEqual([]);

  // Providers removed from office.yaml, their links still in the published set: an explicit request fails, naming both, with no direct fallback...
  f.select(review() + routing("    settings: { executor: { app: true } }\n"));
  expect(existsSync(stale)).toBe(true);
  expect(f.cli(1, "chatgpt-routing", "direct")).toContain("package chatgpt-routing: integration @office/mock-executor (executor.ts): requested by package chatgpt-routing's settings, but office.yaml doesn't select package mock-executor");

  // ...and without one, the base commands run and nothing is evaluated, before and after sync; the author's default offer stays off without skills.
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
  expect(f.cli(1, "chatgpt-routing", "direct")).toContain("doesn't select package mock-executor");
  expect(f.cli(1, "sync", "--packages")).toContain("FAILED package chatgpt-routing: integration @office/mock-executor (executor.ts): requested by package chatgpt-routing's settings, but office.yaml doesn't select package mock-executor");
});
