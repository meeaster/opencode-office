import { afterEach, expect, test } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { sync } from "../../../src/commands/sync.ts";
import { loadOffice } from "../../../src/office.ts";
import { builtinFiles } from "../../../src/tool.ts";

const scratch: string[] = [];
const checker = resolve(import.meta.dir, "../skills/knowledge-base/scripts/kb.mjs");

function temporary() {
  const dir = mkdtempSync(join(tmpdir(), "knowledge-"));

  scratch.push(dir);

  return dir;
}

function write(path: string, text: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function run(script: string, ...args: string[]) {
  const result = spawnSync("bun", [script, ...args], { encoding: "utf8" });

  return { status: result.status, text: result.stdout + result.stderr };
}

function base() {
  const root = join(temporary(), "knowledge");

  expect(run(checker, "init", root, "--name", "Test").status).toBe(0);
  write(join(root, "origins.md"), "# Origins\n\n## repo:example/system\n\nThe system.\n- Access: Read its repository.\n");
  write(join(root, "articles/system.md"), "---\ndescription: System ownership\nupdated: 2026-11-17\n---\n# System\n\n## Ownership\n\nThe platform team owns the system.\n\nProvenance: [references](../references/system.md)\n");
  write(join(root, "evidence/2026-11-17-system.md"), "---\ndescription: Repository ownership\nobserved: 2026-11-17\n---\n# Ownership\n\n## Findings\n\nPlatform owns it. [1]\n\n## Origins\n\n1. `repo:example/system` · CODEOWNERS\n");
  write(join(root, "references/system.md"), "# References · System\n\n- `repo:example/system` · CODEOWNERS · observed 2026-11-17 · supports: Ownership · via [look](../evidence/2026-11-17-system.md)\n");

  return root;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("distributed plugin registers its installed skill and discovers only articles, retaining legacy files and refreshing prompts", async () => {
  const office = temporary();
  const legacy = "---\ndescription: Older export guidance\n---\n# Export\n";

  write(join(office, "office.yaml"), "name: test\npackages:\n  - name: knowledge\n");
  write(join(office, "knowledge/old/export.md"), legacy);
  write(join(office, "knowledge/AGENTS.md"), "# Existing local rules\n");
  await sync(loadOffice(office));

  expect(readFileSync(join(office, "knowledge/old/export.md"), "utf8")).toBe(legacy);
  expect(readFileSync(join(office, "knowledge/AGENTS.md"), "utf8")).toBe("# Existing local rules\n");
  expect(await sync(loadOffice(office))).toEqual([]);

  const files = await builtinFiles("knowledge");

  expect(files.has("skills/knowledge-base/scripts/kb.mjs")).toBe(true);
  expect([...files.keys()].some((path) => path.startsWith("test/"))).toBe(false);

  const installed = join(office, ".office/packages/knowledge");
  const link = join(office, "linked-plugin");

  symlinkSync(join(installed, "plugin"), link);

  const plugin = (await import(join(link, "index.ts"))).default;
  const prompts: ((event: { sessionID: string }) => Promise<void>)[] = [];
  const entries: string[] = [];
  const skills: { id: string; path: string; content: string }[] = [];

  await plugin.setup({
    skill: {
      async transform(callback: (editor: { add(skill: (typeof skills)[number]): void }) => void) {
        callback({ add: (skill) => { skills.push(skill); } });
      },
    },
    session: {
      async hook(_kind: string, callback: (event: { sessionID: string }) => Promise<void>) {
        prompts.push(callback);
      },
      instructions: { entry: { async put(input: { value: string }) { entries.push(input.value); } } },
    },
  });

  expect(skills[0].id).toBe("knowledge-base");
  expect(skills[0].path).toBe(join(installed, "skills/knowledge-base/SKILL.md"));
  expect(skills[0].content.startsWith("---")).toBe(false);
  expect(existsSync(join(dirname(skills[0].path), "references/articles.md"))).toBe(true);
  expect(run(join(dirname(skills[0].path), "scripts/kb.mjs"), "--help").status).toBe(0);

  write(join(office, "knowledge/articles/system.md"), "---\ndescription: System ownership\n---\n# System\n");

  for (const path of ["references/system.md", "sources/email/thread.md", "evidence/look.md", "old/README.md"]) {
    write(join(office, "knowledge", path), "---\ndescription: Excluded material\n---\n");
  }

  await prompts[0]({ sessionID: "test" });
  expect(entries[0]).toContain("knowledge/articles/system.md");
  expect(entries[0]).toContain("knowledge/old/export.md");
  expect(entries[0]).not.toContain("Excluded material");
  await prompts[0]({ sessionID: "test" });
  expect(entries).toHaveLength(1);
  write(join(office, "knowledge/articles/new.md"), "---\ndescription: Newly discovered\n---\n");
  await prompts[0]({ sessionID: "test" });
  expect(entries[1]).toContain("Newly discovered");
});

test("checker accepts portable provenance and rejects missing metadata, unknown origins, headings and outside citations", () => {
  const root = base();

  expect(run(checker, "check", root).status).toBe(0);
  write(join(root, "articles/bad.md"), "# Bad\n");
  write(join(root, "references/system.md"), "# References\n\n- `repo:missing` · path · observed yesterday · supports: Absent\n- [session](../../session.md)\n- [remote](https://example.com)\n");

  const result = run(checker, "check", root);

  expect(result.status).toBe(1);
  expect(result.text).toContain("front matter needs `updated:`");
  expect(result.text).toContain("isn't in origins.md");
  expect(result.text).toContain("isn't a heading");
  expect(result.text).toContain("outside the knowledge base");
  expect(result.text).toContain("a file reference must link");
});

test("checker preserves evidence and non-thread sources and permits only byte-preserving thread appends in a nested git base", () => {
  const root = base();
  const office = dirname(root);
  const git = (...args: string[]) => execFileSync("git", ["-C", office, ...args], { encoding: "utf8" });
  const thread = "---\nkind: email\noccurred: 2026-11-17\ndescription: Ownership thread\n---\n# Thread\n\n## 2026-11-17 · Owner (platform)\n\nWe own it.\n";
  const statement = "---\nkind: statement\noccurred: 2026-11-17\ndescription: Ownership statement\n---\n# Statement\n\nWe own it.\n";

  write(join(root, "sources/email/ownership.md"), thread);
  write(join(root, "sources/statements/ownership.md"), statement);
  git("init", "-q");
  git("add", ".");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "fixture");

  write(join(root, "sources/email/ownership.md"), `${thread}\n## 2026-11-18 · Owner (platform)\n\nStill true.\n`);
  expect(run(checker, "check", root).status).toBe(0);
  write(join(root, "sources/email/ownership.md"), thread.replace("We own", "They own"));
  write(join(root, "sources/statements/ownership.md"), `${statement}Extra.\n`);
  write(join(root, "evidence/2026-11-17-system.md"), readFileSync(join(root, "evidence/2026-11-17-system.md"), "utf8") + "Extra.\n");

  const result = run(checker, "check", root);

  expect(result.status).toBe(1);
  expect(result.text).toContain("evidence is never edited");
  expect(result.text.match(/only a thread may grow/g)).toHaveLength(2);
});

test("free-form migration remains explicit and format 1 migration refuses conflicts before writing", () => {
  const root = temporary();
  const legacy = "# Existing article\n";

  write(join(root, "legacy.md"), legacy);
  expect(run(checker, "init", root).status).toBe(1);
  expect(existsSync(join(root, "AGENTS.md"))).toBe(false);
  write(join(root, "AGENTS.md"), "---\nknowledge-base-format: 1\n---\n# Local rules\n");
  const article = "---\ndescription: System\nupdated: 2026-11-17\n---\n# System\n\n## Ownership\n\nPlatform.\n\n## References\n\n- [statement](../sources/statements/owner.md)\n";

  write(join(root, "articles/system.md"), article);
  write(join(root, "references/system.md"), "# Existing provenance\n");
  expect(run(checker, "migrate", root).status).toBe(1);
  expect(readFileSync(join(root, "articles/system.md"), "utf8")).toBe(article);
  expect(readFileSync(join(root, "references/system.md"), "utf8")).toBe("# Existing provenance\n");
  rmSync(join(root, "references/system.md"));
  expect(run(checker, "migrate", root).status).toBe(0);
  expect(readFileSync(join(root, "articles/system.md"), "utf8")).not.toContain("## References");
  expect(readFileSync(join(root, "references/system.md"), "utf8")).toContain("../sources/statements/owner.md");
  expect(run(checker, "migrate", root).text).toContain("nothing changed");
  expect(readFileSync(join(root, "legacy.md"), "utf8")).toBe(legacy);
});

test("re-check listing exposes locators, dates and access methods without refreshing anything", () => {
  const root = base();
  const before = readFileSync(join(root, "references/system.md"), "utf8");
  const result = run(checker, "stale", root, "--article", "articles/system.md");

  expect(result.status).toBe(0);
  expect(result.text).toContain("CODEOWNERS");
  expect(result.text).toContain("2026-11-17");
  expect(result.text).toContain("Access: Read its repository.");
  expect(readFileSync(join(root, "references/system.md"), "utf8")).toBe(before);
});
