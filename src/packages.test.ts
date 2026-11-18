import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { sync } from "./commands/sync.ts";
import { git } from "./git.ts";
import { loadOffice } from "./office.ts";
import { settingsEnv } from "./package-services.ts";
import { fetchPackage, installPackage, readPackage, resolvePackages } from "./packages.ts";

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
  const resolved = resolvePackages(loaded).packages.find((item) => item.entry.name === name);

  if (resolved === undefined) throw new Error(`no package ${name}`);

  return { loaded, result: readPackage(loaded, resolved) };
}

const manifest = "name: demo\ndescription: A demo package.\nsettings:\n  url:\n    description: Where it publishes\n    required: true\n  title:\n    description: The index title\n    default: Shared\n";

test("package-defined schemas validate nested settings and write defaults without flattening lists into environment variables", () => {
  const path = join(dir, "packages/demo/package.yaml");

  const schema = `name: demo
description: Demo
settings_schema:
  type: object
  additionalProperties: false
  properties:
    enabled: { type: boolean, default: true }
    roles:
      type: object
      properties:
        review: { type: array, items: { $ref: '#/$defs/model' } }
  $defs:
    model: { enum: [fast, deep] }
`;

  const config = (models: string) => write(join(dir, "office.yaml"), `name: t\npackages:\n  - name: demo\n    settings: { roles: { review: ${models} } }\n`);

  write(path, schema);
  config("[fast, deep]");

  const { loaded, result } = read(dir, "demo");

  if (!result.ok) throw new Error(result.errors.join("\n"));

  installPackage(loaded, result.value);
  expect(JSON.parse(readFileSync(join(dir, "packages/demo/.settings.json"), "utf8"))).toEqual({ enabled: true, roles: { review: ["fast", "deep"] } });
  expect(settingsEnv(result.value)).toBe("DEMO_ENABLED='true'\n");
  config("[other]");
  expect(read(dir, "demo").result).toMatchObject({ ok: false, errors: [expect.stringContaining("demo.settings/roles/review/0")] });
  write(path, `${schema}settings: {}\n`);
  expect(read(dir, "demo").result).toMatchObject({ ok: false, errors: [expect.stringContaining("not both")] });
  write(path, schema.replace("type: boolean", "type: invalid"));
  expect(read(dir, "demo").result).toMatchObject({ ok: false, errors: [expect.stringContaining("package.yaml: settings_schema")] });
});

test("settings the package doesn't declare, and required ones left out, are named; defaults fill the rest", () => {
  const office = join(dir, "office");

  write(join(office, "packages/demo/package.yaml"), manifest);
  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: demo\n    settings:\n      colour: blue\n");

  const invalid = read(office, "demo").result;

  expect(invalid).toEqual({
    ok: false,
    errors: ["settings.colour: demo has no such setting (it accepts url, title); remove it from the entry in office.yaml", "settings.url is required; add it to the entry in office.yaml: Where it publishes"],
  });

  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: demo\n    settings:\n      url: https://example.com/site\n");

  const valid = read(office, "demo").result;

  expect(valid.ok && valid.value.settings).toEqual({ url: "https://example.com/site", title: "Shared" });
});

test("an install ignores the source office's records, an update by full commit SHA replaces the package, an edited copy is restored, and template copies are left alone", () => {
  const repo = join(dir, "repo");
  const office = join(dir, "office");

  const commit = (message: string) => {
    git(["add", "-A"], repo);
    git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", message], repo);

    return git(["rev-parse", "HEAD"], repo);
  };

  write(join(repo, "pkgs/demo/package.yaml"), manifest);
  write(join(repo, "pkgs/demo/scripts/run.sh"), "echo one\n");
  write(join(repo, "pkgs/demo/template/out/AGENTS.md"), "from the package\n");
  // Committed by the office that authored the package, as when sharing from its packages/.
  write(join(repo, "pkgs/demo/.template.json"), '["out/AGENTS.md"]\n');
  write(join(repo, "pkgs/demo/.settings.json"), '{"url":"https://example.com","title":"Shared"}\n');
  git(["init", "--quiet", repo]);

  const first = commit("one");

  write(join(repo, "pkgs/demo/scripts/run.sh"), "echo two\n");

  const second = commit("two");
  const entry = (ref: string) => `name: t\npackages:\n  - name: demo\n    repo: ${repo}\n    path: pkgs/demo\n    ref: ${ref}\n    settings: { url: https://example.com }\n`;

  write(join(office, "office.yaml"), entry(first));

  const loaded = loadOffice(office);
  const script = join(office, ".office/packages/demo/scripts/run.sh");

  expect(fetchPackage(loaded, "demo", { repo, path: "pkgs/demo", ref: first })).toEqual([`installed .office/packages/demo from ${repo} at ${first}`]);

  const installed = read(office, "demo").result;

  if (!installed.ok) throw new Error(installed.errors.join("\n"));

  expect(installPackage(loaded, installed.value)).toEqual(["wrote .office/packages/demo/.settings.json", "wrote .office/packages/demo/.office.json (opencode: container)", "created out/AGENTS.md from package demo"]);
  write(join(office, "out/AGENTS.md"), "the office's own\n");
  write(script, "echo edited\n");

  const [restored] = fetchPackage(loaded, "demo", { repo, path: "pkgs/demo", ref: first });

  expect(restored).toStartWith(`restored .office/packages/demo to its copy of ${first}, undoing edits to scripts/run.sh (edited);`);
  expect(readFileSync(script, "utf8")).toBe("echo one\n");

  write(join(office, "office.yaml"), entry(second));
  expect(fetchPackage(loadOffice(office), "demo", { repo, path: "pkgs/demo", ref: second })).toEqual([`updated .office/packages/demo from ${repo} pkgs/demo at ${first.slice(0, 12)} (ref ${first}) to ${second} (${second})`]);
  expect(readFileSync(script, "utf8")).toBe("echo two\n");

  const updated = read(office, "demo");

  if (!updated.result.ok) throw new Error(updated.result.errors.join("\n"));

  expect(installPackage(updated.loaded, updated.result.value)).toEqual([]);
  expect(readFileSync(join(office, "out/AGENTS.md"), "utf8")).toBe("the office's own\n");
});

test("a package plugin is linked while declared, gives way to a plugins: entry of its name without git running through the link, and is unlinked when the entry goes", async () => {
  const office = join(dir, "office");
  const cloned = join(dir, "cloned");
  const link = join(office, ".opencode/plugins/demo");
  const declared = "name: t\npackages:\n  - name: demo\n";

  write(join(office, "packages/demo/package.yaml"), "name: demo\ndescription: A demo package.\n");
  write(join(office, "packages/demo/plugin/index.ts"), "export default { id: \"demo\", async setup() {} };\n");
  write(join(office, "office.yaml"), declared);
  git(["init", "--quiet", office]);

  expect(await sync(loadOffice(office))).toContain("linked .opencode/plugins/demo");
  expect(readlinkSync(link)).toBe("../../packages/demo/plugin");

  write(join(cloned, "index.ts"), "export default { id: \"cloned\", async setup() {} };\n");
  git(["init", "--quiet", cloned]);
  git(["add", "-A"], cloned);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "plugin"], cloned);
  write(join(office, "office.yaml"), `${declared}plugins:\n  - name: demo\n    repo: ${cloned}\n`);

  const changes = await sync(loadOffice(office));

  expect(changes).toContain("cloned plugin .opencode/plugins/demo");
  expect(changes).toContain("FAILED package demo: its plugin would be .opencode/plugins/demo, where the plugins: entry demo is cloned, so it isn't linked; rename one of them");
  expect(git(["rev-parse", "--show-toplevel"], link)).toBe(realpathSync(link));

  rmSync(link, { recursive: true });
  write(join(office, "office.yaml"), declared);
  await sync(loadOffice(office));
  write(join(office, "office.yaml"), "name: t\n");

  expect(await sync(loadOffice(office))).toContain("unlinked .opencode/plugins/demo");
  expect(existsSync(link)).toBe(false);
});

test("a template file is copied once: one the office deletes stays deleted, one already there is kept, and one the package adds later is created", () => {
  const office = join(dir, "office");

  const install = () => {
    const { loaded, result } = read(office, "demo");

    if (!result.ok) throw new Error(result.errors.join("\n"));

    return installPackage(loaded, result.value);
  };

  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: demo\n");
  write(join(office, "packages/demo/package.yaml"), "name: demo\ndescription: A demo package.\n");
  write(join(office, "packages/demo/template/notes/README.md"), "from the package\n");
  write(join(office, "packages/demo/template/notes/AGENTS.md"), "from the package\n");
  write(join(office, "notes/AGENTS.md"), "the office's own\n");

  expect(install()).toEqual(["wrote packages/demo/.settings.json", "wrote packages/demo/.office.json (opencode: container)", "kept notes/AGENTS.md, which was already there, instead of package demo's copy", "created notes/README.md from package demo"]);

  rmSync(join(office, "notes"), { recursive: true });
  write(join(office, "packages/demo/template/notes/later.md"), "added by a later version\n");

  expect(install()).toEqual(["created notes/later.md from package demo"]);
  expect(existsSync(join(office, "notes/README.md"))).toBe(false);
  expect(existsSync(join(office, "notes/AGENTS.md"))).toBe(false);
  expect(install()).toEqual([]);
});

test("sync removes a copied package whose entry is gone with the template files it still holds, and leaves changed files and the office's own beside them", async () => {
  const repo = join(dir, "repo");
  const office = join(dir, "office");

  write(join(repo, "pkgs/demo/package.yaml"), manifest);
  write(join(repo, "pkgs/demo/skills/demo-skill/SKILL.md"), "---\nname: demo-skill\ndescription: Demo.\n---\n");
  write(join(repo, "pkgs/demo/template/.github/workflows/publish.yml"), "on: push\n");
  write(join(repo, "pkgs/demo/template/out/AGENTS.md"), "from the package\n");
  write(join(repo, "pkgs/demo/template/out/README.md"), "from the package\n");
  git(["init", "--quiet", repo]);
  git(["add", "-A"], repo);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "one"], repo);

  write(join(office, "office.yaml"), `name: t\npackages:\n  - name: demo\n    repo: ${repo}\n    path: pkgs/demo\n    ref: ${git(["rev-parse", "HEAD"], repo)}\n    settings: { url: https://example.com }\n`);
  git(["init", "--quiet", office]);
  await sync(loadOffice(office));
  write(join(office, "out/README.md"), "the office changed this\n");
  write(join(office, "out/my-page/index.md"), "the office's own\n");
  write(join(office, ".github/dependabot.yml"), "version: 2\n");
  write(join(office, "office.yaml"), "name: t\n");

  const changes = await sync(loadOffice(office));

  expect(changes).toEqual([
    "deleted .github/workflows/publish.yml, which package demo created",
    "deleted out/AGENTS.md, which package demo created",
    "kept out/README.md, which changed since package demo wrote it",
    "removed .office/packages/demo/, which office.yaml no longer lists",
  ]);
  expect(existsSync(join(office, ".office/packages/demo"))).toBe(false);
  expect(existsSync(join(office, ".github/workflows"))).toBe(false);
  expect(readFileSync(join(office, ".github/dependabot.yml"), "utf8")).toBe("version: 2\n");
  expect(readFileSync(join(office, "out/README.md"), "utf8")).toBe("the office changed this\n");
  expect(readFileSync(join(office, "out/my-page/index.md"), "utf8")).toBe("the office's own\n");
  expect(await sync(loadOffice(office))).toEqual([]);
});

test("sync removes an edited copy whose entry is gone too, and never removes a package written in the office", async () => {
  const repo = join(dir, "repo");
  const office = join(dir, "office");

  write(join(repo, "pkgs/demo/package.yaml"), manifest);
  git(["init", "--quiet", repo]);
  git(["add", "-A"], repo);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "one"], repo);

  write(join(office, "office.yaml"), `name: t\npackages:\n  - name: demo\n    repo: ${repo}\n    path: pkgs/demo\n    ref: ${git(["rev-parse", "HEAD"], repo)}\n    settings: { url: https://example.com }\n`);
  git(["init", "--quiet", office]);
  await sync(loadOffice(office));
  write(join(office, ".office/packages/demo/package.yaml"), `${manifest}# edited\n`);
  write(join(office, "packages/own/package.yaml"), "name: own\ndescription: Written here.\n");
  write(join(office, "office.yaml"), "name: t\n");

  expect(await sync(loadOffice(office))).toEqual(["removed .office/packages/demo/, which office.yaml no longer lists"]);
  expect(existsSync(join(office, "packages/own/package.yaml"))).toBe(true);
});

test("an entry without repo is built-in when shipped and local otherwise; the required office package appears only once and a built-in can't come from another repository", () => {
  const office = join(dir, "office");

  write(
    join(office, "office.yaml"),
    [
      "name: t",
      "packages:",
      "  - name: knowledge",
      "  - name: mine",
      "  - name: office",
      "  - name: shared",
      "    repo: https://example.com/shared.git",
      "    path: packages/shared",
      "    ref: main",
      "  - name: artifact-share",
      "    repo: https://example.com/fork.git",
      "    path: packages/artifact-share",
      "    ref: main",
      "",
    ].join("\n"),
  );

  const { packages, problems } = resolvePackages(loadOffice(office));

  expect(packages.map((item) => [item.entry.name, item.kind, item.dir.slice(office.length + 1)])).toEqual([
    ["office", "built-in", ".office/packages/office"],
    ["knowledge", "built-in", ".office/packages/knowledge"],
    ["mine", "local", "packages/mine"],
    ["shared", "remote", ".office/packages/shared"],
  ]);
  expect(problems.map((problem) => problem.packages)).toEqual([["artifact-share"]]);
});

test("sync installs the built-in packages from the tool and restores an edited copy, keeping the office's records", async () => {
  const office = join(dir, "office");
  const skill = join(office, ".office/packages/office/skills/office/SKILL.md");

  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: knowledge\n");

  const installed = await sync(loadOffice(office));

  expect(installed).toContain("installed .office/packages/office, the built-in office package");
  expect(installed).toContain("installed .office/packages/knowledge, the built-in knowledge package");
  expect(installed).toContain("linked .opencode/plugins/office");
  expect(readlinkSync(join(office, ".opencode/plugins/office"))).toBe("../../.office/packages/office/plugin");
  expect(existsSync(join(office, ".office/packages/office/plugin/index.js"))).toBe(true);

  const original = readFileSync(skill, "utf8");
  const template = readFileSync(join(office, ".office/packages/knowledge/.template.json"), "utf8");

  write(skill, "edited\n");
  rmSync(join(office, ".office/packages/knowledge/README.md"));

  const restored = await sync(loadOffice(office));

  expect(restored).toHaveLength(2);
  expect(restored[0]).toStartWith("restored .office/packages/office, undoing edits to skills/office/SKILL.md (edited);");
  expect(restored[1]).toStartWith("restored .office/packages/knowledge, undoing edits to README.md (removed);");
  expect(readFileSync(skill, "utf8")).toBe(original);
  expect(readFileSync(join(office, ".office/packages/knowledge/.template.json"), "utf8")).toBe(template);
  expect(await sync(loadOffice(office))).toEqual([]);
});
