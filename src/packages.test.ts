import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { sync } from "./commands/sync.ts";
import { git } from "./git.ts";
import { loadOffice } from "./office.ts";
import { settingsEnv } from "./package-services.ts";
import { fetchPackage, installPackage, readPackage, resolvePackages } from "./packages.ts";
import { readLockSection } from "./versions.ts";

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

/** The seed receipts in the office at `office`, as an object. */
function receipts(office: string) {
  return Object.fromEntries(readLockSection(office, "seeds"));
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

test("an install ignores the source office's records, an update by full commit SHA replaces the package, an edited copy is restored, and template copies are left alone", async () => {
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

  const source = { repo, path: "pkgs/demo", ref: first, track: undefined };
  expect(await fetchPackage(loaded, loaded.packages[0], source)).toEqual([`installed .office/packages/demo from ${repo} at ${first}`]);

  const installed = read(office, "demo").result;

  if (!installed.ok) throw new Error(installed.errors.join("\n"));

  expect(installPackage(loaded, installed.value)).toEqual(["wrote .office/packages/demo/.settings.json", "wrote .office/packages/demo/.office.json (opencode: container)", "created out/AGENTS.md from package demo"]);
  write(join(office, "out/AGENTS.md"), "the office's own\n");
  write(script, "echo edited\n");

  const [restored] = await fetchPackage(loaded, loaded.packages[0], source);

  expect(restored).toStartWith(`restored .office/packages/demo to its copy of ${first}, undoing edits to scripts/run.sh (edited);`);
  expect(readFileSync(script, "utf8")).toBe("echo one\n");

  write(join(office, "office.yaml"), entry(second));
  expect(await fetchPackage(loadOffice(office), loaded.packages[0], { ...source, ref: second })).toEqual([`updated .office/packages/demo from ${repo} pkgs/demo at ${first.slice(0, 12)} (ref ${first}) to ${second} (${second})`]);
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

  expect(changes).toContain("cloned plugin .office/plugins/demo");
  expect(changes).toContain("FAILED package demo: its plugin would be .opencode/plugins/demo, where the plugins: entry demo is cloned, so it isn't linked; rename one of them");
  expect(changes).toContain("unlinked .opencode/plugins/demo for the plugins: entry of that name; restart OpenCode to pick up demo: a running server keeps loading a plugin from where it first found it");
  expect(readlinkSync(link)).toBe("../../.office/plugins/demo");
  expect(git(["rev-parse", "--show-toplevel"], link)).toBe(realpathSync(join(office, ".office/plugins/demo")));

  rmSync(link, { recursive: true });
  write(join(office, "office.yaml"), declared);
  await sync(loadOffice(office));
  write(join(office, "office.yaml"), "name: t\n");

  expect(await sync(loadOffice(office))).toContain("unlinked .opencode/plugins/demo");
  expect(existsSync(link)).toBe(false);
});

test("a seed file is copied once: one the office deletes stays deleted, one already there is kept, and one the package adds later is created", () => {
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
  expect(receipts(office)).toEqual({ "notes/AGENTS.md": { package: "demo", existing: true }, "notes/README.md": { package: "demo", sha256: createHash("sha256").update("from the package\n").digest("hex") } });
  expect(existsSync(join(office, "packages/demo/.template.json"))).toBe(false);

  // The receipts are in office.lock, so a clone without .office/ doesn't copy the deleted files again.
  rmSync(join(office, "notes"), { recursive: true });
  rmSync(join(office, ".office"), { recursive: true, force: true });
  write(join(office, "packages/demo/template/notes/later.md"), "added by a later version\n");

  expect(install()).toEqual(["created notes/later.md from package demo"]);
  expect(existsSync(join(office, "notes/README.md"))).toBe(false);
  expect(existsSync(join(office, "notes/AGENTS.md"))).toBe(false);
  expect(install()).toEqual([]);
});

test("sync removes a copied package whose entry is gone with the seed files it still holds, and leaves changed files and the office's own beside them", async () => {
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
    "office.lock: removed demo",
  ]);
  expect(existsSync(join(office, ".office/packages/demo"))).toBe(false);
  expect(existsSync(join(office, ".github/workflows"))).toBe(false);
  expect(readFileSync(join(office, ".github/dependabot.yml"), "utf8")).toBe("version: 2\n");
  expect(readFileSync(join(office, "out/README.md"), "utf8")).toBe("the office changed this\n");
  expect(readFileSync(join(office, "out/my-page/index.md"), "utf8")).toBe("the office's own\n");
  expect(await sync(loadOffice(office))).toEqual([]);
});

test("a seed path the seeds: section couldn't hold is refused before copying, and the other files go ahead; an unreadable lock refuses before any copy", () => {
  const office = join(dir, "office");

  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: demo\n");
  write(join(office, "packages/demo/package.yaml"), "name: demo\ndescription: A demo package.\n");
  write(join(office, "packages/demo/template/back\\slash.md"), "odd\n");
  write(join(office, "packages/demo/template/plain.md"), "plain\n");

  const install = () => {
    const { loaded, result } = read(office, "demo");

    if (!result.ok) throw new Error(result.errors.join("\n"));

    return installPackage(loaded, result.value).filter((line) => !line.startsWith("wrote"));
  };

  // Runtime pins that can't be read: the receipts couldn't be saved, so nothing is copied.
  write(join(office, "office.lock"), "mise: [not, a, pin]\n");
  expect(install()).toEqual(["FAILED package demo's template/back\\slash.md: not a plain office-relative path", expect.stringMatching(/^FAILED package demo's seed files: office\.lock is not valid/)]);
  expect(existsSync(join(office, "plain.md"))).toBe(false);

  rmSync(join(office, "office.lock"));
  expect(install()).toEqual(["FAILED package demo's template/back\\slash.md: not a plain office-relative path", "created plain.md from package demo"]);
  expect(existsSync(join(office, "back\\slash.md"))).toBe(false);
  expect(Object.keys(receipts(office))).toEqual(["plain.md"]);
});

test("on a fresh clone a pulled-in package doesn't copy a deleted seed file again, and once deselected its receipts settle without its copy", async () => {
  const repo = join(dir, "repo");
  const office = join(dir, "office");
  const clone = () => rmSync(join(office, ".office"), { recursive: true, force: true });

  write(join(repo, "pkgs/demo/package.yaml"), manifest);
  write(join(repo, "pkgs/demo/template/out/deleted.md"), "from the package\n");
  write(join(repo, "pkgs/demo/template/out/kept.md"), "from the package\n");
  write(join(repo, "pkgs/demo/template/out/edited.md"), "from the package\n");
  write(join(repo, "pkgs/demo/template/mine.md"), "from the package\n");
  git(["init", "--quiet", repo]);
  git(["add", "-A"], repo);
  git(["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "--quiet", "-m", "one"], repo);

  write(join(office, "mine.md"), "the office's own\n");
  write(join(office, "office.yaml"), `name: t\npackages:\n  - name: demo\n    repo: ${repo}\n    path: pkgs/demo\n    ref: ${git(["rev-parse", "HEAD"], repo)}\n    settings: { url: https://example.com }\n`);
  git(["init", "--quiet", office]);
  await sync(loadOffice(office));
  rmSync(join(office, "out/deleted.md"));
  write(join(office, "out/edited.md"), "the office changed this\n");

  clone();
  expect((await sync(loadOffice(office))).filter((line) => line.includes(".md"))).toEqual([]);
  expect(existsSync(join(office, "out/deleted.md"))).toBe(false);

  // Removed from office.yaml before the package was installed on another clone.
  clone();
  write(join(office, "office.yaml"), "name: t\n");
  expect((await sync(loadOffice(office))).filter((line) => line.includes(".md") || line.includes("demo"))).toEqual([
    "kept out/edited.md, which changed since package demo wrote it",
    "deleted out/kept.md, which package demo created",
    "office.lock: removed demo",
  ]);
  expect(readFileSync(join(office, "mine.md"), "utf8")).toBe("the office's own\n");
  expect(readdirSync(join(office, "out"))).toEqual(["edited.md"]);
  expect(receipts(office)).toEqual({});
});

test("an office from an earlier release keeps its seed files, each recorded as already there, and its .template.json as it is", () => {
  const office = join(dir, "office");
  const record = '["notes/AGENTS.md"]\n';

  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: demo\n");
  write(join(office, "packages/demo/package.yaml"), "name: demo\ndescription: A demo package.\n");
  write(join(office, "packages/demo/template/notes/AGENTS.md"), "from the package\n");
  write(join(office, "packages/demo/.template.json"), record);
  write(join(office, "notes/AGENTS.md"), "from the package\n");

  const { loaded, result } = read(office, "demo");

  if (!result.ok) throw new Error(result.errors.join("\n"));

  expect(installPackage(loaded, result.value).filter((line) => !line.startsWith("wrote"))).toEqual(["kept notes/AGENTS.md, which was already there, instead of package demo's copy"]);
  expect(receipts(office)).toEqual({ "notes/AGENTS.md": { package: "demo", existing: true } });
  expect(readFileSync(join(office, "notes/AGENTS.md"), "utf8")).toBe("from the package\n");
  expect(readFileSync(join(office, "packages/demo/.template.json"), "utf8")).toBe(record);
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

  write(join(repo, "pkgs/demo/package.yaml"), manifest);
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
  const installed = [readFileSync(record, "utf8"), readFileSync(join(office, ".office/packages/demo/.settings.json"), "utf8")];

  write(join(repo, "pkgs/demo/office.ts"), "export default { name: 'demo', description: 'Both' }");
  const broken = commit();

  write(join(office, "office.yaml"), yaml(broken));
  expect((await sync(loadOffice(office), { scope: "packages" })).join("\n")).toContain("has both office.ts and package.yaml");
  expect([readFileSync(record, "utf8"), readFileSync(join(office, ".office/packages/demo/.settings.json"), "utf8")]).toEqual(installed);
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

  expect(await sync(loadOffice(office))).toEqual(["removed .office/packages/demo/, which office.yaml no longer lists", "office.lock: removed demo"]);
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
      "",
    ].join("\n"),
  );

  const { packages, problems } = resolvePackages(loadOffice(office));

  expect(packages.map((item) => [item.entry.name, item.kind, item.dir.slice(office.length + 1)])).toEqual([
    ["tooling", "built-in", ".office/packages/tooling"],
    ["mise-integration", "built-in", ".office/packages/mise-integration"],
    ["office", "built-in", ".office/packages/office"],
    ["references", "built-in", ".office/packages/references"],
    ["knowledge", "built-in", ".office/packages/knowledge"],
    ["mine", "local", "packages/mine"],
    ["shared", "remote", ".office/packages/shared"],
  ]);
  expect(problems).toEqual([]);
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
  const received = receipts(office);

  expect(Object.values(received).some((receipt) => receipt.package === "knowledge" && "sha256" in receipt)).toBe(true);

  write(skill, "edited\n");
  rmSync(join(office, ".office/packages/knowledge/README.md"));

  const restored = await sync(loadOffice(office));

  expect(restored).toHaveLength(2);
  expect(restored[0]).toStartWith("restored .office/packages/office, undoing edits to skills/office/SKILL.md (edited);");
  expect(restored[1]).toStartWith("restored .office/packages/knowledge, undoing edits to README.md (removed);");
  expect(readFileSync(skill, "utf8")).toBe(original);
  expect(receipts(office)).toEqual(received);
  expect(await sync(loadOffice(office))).toEqual([]);
});

test("the required office package ignores the Claude app's synced skills unless turned off, and takes more folders as a list", async () => {
  const office = join(dir, "office");
  const settings = join(office, ".office/packages/office/.settings.json");

  write(join(office, "office.yaml"), "name: t\n");
  await sync(loadOffice(office));

  expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ ignore_claude_synced_skills: true, ignore_skill_folders: [] });

  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: office\n    settings:\n      ignore_claude_synced_skills: false\n      ignore_skill_folders:\n        - ~/other/skills\n");

  expect(await sync(loadOffice(office))).toEqual(["wrote .office/packages/office/.settings.json"]);
  expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({ ignore_claude_synced_skills: false, ignore_skill_folders: ["~/other/skills"] });

  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: office\n    settings:\n      ignore_skill_folders: ~/.claude/skills/synced\n");
  expect(read(office, "office").result).toEqual({ ok: false, errors: ["office.settings/ignore_skill_folders: must be array"] });

  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: office\n    settings:\n      ignored: []\n");
  expect(read(office, "office").result).toEqual({ ok: false, errors: ["office.settings: must NOT have additional properties: ignored"] });

  write(join(office, "office.yaml"), "name: t\npackages:\n  - name: office\n    repo: https://example.com/fork.git\n    path: packages/office\n    ref: main\n");
  expect(() => loadOffice(office)).toThrow("the required office package is built in: its entry can only configure settings and cron");
});

test("a skill a built-in package renamed leaves the office's copy on the next sync", async () => {
  const office = join(dir, "office");
  const skills = join(office, ".office/packages/office/skills");

  write(join(office, "office.yaml"), "name: t\n");
  await sync(loadOffice(office));

  // What an earlier executable's copy held.
  write(join(skills, "skill-creator/SKILL.md"), readFileSync(join(skills, "openai-skill-creator/SKILL.md"), "utf8"));

  await sync(loadOffice(office));

  expect(existsSync(join(skills, "skill-creator"))).toBe(false);
  expect(readFileSync(join(skills, "openai-skill-creator/SKILL.md"), "utf8")).toContain("\nname: openai-skill-creator\n");
  expect(existsSync(join(skills, "openai-skill-creator/NOTICE"))).toBe(true);
  expect(existsSync(join(skills, "openai-skill-creator/license.txt"))).toBe(true);
});
