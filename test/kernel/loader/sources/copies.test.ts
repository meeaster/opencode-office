import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { loadOffice } from "../../../../src/office.ts";
import { installedPackages } from "../../../../src/loader/definitions/inventory.ts";
import { requiredPackages, resolvePackages } from "../../../../src/loader/sources/selection.ts";
import { syncLines as sync } from "../../../support/sync.fixture.ts";
import { git } from "../../../../src/git.ts";
import { materializePackage, writeOfficeDeclaration } from "../../../../src/loader/sources/copies.ts";
import { readAppliedSettings } from "../../../../sdk/applied-settings.ts";
import { readLockSection } from "../../../../src/versions.ts";
import { readReceipts } from "../../../../packages/seeds/store.ts";
import { definitionText, markingDefinition, pluginDefinition, settingsSchema, writePackage } from "../../../support/test-package.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "office-packages-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** The office's package named `name`, read with its settings. */
function read(office: string, name: string) {
  const loaded = loadOffice(office);
  // The fixtures exercise one package; the required packages aren't part of this inventory.
  const skip = new Set(requiredPackages.filter(required => required !== name));
  const inventory = installedPackages(loaded, skip);
  const item = inventory.installed.find(candidate => candidate.entry.name === name);

  if (item) return { loaded, result: { ok: true as const, value: item } };

  const errors = inventory.problems.filter(problem => problem.packages.includes(name)).map(problem => problem.message);
  const settings = inventory.invalidSettings.filter(problem => problem.packages.includes(name)).map(problem => problem.message);

  return { loaded, result: { ok: false as const, errors, settings } };
}

const manifest = definitionText(`{ settings: ${settingsSchema({ title: "Shared" }, { url: "string" })} }`);

test("an install ignores the source office's records, an update by full commit SHA replaces the package, and an edited copy is restored", async () => {
  const repo = join(dir, "repo");
  const office = join(dir, "office");

  const commit = (message: string) => {
    git(["add", "-A"], repo);
    git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", message], repo);

    return git(["rev-parse", "HEAD"], repo);
  };

  writePackage(join(repo, "pkgs/demo/office.ts"), manifest);
  write(join(repo, "pkgs/demo/scripts/run.sh"), "echo one\n");
  // Committed by the office that authored the package, as when sharing from its packages/.
  write(join(repo, "pkgs/demo/.template.json"), '["out/AGENTS.md"]\n');
  write(join(repo, "pkgs/demo/.office.json"), '{"opencode":"host"}\n');
  git(["init", "--quiet", repo]);

  const first = commit("one");

  write(join(repo, "pkgs/demo/scripts/run.sh"), "echo two\n");

  const second = commit("two");
  const entry = (ref: string) => `name: t\npackages:\n  - name: demo\n    repo: ${repo}\n    path: pkgs/demo\n    ref: ${ref}\n    settings: { url: https://example.com }\n`;

  write(join(office, "office.yaml"), entry(first));

  const loaded = loadOffice(office);
  const script = join(office, ".office/packages/demo/scripts/run.sh");

  const materialize = async () => {
    const current = loadOffice(office);
    const [item] = resolvePackages(current, "demo").packages;

    return (await materializePackage(current, item, join(office, ".office/packages"))).changes;
  };

  expect(await materialize()).toEqual([`installed .office/packages/demo from ${repo} at ${first}`]);

  const installed = read(office, "demo").result;

  if (!installed.ok) throw new Error(installed.errors.join("\n"));

  expect(writeOfficeDeclaration(loaded, installed.value)).toEqual(["wrote .office/packages/demo/.office.json (opencode: container)"]);
  write(script, "echo edited\n");

  const [restored] = await materialize();

  expect(restored).toStartWith(`restored .office/packages/demo to its copy of ${first}, undoing edits to scripts/run.sh (edited);`);
  expect(readFileSync(script, "utf8")).toBe("echo one\n");

  write(join(office, "office.yaml"), entry(second));
  expect(await materialize()).toEqual([`updated .office/packages/demo from ${repo} pkgs/demo at ${first.slice(0, 12)} (ref ${first}) to ${second} (${second})`]);
  expect(readFileSync(script, "utf8")).toBe("echo two\n");

  const updated = read(office, "demo");

  if (!updated.result.ok) throw new Error(updated.result.errors.join("\n"));

  expect(writeOfficeDeclaration(updated.loaded, updated.result.value)).toEqual([]);
});

test("a package plugin is linked while declared, gives way to a plugins: entry of its name without git running through the link, and is unlinked when the entry goes", async () => {
  const office = join(dir, "office");
  const cloned = join(dir, "cloned");
  const link = join(office, ".opencode/plugins/demo");
  const declared = "name: t\npackages:\n  - name: demo\n";

  writePackage(join(office, "packages/demo/office.ts"), pluginDefinition(), { dependencies: ["opencode"] });
  write(join(office, "packages/demo/plugin/index.ts"), "export default { id: \"demo\", async setup() {} };\n");
  git(["init", "--quiet", office]);
  // From source, a local package resolves its @office imports through the published set.
  write(join(office, "office.yaml"), "name: t\n");
  await sync(loadOffice(office));
  write(join(office, "office.yaml"), declared);

  expect(await sync(loadOffice(office))).toContain("linked .opencode/plugins/demo");
  expect(readlinkSync(link)).toBe("../../packages/demo/plugin");

  write(join(cloned, "index.ts"), "export default { id: \"cloned\", async setup() {} };\n");
  git(["init", "--quiet", cloned]);
  git(["add", "-A"], cloned);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "plugin"], cloned);
  write(join(office, "office.yaml"), `${declared}plugins:\n  - name: demo\n    repo: ${cloned}\n`);

  const changes = await sync(loadOffice(office));

  expect(changes).toContain("cloned plugin .office/plugins/demo");
  expect(changes).toContain("FAILED package demo: its plugin would be .opencode/plugins/demo, where the plugins: entry demo is cloned, so it isn't delivered; rename one of them");
  expect(changes).toContain("unlinked .opencode/plugins/demo for the plugins: entry of that name; restart OpenCode to pick up demo: it keeps the previous target of a moved plugin link");
  expect(readlinkSync(link)).toBe("../../.office/plugins/demo");
  expect(git(["rev-parse", "--show-toplevel"], link)).toBe(realpathSync(join(office, ".office/plugins/demo")));

  rmSync(link, { recursive: true });
  write(join(office, "office.yaml"), declared);
  await sync(loadOffice(office));
  write(join(office, "office.yaml"), "name: t\n");

  expect(await sync(loadOffice(office))).toContain("unlinked .opencode/plugins/demo");
  expect(existsSync(link)).toBe(false);
});

test("sync removes a copied package whose entry is gone, even an edited copy, and leaves the files it laid down, the office's own and a package written in the office", async () => {
  const repo = join(dir, "repo");
  const office = join(dir, "office");

  writePackage(join(repo, "pkgs/demo/office.ts"), markingDefinition("out/marker.md", "from the package\n", `settings: ${settingsSchema({ title: "Shared" }, { url: "string" })}`));
  write(join(repo, "pkgs/demo/skills/demo-skill/SKILL.md"), "---\nname: demo-skill\ndescription: Demo.\n---\n");
  git(["init", "--quiet", repo]);
  git(["add", "-A"], repo);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "one"], repo);

  write(join(office, "office.yaml"), `name: t\npackages:\n  - name: demo\n    repo: ${repo}\n    path: pkgs/demo\n    ref: ${git(["rev-parse", "HEAD"], repo)}\n    settings: { url: https://example.com }\n`);
  git(["init", "--quiet", office]);
  await sync(loadOffice(office));
  expect(readFileSync(join(office, "out/marker.md"), "utf8")).toBe("from the package\n");
  write(join(office, "out/my-page/index.md"), "the office's own\n");
  write(join(office, ".office/packages/demo/office.ts"), "// edited\n");
  writePackage(join(office, "packages/own/office.ts"), definitionText("{}"));
  write(join(office, "office.yaml"), "name: t\n");

  const changes = await sync(loadOffice(office));

  expect(changes).toEqual([
    "removed .office/packages/demo/, which office.yaml no longer lists",
    "wrote .office/runtime/settings.json",
    "linked packages/node_modules/@office to the published package set, for editors",
    "office.lock: removed demo",
  ]);
  expect(existsSync(join(office, ".office/packages/demo"))).toBe(false);
  expect(() => readAppliedSettings(office, "demo")).toThrow("has no settings for package demo");
  expect(readFileSync(join(office, "out/marker.md"), "utf8")).toBe("from the package\n");
  expect(readFileSync(join(office, "out/my-page/index.md"), "utf8")).toBe("the office's own\n");
  expect(existsSync(join(office, "packages/own/office.ts"))).toBe(true);
  expect(await sync(loadOffice(office))).toEqual([]);
});

test("a package set that can't be read runs no package's sync function, and the next sync that reads it does", async () => {
  const office = join(dir, "office");
  const marker = join(office, "marker.md");

  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: demo\n  - name: other\n");
  writePackage(join(office, "packages/demo/office.ts"), markingDefinition("marker.md", "v1\n"));
  writePackage(join(office, "packages/other/office.ts"), definitionText("{}"));
  git(["init", "--quiet", office]);
  await sync(loadOffice(office));
  expect(readFileSync(marker, "utf8")).toBe("v1\n");

  // Another package breaks: demo's new version doesn't run.
  writePackage(join(office, "packages/demo/office.ts"), markingDefinition("marker.md", "v2\n"));
  writePackage(join(office, "packages/other/office.ts"), 'throw new Error("broken definition")');

  const changes = await sync(loadOffice(office));

  expect(changes.some((line) => line.startsWith("FAILED") && line.includes("other"))).toBe(true);
  expect(readFileSync(marker, "utf8")).toBe("v1\n");

  // Read again, demo's sync runs.
  writePackage(join(office, "packages/other/office.ts"), definitionText("{}"));
  await sync(loadOffice(office));
  expect(readFileSync(marker, "utf8")).toBe("v2\n");
});

test("sync locks a Git package's commit in office.lock, keeps the entry when a changed ref fails, and drops it with the package", async () => {
  const repo = join(dir, "repo");
  const office = join(dir, "office");
  const lock = join(office, "office.lock");
  const yaml = (ref: string) => `name: t\npackages:\n  - name: demo\n    repo: ${repo}\n    path: pkgs/demo\n    ref: ${ref}\n    settings: { url: https://example.com }\n`;

  const commit = () => {
    git(["add", "-A"], repo);
    git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "change"], repo);

    return git(["rev-parse", "HEAD"], repo);
  };

  writePackage(join(repo, "pkgs/demo/office.ts"), manifest);
  git(["init", "--quiet", repo]);
  const first = commit();

  git(["tag", "v1"], repo);
  // An office with no Git packages and no office.lock gets none.
  write(join(office, "office.yaml"), "name: t\n");
  git(["init", "--quiet", office]);
  await sync(loadOffice(office), { scope: "packages" });
  expect(existsSync(lock)).toBe(false);

  write(join(office, "office.yaml"), yaml("v1"));
  expect(await sync(loadOffice(office), { scope: "packages" })).toContain(`office.lock: locked demo at ${first.slice(0, 12)}`);
  const locked = readFileSync(lock, "utf8");

  expect(readLockSection(office, "packages")).toEqual(new Map([["demo", { repo, path: "pkgs/demo", ref: "v1", commit: first }]]));
  expect(locked).not.toContain("opencode:");

  // A changed ref whose copy fails validation publishes nothing: the copy, its settings and the lock stay at v1.
  const record = join(office, ".office/packages/demo/.source.json");
  const applied = join(office, ".office/runtime/settings.json");
  const installed = [readFileSync(record, "utf8"), readFileSync(applied, "utf8")];

  writePackage(join(repo, "pkgs/demo/office.ts"), "throw new Error('broken candidate')");
  const broken = commit();

  write(join(office, "office.yaml"), yaml(broken));
  expect((await sync(loadOffice(office), { scope: "packages" })).join("\n")).toContain("broken candidate");
  expect([readFileSync(record, "utf8"), readFileSync(applied, "utf8")]).toEqual(installed);
  expect(readFileSync(lock, "utf8")).toBe(locked);

  // A locked commit the repository no longer has fails, naming it, and changes neither the copy nor the lock.
  const gone = "0123456789abcdef".repeat(3).slice(0, 40);

  write(join(office, "office.yaml"), yaml("v1"));
  writeFileSync(lock, locked.replace(first, gone));
  const unreachable = readFileSync(lock, "utf8");
  const failed = (await sync(loadOffice(office), { scope: "packages" })).filter(line => line.startsWith("FAILED"));

  expect(failed.length).toBe(1);
  expect(failed[0]).toContain(`revision ${gone}`);
  expect(readFileSync(lock, "utf8")).toBe(unreachable);
  expect(readFileSync(record, "utf8")).toBe(installed[0]!);

  write(join(office, "office.yaml"), "name: t\n");
  expect(await sync(loadOffice(office), { scope: "packages" })).toContain("office.lock: removed demo");
  expect(existsSync(lock)).toBe(false);
});

test("sync installs the built-in packages from the tool and restores an edited copy, keeping the office's records", async () => {
  const office = join(dir, "office");
  const skill = join(office, ".office/packages/office/skills/office/SKILL.md");

  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: knowledge\n");

  const installed = await sync(loadOffice(office));

  expect(installed).toContain("installed .office/packages/office, the built-in office package");
  expect(installed).toContain("installed .office/packages/knowledge, the built-in knowledge package");
  expect(installed).toContain("copied plugin .opencode/plugins/office");
  expect(readFileSync(join(office, ".opencode/plugins/office/index.js"), "utf8")).toBe(readFileSync(join(office, ".office/packages/office/plugin/index.js"), "utf8"));
  expect(existsSync(join(office, ".office/packages/office/plugin/index.js"))).toBe(true);

  const original = readFileSync(skill, "utf8");
  const received = readReceipts(office);

  expect([...received.values()].some((receipt) => receipt.package === "knowledge" && "sha256" in receipt)).toBe(true);

  write(skill, "edited\n");
  rmSync(join(office, ".office/packages/knowledge/README.md"));

  const restored = await sync(loadOffice(office));

  expect(restored).toHaveLength(2);
  expect(restored[0]).toStartWith("restored .office/packages/office, undoing edits to skills/office/SKILL.md (edited);");
  expect(restored[1]).toStartWith("restored .office/packages/knowledge, undoing edits to README.md (removed);");
  expect(readFileSync(skill, "utf8")).toBe(original);
  expect(readReceipts(office)).toEqual(received);
  expect(await sync(loadOffice(office))).toEqual([]);
});

test("the required office package ignores the Claude app's synced skills unless turned off, and takes more folders as a list", async () => {
  const office = join(dir, "office");
  write(join(office, "office.yaml"), "name: t\n");
  await sync(loadOffice(office));

  expect(readAppliedSettings(office, "office")).toEqual({ ignore_claude_synced_skills: true, ignore_skill_folders: [] });

  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: office\n    settings:\n      ignore_claude_synced_skills: false\n      ignore_skill_folders:\n        - ~/other/skills\n");

  expect(await sync(loadOffice(office))).toEqual(["wrote .office/runtime/settings.json"]);
  expect(readAppliedSettings(office, "office")).toEqual({ ignore_claude_synced_skills: false, ignore_skill_folders: ["~/other/skills"] });

  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: office\n    settings:\n      ignore_skill_folders: ~/.claude/skills/synced\n");
  expect(read(office, "office").result).toMatchObject({ ok: false, errors: ["packages.office.settings.ignore_skill_folders: must be array"] });

  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: office\n    settings:\n      ignored: []\n");
  expect(read(office, "office").result).toMatchObject({ ok: false, errors: ["packages.office.settings.ignored: the package declares no such setting; remove it from office.yaml"] });

  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: office\n    repo: https://example.com/fork.git\n    path: packages/office\n    ref: main\n");
  expect(() => loadOffice(office)).toThrow("the required office package is built in: its entry can only configure settings");

  // A skill a built-in package renamed, as an earlier executable's copy held it, leaves on the next sync.
  const skills = join(office, ".office/packages/office/skills");

  write(join(office, "office.yaml"), "name: t\n");
  write(join(skills, "skill-creator/SKILL.md"), readFileSync(join(skills, "openai-skill-creator/SKILL.md"), "utf8"));
  await sync(loadOffice(office));

  expect(existsSync(join(skills, "skill-creator"))).toBe(false);
  expect(readFileSync(join(skills, "openai-skill-creator/SKILL.md"), "utf8")).toContain("\nname: openai-skill-creator\n");
  expect(existsSync(join(skills, "openai-skill-creator/NOTICE"))).toBe(true);
  expect(existsSync(join(skills, "openai-skill-creator/license.txt"))).toBe(true);
});
